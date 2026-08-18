# Tích hợp với dự án bán hàng

Tài liệu này dành cho người ghép **dự án sản phẩm** (shop) với **cổng thanh toán** này.

Mô hình: hai service riêng, hai domain, hai database. Shop gọi API tạo đơn, redirect
khách sang trang thanh toán, rồi nhận webhook đã ký khi tiền về.

```
  shop.com (Next.js sản phẩm)              pay.shop.com (repo này)
  ────────────────────────────             ────────────────────────────
       │
       │ ① POST /api/v1/orders ───────────────────►  tạo đơn, snapshot địa chỉ
       │    Bearer <MERCHANT_API_KEYS>              nhận tiền từ env
       │ ◄──────────────── { payUrl, order } ─────
       │
       │ ② redirect khách ────────────────────────►  /pay/<ref>
       │                                             chọn ví → chọn token
       │                                             ký → phát giao dịch
       │                                                    │
       │                                             ③ watcher đối chiếu on-chain
       │                                                (poll mỗi 10–30s)
       │                                                    │
       │ ◄──── ④ POST webhook đã ký HMAC ──────────  status = confirmed
       │        { event, occurredAt, data }
       │        → giao hàng
       │
       │ ◄──── ⑤ khách quay về returnUrl ──────────
```

Vì sao tiền được xác nhận bằng **poll** chứ không phải webhook từ chain: giao dịch
Cardano mất 20–60 giây để vào block rồi còn chờ đủ số xác nhận. Trong khung thời gian
đó, poll mỗi 10 giây chậm hơn webhook một cách không ai cảm nhận được — mà lại tự quét
bù được sau khi server sập.

---

## 1. Cấu hình cổng thanh toán

Thêm vào `.env.local` của repo này (giải thích đầy đủ nằm trong [`.env.example`](../.env.example)):

```bash
# Khoá shop dùng để gọi sang. Nhiều khoá = xoay khoá không phải ngừng dịch vụ.
MERCHANT_API_KEYS=<hex 64 ký tự>

# Địa chỉ công khai của chính cổng thanh toán — dùng để dựng payUrl.
PAYMENT_PUBLIC_URL=https://pay.shop.com

# Nơi báo ngược khi trạng thái đơn đổi.
MERCHANT_WEBHOOK_URL=https://shop.com/api/webhooks/cardano-pay
MERCHANT_WEBHOOK_SECRET=<hex 64 ký tự>

# Origin được phép xuất hiện trong returnUrl.
MERCHANT_RETURN_URL_ORIGINS=https://shop.com
```

Sinh khoá:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Rồi chạy migration và kiểm chứng:

```bash
npm run migrate
npm run verify:integration            # logic thuần, không cần server
npm run verify:integration -- --http  # thêm các bài qua HTTP
```

## 2. Cấu hình shop

```bash
CARDANO_PAY_URL=https://pay.shop.com
CARDANO_PAY_API_KEY=<đúng một khoá trong MERCHANT_API_KEYS>
CARDANO_PAY_WEBHOOK_SECRET=<đúng MERCHANT_WEBHOOK_SECRET>
CARDANO_PAY_NETWORK=preprod
```

Copy hai file vào repo shop:

| File nguồn | Đặt ở shop | Vai trò |
|---|---|---|
| [`integration/cardano-pay-client.ts`](../integration/cardano-pay-client.ts) | `src/lib/cardano-pay-client.ts` | Client + hàm xác minh webhook. Không phụ thuộc package nào. |
| [`integration/example-webhook-route.ts`](../integration/example-webhook-route.ts) | `src/app/api/webhooks/cardano-pay/route.ts` | Endpoint nhận webhook |
| [`integration/example-checkout.ts`](../integration/example-checkout.ts) | tham khảo | Luồng checkout + trang cảm ơn |

