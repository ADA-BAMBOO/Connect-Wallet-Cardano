# Demo: Kolo Pay hoạt động với Kolo

Kịch bản demo trọn luồng **shop → cổng thanh toán → shop**, dùng một trang Kolo giả lập
chạy ở cổng riêng. Không đụng gì tới bboapp.xyz production.

```
  localhost:3100  (Kolo giả lập)            localhost:3000  (Kolo Pay)
  ────────────────────────────              ────────────────────────────
    ① bấm "Thanh toán bằng Cardano" ──────►  POST /api/v1/orders   (khoá API)
    ② redirect ───────────────────────────►  /pay/<ref>  → khách ký bằng ví
                                                   │
                                             watcher đối chiếu on-chain
                                                   │
    ③ ◄──── webhook đã ký HMAC ────────────  order.confirmed → GIAO HÀNG
    ④ ◄──── khách quay về /don-hang/<id> ──  returnUrl
```

Trang giả lập nằm ở [`kolo-shop/server.ts`](kolo-shop/server.ts). Nó import **thẳng**
[`integration/cardano-pay-client.ts`](../integration/cardano-pay-client.ts) — đúng file
mà một shop thật sẽ copy về — nên demo chạy qua chính đoạn mã được giao cho khách hàng.

---

## Chuẩn bị một lần

**1. Ví Preprod.** Cài Eternl hoặc Lace, tạo ví bằng seed phrase (ví cứng và ví chỉ-đọc
không ký được), rồi chuyển sang mạng **Preprod**.

