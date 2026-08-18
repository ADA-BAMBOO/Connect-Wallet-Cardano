-- Giai đoạn 1 — schema cho thanh toán stablecoin/ADA.
--
-- Ghi chú về kiểu dữ liệu: MỌI số tiền đều là `bigint` ở đơn vị nhỏ nhất
-- (micro-USD, lovelace, 10^-decimals của token). Không dùng numeric/float cho tiền:
-- numeric thì driver trả về chuỗi rồi dễ bị Number() ở đâu đó, float thì sai sẵn.
-- pg trả int8 về dạng chuỗi — đọc bằng `toBigInt()` trong src/lib/money.ts.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS payment_orders (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Mã ngắn ASCII nhúng vào metadata CIP-20 (label 674) của giao dịch: "pay:<ref>".
  -- Giữ ngắn và ASCII vì ví cứng hiển thị được, và để sau này nhét vừa datum nếu
  -- chuyển sang native script.
  ref               text        NOT NULL UNIQUE CHECK (ref ~ '^[0-9A-HJ-NP-Za-km-z]{6,32}$'),

  -- Mạng chốt cứng lúc tạo đơn. Đơn không bao giờ nhảy mạng, kể cả khi env đổi.
  network           text        NOT NULL CHECK (network IN ('mainnet', 'preprod', 'preview')),

  -- 'direct' = trả thẳng vào địa chỉ merchant. Cột này có sẵn từ đầu để sau thêm
  -- 'escrow' (native script) không phải migrate bảng đang giữ tiền thật.
  payment_mode      text        NOT NULL DEFAULT 'direct'
                                CHECK (payment_mode IN ('direct', 'escrow')),

  status            text        NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'seen', 'confirmed',
                                                  'underpaid', 'expired', 'failed')),

  -- Giá gốc của đơn, luôn tính bằng USD ở đơn vị 10^-6.
  amount_usd        bigint      NOT NULL CHECK (amount_usd > 0),
  description       text,

  -- SNAPSHOT tại thời điểm tạo đơn, KHÔNG đọc lại từ env khi xác minh.
  -- Đổi MERCHANT_ADDRESS_* sau này không được phép làm sai kết luận của đơn cũ.
  merchant_address  text        NOT NULL,

  -- Địa chỉ người trả: điền khi họ chọn token, hoặc khi watcher quét ra.
  -- Cần cho việc hoàn tiền và đối soát — tra ngược chain về sau vừa chậm vừa dễ sai.
  buyer_address     text,

  -- Token dùng để trả. 'lovelace' = ADA (đúng quy ước CIP-30/Mesh),
  -- ngược lại là policyId + assetNameHex.
  pay_unit          text        CHECK (pay_unit IS NULL
                                       OR pay_unit = 'lovelace'
                                       OR pay_unit ~ '^[0-9a-f]{56,}$'),
  pay_symbol        text,
  pay_decimals      smallint    CHECK (pay_decimals IS NULL
                                       OR (pay_decimals >= 0 AND pay_decimals <= 18)),
  pay_quantity      bigint      CHECK (pay_quantity IS NULL OR pay_quantity > 0),

  -- Tỷ giá đã khoá: micro-USD cho 1 ADA. Chỉ có khi trả bằng ADA.
  ada_rate          bigint      CHECK (ada_rate IS NULL OR ada_rate > 0),
  rate_sources      text[],
  quote_expires_at  timestamptz,

  -- Kết quả đối chiếu on-chain.
  -- UNIQUE trên tx_hash là chốt chặn cuối chống double-credit: một giao dịch không
  -- bao giờ thanh toán được cho hai đơn, kể cả khi logic ứng dụng có lỗ hổng.
  -- (Postgres cho phép nhiều NULL trên cột UNIQUE nên đơn chưa trả không vướng.)
  tx_hash           text        UNIQUE CHECK (tx_hash IS NULL OR tx_hash ~ '^[0-9a-f]{64}$'),
  tx_block_height   bigint,
  tx_metadata_ok    boolean,
  received_quantity bigint,
  confirmations     integer     NOT NULL DEFAULT 0 CHECK (confirmations >= 0),

  -- Lưu sẵn inline datum quét được. Chưa dùng ở 'direct', nhưng dữ liệu đã nằm
  -- trong response Blockfrost — bỏ đi thì sau phải quét lại cả chain.
  inline_datum      text,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- Hạn của cả đơn (hoá đơn/QR sống được bao lâu). Khác quote_expires_at, vốn chỉ
  -- là hạn của tỷ giá ADA đã khoá.
  expires_at        timestamptz NOT NULL,
  confirmed_at      timestamptz,

  -- Đã chọn token thì phải có đủ bộ số lượng + decimals, không được nửa vời.
  CONSTRAINT payment_orders_quote_complete CHECK (
    pay_unit IS NULL
    OR (pay_quantity IS NOT NULL AND pay_decimals IS NOT NULL)
  ),
  -- Tỷ giá ADA chỉ có nghĩa khi thực sự trả bằng ADA.
  CONSTRAINT payment_orders_ada_rate_scope CHECK (
    ada_rate IS NULL OR pay_unit = 'lovelace'
  )
);

-- Watcher quét theo (network, status) — index này là đường nóng của vòng lặp poll.
CREATE INDEX IF NOT EXISTS payment_orders_watch_idx
  ON payment_orders (network, status, created_at DESC);

CREATE INDEX IF NOT EXISTS payment_orders_expiry_idx
  ON payment_orders (expires_at)
  WHERE status IN ('pending', 'seen');

CREATE INDEX IF NOT EXISTS payment_orders_created_idx
  ON payment_orders (created_at DESC);

/* ------------------------------------------------------------------ */
/* Nhật ký chuyển trạng thái (append-only)                             */
/* ------------------------------------------------------------------ */
-- Lịch sử không tái tạo được: khi cần trả lời "vì sao đơn này bị đánh dấu đã trả",
-- bảng orders chỉ cho biết trạng thái CUỐI. Ghi từ đầu thì gần như miễn phí,
-- thêm sau thì mất trắng phần đã xảy ra.

CREATE TABLE IF NOT EXISTS payment_order_events (
  id          bigserial   PRIMARY KEY,
  order_id    uuid        NOT NULL REFERENCES payment_orders (id) ON DELETE CASCADE,
  at          timestamptz NOT NULL DEFAULT now(),
  from_status text,
  to_status   text        NOT NULL,
  -- Bằng chứng kèm theo: txHash, số lượng nhận được, nguồn giá, lỗi Blockfrost…
  detail      jsonb       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS payment_order_events_order_idx
  ON payment_order_events (order_id, at);

/* ------------------------------------------------------------------ */
/* updated_at tự động                                                  */
/* ------------------------------------------------------------------ */

CREATE OR REPLACE FUNCTION payment_orders_touch_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS payment_orders_touch ON payment_orders;
CREATE TRIGGER payment_orders_touch
  BEFORE UPDATE ON payment_orders
  FOR EACH ROW EXECUTE FUNCTION payment_orders_touch_updated_at();