> **`cardano-pay-client.ts` là bản sao có chủ đích** của thuật toán ký trong
> [`src/lib/webhook-signature.ts`](../src/lib/webhook-signature.ts). Hai file deploy ở
> hai repo nên phải nhân đôi — nhưng `npm run verify:integration` import cả hai và bắt
> chúng đối chiếu với nhau, nên lệch nhau sẽ bị bắt ngay tại chỗ thay vì lộ ra dưới
> dạng webhook 401 hàng loạt ở production.

---

## 3. API

Mọi endpoint `/api/v1/*` đều cần header `authorization: Bearer <khoá>` (hoặc `x-api-key`).

### `POST /api/v1/orders` — tạo đơn

```jsonc
// Request
{
  "network":         "preprod",              // bắt buộc
  "amountUsd":       "42.00",                // bắt buộc, chuỗi thập phân ≤ 6 số lẻ
  "externalOrderId": "DH-2026-0042",         // nên luôn có — xem Idempotency
  "description":     "Gói Pro 1 năm",        // tuỳ chọn, hiện trên trang thanh toán
  "returnUrl":       "https://shop.com/don-hang/DH-2026-0042"  // tuỳ chọn
}

// 201 Created (hoặc 200 OK khi reused = true)
{
  "order":  { "ref": "aB3xY9kM", "status": "pending", "amountUsd": "42.00", ... },
  "payUrl": "https://pay.shop.com/pay/aB3xY9kM",
  "reused": false
}
```

| Mã | Nghĩa |
|---|---|
| `201` | Đã tạo đơn mới |
| `200` | Đơn đã tồn tại với `externalOrderId` này — `reused: true` |
| `400` | Sai tham số, hoặc `returnUrl` ngoài allowlist |
| `401` / `403` | Thiếu khoá / khoá sai |
| `409` | Mạng chưa bật, **hoặc** cùng `externalOrderId` nhưng khác số tiền |
| `503` | Chưa cấu hình `MERCHANT_API_KEYS` (ở production) |

**Địa chỉ nhận tiền không nằm trong request và không bao giờ được phép nằm ở đó.** Nó
chỉ đến từ `MERCHANT_ADDRESS_*` của cổng thanh toán, và được sao vào từng đơn lúc tạo.
Có khoá API cũng không khai được nơi tiền chảy về.

### `GET /api/v1/orders?network=…&externalOrderId=…` — tra ngược

Dùng khi shop mất `ref` (webhook chưa tới, transaction bên shop rollback).

### `GET /api/v1/orders/<ref>` — đọc trạng thái

Trả về `{ order, payUrl, deliveries }`. `deliveries` là nhật ký webhook — dùng để trả
lời "vì sao shop chưa nhận được thông báo" mà không phải mở database. Gần như luôn là
URL sai hoặc endpoint shop trả lỗi, và `lastError` nói thẳng điều đó.

### `POST /api/v1/orders/<ref>/replay` — gửi lại webhook

Xếp lại hàng đợi cho các sự kiện chưa gửi được. Dùng sau khi sửa `MERCHANT_WEBHOOK_URL`
hoặc sau khi shop sập lâu hơn thời gian retry. Sự kiện đã `delivered` thì **không** đụng
tới — gửi lại `order.confirmed` cho đơn đã xử lý là cách nhanh nhất để giao hàng hai lần.

---

## 4. Idempotency

`externalOrderId` là duy nhất theo `(network, externalOrderId)` ở tầng database. Gọi lại
API tạo đơn với cùng mã đơn trả về **đúng đơn cũ** kèm `reused: true`.

Nghĩa là shop **không cần tự chống trùng**. Cứ gọi thẳng mỗi lần khách bấm "Thanh toán":

- khách bấm hai lần → một đơn
- request trước timeout ở tầng mạng nhưng đã ghi xong → một đơn
- job nội bộ chạy lại → một đơn

Cùng mã đơn nhưng **khác số tiền** thì bị từ chối bằng `409`. Đó là lỗi thật ở phía
shop, không phải một lần thử lại — trả về đơn cũ sẽ khiến shop tưởng đã tạo đơn với số
tiền mới.

---

## 5. Webhook

### Sự kiện

