-- Giai đoạn 7 — faucet phát stablecoin thử cho người test.
--
-- CHỈ TESTNET, và hiện tại chỉ Preprod. Có hai lớp chặn, cố ý trùng nhau:
--   1. CHECK ở đây — không dòng mainnet nào ghi được vào bảng, kể cả khi tầng ứng
--      dụng có lỗi.
--   2. `FAUCET_NETWORK` chốt cứng trong src/lib/faucet.ts.
-- Một faucet trên mainnet là phát tiền thật cho người lạ; nó không được phép tồn tại
-- ở trạng thái "chỉ cần đổi một biến môi trường là bật".
--
-- Bảng này KHÔNG phải log cho vui: nó là nơi duy nhất áp được cooldown theo địa chỉ.
-- Không có nó thì faucet chỉ còn hạn mức theo IP, mà IP thì đổi trong ba giây.

CREATE TABLE IF NOT EXISTS faucet_claims (
  id          bigserial   PRIMARY KEY,

  network     text        NOT NULL CHECK (network IN ('preprod', 'preview')),

  -- Địa chỉ nhận. Không ràng buộc bech32 đầy đủ ở DB (checksum không kiểm được bằng
  -- CHECK), chỉ chặn hình dạng; kiểm kỹ nằm ở tầng ứng dụng.
  address     text        NOT NULL CHECK (address ~ '^addr_test1[0-9a-z]{20,}$'),

  -- Khoá định danh người gọi lúc xin (IP, hoặc "untrusted:…" khi chưa khai
  -- TRUSTED_PROXY_HOPS). Để đối soát khi thấy faucet cạn bất thường.
  client_key  text,

  status      text        NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'sent', 'failed')),

  -- Đã phát những gì: [{unit, symbol, quantity, mode}]. quantity là CHUỖI số nguyên
  -- ở đơn vị nhỏ nhất — cùng quy ước với mọi số tiền trong dự án này.
  assets      jsonb       NOT NULL DEFAULT '[]'::jsonb,

  -- Lovelace kèm theo. Token không tự đứng một mình trong output được: Cardano bắt
  -- mỗi output phải có min-ADA.
  lovelace    bigint      NOT NULL DEFAULT 0 CHECK (lovelace >= 0),

  tx_hash     text        UNIQUE CHECK (tx_hash IS NULL OR tx_hash ~ '^[0-9a-f]{64}$'),
  error       text,

  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);

-- Đường nóng của cooldown: "địa chỉ này xin lần cuối lúc nào".
CREATE INDEX IF NOT EXISTS faucet_claims_cooldown_idx
  ON faucet_claims (network, address, created_at DESC)
  WHERE status <> 'failed';

CREATE INDEX IF NOT EXISTS faucet_claims_client_idx
  ON faucet_claims (client_key, created_at DESC);

CREATE INDEX IF NOT EXISTS faucet_claims_created_idx
  ON faucet_claims (created_at DESC);