**2. tADA để trả phí giao dịch.** Lấy miễn phí ở
[docs.cardano.org/cardano-testnets/tools/faucet](https://docs.cardano.org/cardano-testnets/tools/faucet).

**3. Postgres + Redis.**

```bash
npm run db:up
npm run migrate
```

**4. Kiểm tra cổng thanh toán đã sẵn sàng.**

```bash
curl -H "Authorization: Bearer $PAYMENT_HEALTH_TOKEN" localhost:3000/api/payments/health
```

Cần thấy `"ready": true` và network `preprod` có `"enabled": true`.

---

## Chạy demo

Ba cửa sổ terminal:

```bash
npm run dev          # cổng thanh toán  → localhost:3000
npm run demo:shop    # Kolo giả lập     → localhost:3100
```

Cửa sổ thứ ba để xem nhật ký — `npm run demo:shop` in ra từng bước ①③✓ khi chúng xảy ra.

### Demo bằng tiếng Anh

Đặt một dòng trong `.env.local` là cả hai bên cùng mở ra tiếng Anh:

```bash
DEFAULT_LOCALE=en
```

Nó đổi ngôn ngữ **mặc định** của cổng thanh toán, của trang Kolo giả lập, và của cả
nhật ký terminal — thứ bạn sẽ chỉ vào ở bước 6. Nút VI/EN ở cả hai bên vẫn dùng được,
và lựa chọn của người xem vẫn được nhớ trong cookie.

Bỏ dòng đó đi thì mọi thứ quay về tiếng Việt. Điền sai tên ngôn ngữ thì app cảnh báo
trong log rồi dùng tiếng Việt, không sập.

> Hai bên đồng bộ ngôn ngữ được là nhờ dùng chung cookie `cardano_locale` — cookie phân
> định theo host, mà cả hai cùng chạy trên `localhost`. Kolo thật nằm ở domain khác nên
> **không** thừa hưởng điều này; lúc ghép thật, shop phải truyền ngôn ngữ sang cổng một
> cách tường minh.

### Kịch bản trình diễn

| | Làm gì | Người xem thấy gì |
|---|---|---|
| 1 | Mở **localhost:3000**, kết nối ví, mở thẻ *Faucet stablecoin thử*, bấm lấy token | Ví nhận tUSDM sau 20–60 giây |
| 2 | Mở **localhost:3100** — đây là "Kolo" | Trang bán gói Kolo Pro, giá tính bằng USD |
| 3 | Bấm **Thanh toán bằng Cardano** | Trình duyệt nhảy sang `localhost:3000/pay/<ref>` — sang cổng thanh toán, mang theo tên sản phẩm và số tiền |
| 4 | Chọn tUSDM (hoặc ADA), bấm trả, ký trong popup ví | Thanh tiến trình: ký → phát lên mạng → vào block → đủ xác nhận |
| 5 | Bấm **Quay lại Kolo** | Trang cảm ơn của Kolo: *Đã thanh toán*, có mã giao dịch, *Đã giao hàng: rồi* |
| 6 | Chỉ vào nhật ký của `demo:shop` | `① tạo đơn` → `③ webhook order.confirmed` → `✓ GIAO HÀNG` |

Bước 4 mất khoảng 1–2 phút chờ chain. Trang thanh toán tự poll nên **không cần cắm cron
watcher** cho demo.

### Điểm đáng nói khi trình bày

- **Giá do server quyết.** Nút mua chỉ gửi lên mã sản phẩm, không gửi giá.
- **Địa chỉ nhận tiền không nằm trong request.** Nó chỉ đến từ `MERCHANT_ADDRESS_*` của
  cổng thanh toán. Ai có khoá API cũng không đổi được nơi tiền chảy về.
- **Chỉ `confirmed` mới giao hàng.** `seen` là đã lên chain nhưng chưa đủ xác nhận.
- **Trang cảm ơn không tin `?status=` trên URL** — nó hỏi lại cổng thanh toán trước khi
  hiện bất cứ điều gì đáng tiền.
- **Webhook phải đúng chữ ký.** Sai chữ ký hoặc thiếu header đều bị trả 401.
- **Chữ ký đúng vẫn chưa đủ.** Shop còn đối chiếu `ref` trong webhook với `ref` nó đang
  giữ cho mã đơn đó; lệch thì bỏ qua. Chữ ký chứng minh gói tin đến từ cổng thanh toán,
  không chứng minh nó nói về đúng đơn hàng này.

---

## Diễn tập bước ③ mà không cần giao dịch thật

Bắn một webhook `order.confirmed` (ký bằng đúng `MERCHANT_WEBHOOK_SECRET`) vào shop —
lấy mã đơn từ nhật ký dòng `①`:

```bash
npm run demo:webhook -- KOLO-20260820-001SBZQ
```

Script tra đơn thật ở cổng thanh toán rồi gửi lại chính dữ liệu đó, **chỉ đổi `status`
thành `confirmed`** — đó là đúng thứ đang được diễn tập. Nhật ký shop sẽ hiện
`✓ GIAO HÀNG`.

Hữu ích khi tập trước buổi demo, và khi kiểm tra hai repo chưa lệch phiên bản thuật
toán ký — triệu chứng của lệch phiên bản (webhook 401 hàng loạt) không hề chỉ về
nguyên nhân.

Sau đó mở lại `/don-hang/<id>` thì trạng thái quay về *Đang chờ thanh toán*, vì trang
này hỏi lại cổng thanh toán và **đơn thật vẫn chưa được trả**; nhật ký shop in một dòng
`⚠` về đúng chuyện đó. Cả hai đều là hành vi đúng — cổng thanh toán mới là nguồn sự thật.

---

## Cấu hình liên quan

Nằm trong `.env.local` của cổng thanh toán:

| Biến | Giá trị cho demo |
|---|---|
| `MERCHANT_API_KEYS` | Khoá shop dùng để gọi sang. Shop giả lập lấy khoá **đầu tiên**. |
| `MERCHANT_WEBHOOK_URL` | `http://localhost:3100/api/webhooks/kolo-pay` |
| `MERCHANT_WEBHOOK_SECRET` | Khoá ký webhook, hai bên phải giống nhau. |
| `MERCHANT_RETURN_URL_ORIGINS` | Phải chứa `http://localhost:3100`. |
| `DEFAULT_LOCALE` | `en` để demo bằng tiếng Anh, bỏ trống để dùng tiếng Việt. |

Đổi cổng của shop giả lập: `KOLO_SHOP_PORT=3200 npm run demo:shop` — nhớ sửa hai biến
`MERCHANT_WEBHOOK_URL` và `MERCHANT_RETURN_URL_ORIGINS` cho khớp.

---

## Khác biệt so với shop thật

Shop giả lập cố ý đi tắt hai chỗ, **đừng chép sang production**:

1. Nó đọc khoá từ `.env.local` của cổng thanh toán. Shop thật có file cấu hình riêng —
   xem [docs/INTEGRATION.md](../docs/INTEGRATION.md) mục 2.
2. Đơn hàng nằm trong RAM, tắt server là mất. Shop thật lưu vào database của nó.

Khi ghép vào Kolo thật, thay trang giả lập này bằng repo Kolo và copy hai file trong
[`integration/`](../integration/) sang đó.