| Sự kiện | Khi nào | Shop nên làm gì |
|---|---|---|
| `order.seen` | Giao dịch đã lên chain, **chưa đủ xác nhận** | Hiện "đang xác nhận…". **Tuyệt đối không giao hàng** — block chứa giao dịch này vẫn có thể bị thay thế. |
| `order.confirmed` | Đủ số xác nhận | **Giao hàng.** Đây là trạng thái duy nhất được phép. |
| `order.underpaid` | Tiền về nhưng thiếu, hoặc về sau khi tỷ giá hết hạn | Không tự giao, không tự huỷ. Tiền thật đang trong ví — cần người quyết định. |
| `order.expired` | Hết hạn, không ai trả | Nhả hàng đang giữ trong kho. |
| `order.failed` | Sự cố | Đưa vào diện xem lại. |

### Thân request

```jsonc
{
  "event": "order.confirmed",
  "occurredAt": "2026-08-18T09:12:33.412Z",
  "data": { /* toàn bộ đơn — xem PaymentOrder trong cardano-pay-client.ts */ }
}
```

Payload là **ảnh chụp tại thời điểm sự kiện xảy ra**, không phải trạng thái lúc gửi.
Một `order.seen` gửi lại sau ba tiếng vẫn mang dữ liệu của lúc đơn còn `seen`.

### Header

| Header | Nội dung |
|---|---|
| `x-cardano-pay-signature` | `t=<unix>,v1=<hmac-sha256 hex>` |
| `x-cardano-pay-event` | Tên sự kiện |
| `x-cardano-pay-delivery` | ID lần giao — dùng để lần lại trong log |
| `x-cardano-pay-attempt` | Lần thử thứ mấy |

### Xác minh — ba luật

**1. Đọc thân THÔ, đừng `request.json()`.**

Chữ ký tính trên đúng chuỗi byte đã gửi. `JSON.parse` rồi `stringify` lại sẽ đổi thứ tự
khoá, khoảng trắng và cách escape Unicode — chuỗi nhìn "tương đương" với mắt người nhưng
băm ra giá trị khác, và **mọi** webhook đều trượt.

```ts
const raw = await request.text();                       // ✓
const result = verifyWebhook(raw, request.headers.get(SIGNATURE_HEADER), secret);
```

**2. Xử lý idempotent.** Đảm bảo là *ít nhất một lần*: cùng một sự kiện có thể tới hai
lần nếu lần đầu trả lỗi sau khi bạn đã ghi database. Dùng UPDATE **có điều kiện** thay
vì đọc-rồi-ghi:

```sql
UPDATE orders SET status = 'paid', tx_hash = $2, paid_at = now()
 WHERE id = $1 AND status <> 'paid'
```

Chỉ giao hàng khi câu lệnh đó thực sự đổi được một dòng. Hai webhook tới cùng lúc đều
đọc thấy "chưa trả" rồi cả hai cùng giao — điều kiện trong `WHERE` thì database phân xử
giúp bạn.

**3. Trả 2xx nhanh.** Quá 10 giây bị tính là thất bại và sẽ được gửi lại. Việc nặng đẩy
sang hàng đợi nền.

Trả `5xx` khi xử lý hỏng — để được gửi lại. Nuốt lỗi rồi trả `200` là mất hẳn sự kiện đó.

### Thử lại

8 lần, backoff `10s → 30s → 2m → 5m → 15m → 1h → 3h → 6h` (~10 tiếng). Hết lượt thì ghi
`console.error` và dừng; dùng `/replay` để xếp lại sau khi đã sửa nguyên nhân.

### Đảm bảo không mất sự kiện

Sự kiện được ghi vào bảng `payment_webhook_deliveries` trong **cùng transaction** với
lệnh đổi trạng thái đơn. Hai chuyện "đơn đã confirmed" và "shop sẽ được báo" cùng commit
hoặc cùng rollback — không bao giờ chỉ có một.

Việc gửi đi thì có ba đường kích hoạt:

