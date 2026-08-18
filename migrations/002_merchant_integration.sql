-- Giai đoạn 6 — ghép cổng thanh toán này với dự án bán hàng bên ngoài.
--
-- Ba thứ được thêm vào, và chỉ ba thứ:
--   1. `external_order_id`  — mã đơn bên shop, để đối chiếu hai chiều
--   2. `return_url`         — nơi đẩy khách quay về sau khi trả xong
--   3. `payment_webhook_deliveries` — hộp thư đi (outbox) báo ngược về shop
--
-- Vì sao là outbox chứ không gọi webhook thẳng trong lúc đổi trạng thái: lời gọi HTTP
-- có thể thất bại, mà transaction đổi trạng thái thì ĐÃ commit. Ghi sự kiện vào cùng
-- một transaction với việc đổi trạng thái là cách duy nhất để "đơn đã confirmed" và
-- "shop sẽ được báo" không bao giờ lệch nhau.

/* ------------------------------------------------------------------ */
/* Đơn hàng — thêm móc nối sang shop                                   */
/* ------------------------------------------------------------------ */

ALTER TABLE payment_orders
  -- Mã đơn phía shop. Chuỗi tự do vì mỗi hệ đánh mã một kiểu (uuid, số tăng dần,
  -- "DH-2026-0042"…), chỉ chặn độ dài và ký tự điều khiển ở tầng ứng dụng.
  ADD COLUMN IF NOT EXISTS external_order_id text
    CHECK (external_order_id IS NULL OR length(external_order_id) BETWEEN 1 AND 128),

  -- URL đưa khách quay lại shop. Được đối chiếu với allowlist origin LÚC TẠO ĐƠN rồi
  -- mới lưu — sau đó không kiểm lại nữa, nên giá trị trong cột này luôn là đã duyệt.
  ADD COLUMN IF NOT EXISTS return_url text
    CHECK (return_url IS NULL OR return_url ~ '^https?://'),

  -- Số lần đã báo thành công về shop. Chỉ để đọc nhanh trên dashboard; nguồn sự thật
  -- vẫn là bảng deliveries bên dưới.
  ADD COLUMN IF NOT EXISTS webhooks_delivered integer NOT NULL DEFAULT 0;

-- MỘT mã đơn shop ↔ MỘT đơn thanh toán, xét trong cùng một mạng.
--
-- Đây vừa là ràng buộc đối soát, vừa là cơ chế idempotency: shop gọi lại API tạo đơn
-- với cùng externalOrderId (bấm hai lần, retry sau timeout, webhook nội bộ chạy lại)
-- sẽ đụng UNIQUE này, và tầng ứng dụng trả về đúng đơn cũ thay vì tạo đơn thứ hai.
--
-- Chia theo network để đơn thử trên preprod không chặn mất đơn thật cùng mã trên mainnet.
CREATE UNIQUE INDEX IF NOT EXISTS payment_orders_external_idx
  ON payment_orders (network, external_order_id)
  WHERE external_order_id IS NOT NULL;

/* ------------------------------------------------------------------ */
/* Hộp thư đi — webhook báo ngược về shop                              */
/* ------------------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS payment_webhook_deliveries (
  id              bigserial   PRIMARY KEY,
  order_id        uuid        NOT NULL REFERENCES payment_orders (id) ON DELETE CASCADE,

  -- "order.confirmed", "order.underpaid", "order.expired"…
  event           text        NOT NULL,

  -- URL đích được SNAPSHOT lúc xếp hàng, không đọc lại từ env lúc gửi. Đổi
  -- MERCHANT_WEBHOOK_URL giữa chừng không được phép làm các sự kiện đang chờ bay đi
  -- một nơi khác — và khi đối soát, phải trả lời được "cái này đã gửi đi ĐÂU".
  target_url      text        NOT NULL,

  -- Toàn bộ thân request đã ký, lưu nguyên văn. Chữ ký HMAC tính trên chuỗi byte
  -- chính xác này; sinh lại payload lúc retry là chữ ký sẽ không khớp nữa (thứ tự
  -- khoá JSON, số lần xác nhận đã tăng…).
  payload         jsonb       NOT NULL,

  status          text        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts        integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),

  -- Lần thử kế tiếp. Backoff luỹ thừa ghi thẳng vào đây thay vì giữ trong RAM: tiến
  -- trình khởi động lại thì lịch retry vẫn còn nguyên.
  next_attempt_at timestamptz NOT NULL DEFAULT now(),

  response_status integer,
  last_error      text,

  created_at      timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz,

  -- Mỗi (đơn, sự kiện) chỉ xếp hàng một lần. Watcher quét lặp lại nhiều lượt và có
  -- thể thấy cùng một chuyển trạng thái hai lần; ràng buộc này khiến shop không bao
  -- giờ nhận hai lần "đã thanh toán" cho cùng một đơn.
  CONSTRAINT payment_webhook_deliveries_unique UNIQUE (order_id, event)
);

-- Đường nóng của bộ gửi: lấy các sự kiện tới hạn, cũ nhất trước.
CREATE INDEX IF NOT EXISTS payment_webhook_deliveries_due_idx
  ON payment_webhook_deliveries (next_attempt_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS payment_webhook_deliveries_order_idx
  ON payment_webhook_deliveries (order_id, created_at DESC);