| Đường | Khi nào | Vai trò |
|---|---|---|
| Cron watcher | Mỗi lượt `POST /api/payments/watcher` | **Đường bảo đảm.** Luôn chạy. |
| Trang thanh toán poll | Khách đang mở `/pay/<ref>` | Đi tắt — shop biết tin trong ~1 giây |
| `/replay` | Thủ công | Khắc phục sự cố |

Chỉ cron là bảo đảm; hai đường kia có thể không xảy ra (khách đóng tab). **Không cắm
cron thì webhook thất bại lần đầu sẽ nằm lại mãi** — xem phần Triển khai trong README.

---

## 6. `returnUrl` — và vì sao đừng tin nó

Sau khi thanh toán xong, trang `/pay/<ref>` hiện nút *Quay lại cửa hàng* trỏ về:

```
https://shop.com/don-hang/DH-42?ref=aB3xY9kM&status=confirmed&orderId=DH-42
```

**Ba tham số này nằm trong thanh địa chỉ — ai cũng sửa được thành `status=confirmed`.**
Chúng chỉ dùng để biết *đi hỏi về đơn nào*, không bao giờ dùng để quyết định giao hàng.

Sự thật có hai nguồn, cả hai đều đi qua server: webhook đã ký, hoặc
`GET /api/v1/orders/<ref>`.

Trang không tự động chuyển hướng: bằng chứng thanh toán (txHash, số xác nhận) chỉ có ở
trang `/pay`, và giật khách đi khỏi nó ngay khi vừa xong là cách chắc chắn để họ mất
thứ duy nhất chứng minh mình đã trả tiền.

`returnUrl` được duyệt qua allowlist origin **một lần lúc tạo đơn**. Không có allowlist
thì nó thành open redirect có thương hiệu: kẻ tấn công tạo đơn 0,01 USD trỏ về trang
lừa đảo rồi phát tán link `/pay/<mã>` mang tên miền quen thuộc của bạn.

---

## 7. Chạy thử đầu-cuối trên preprod

```bash
# Cổng thanh toán
npm run db:up && npm run migrate
npm run dev                     # cổng 3000

# Shop chạy ở cổng khác, ví dụ 3001
# MERCHANT_RETURN_URL_ORIGINS=http://localhost:3001
# MERCHANT_WEBHOOK_URL=http://localhost:3001/api/webhooks/cardano-pay
```

1. Chuyển ví sang **Preprod**, xin ADA ở [faucet](https://docs.cardano.org/cardano-testnets/tools/faucet/).
2. `npm run mint:test-stablecoins` để có token thử, dán `STABLECOINS_PREPROD` vào `.env.local`.
3. Từ shop, tạo đơn → nhận `payUrl` → mở link → chọn token → ký.
4. Cắm watcher chạy liên tục để đơn được chốt và webhook được gửi:

```bash
while true; do curl -sX POST http://localhost:3000/api/payments/watcher > /dev/null; sleep 10; done
```

5. Kiểm tra nhật ký giao: `GET /api/v1/orders/<ref>` → mảng `deliveries`.

## 8. Trước khi bật mainnet

- [ ] `PAYMENT_PUBLIC_URL` trỏ đúng domain thật (bắt buộc ở production)
- [ ] `MERCHANT_API_KEYS`, `MERCHANT_WEBHOOK_SECRET` sinh mới, **khác** khoá đã dùng ở staging
- [ ] `MERCHANT_RETURN_URL_ORIGINS` chỉ chứa origin `https://` thật
- [ ] `MERCHANT_WEBHOOK_URL` dùng `https` (bắt buộc ở production)
- [ ] Endpoint webhook bên shop đã xác minh chữ ký và xử lý idempotent
- [ ] Cron watcher đã chạy và có giám sát — **không có nó thì không đơn nào được chốt**
- [ ] `PAYMENT_WATCHER_SECRET` đã đặt
- [ ] `TRUSTED_PROXY_HOPS` khai đúng số proxy đứng trước ứng dụng
- [ ] Đã chạy thử toàn bộ luồng trên preprod
- [ ] Cuối cùng mới đặt `PAYMENT_ENABLED_MAINNET=true`
