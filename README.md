# Kolo Pay — cổng thanh toán Cardano cho Kolo

Cổng thanh toán Cardano của [Kolo](https://bboapp.xyz): khách trả bằng ADA hoặc
stablecoin, tiền vào thẳng ví của shop, không qua trung gian. Xây trên chuẩn
[CIP-30](https://cips.cardano.org/cip/CIP-30) với [Mesh SDK](https://meshjs.dev).

Hỗ trợ mọi ví CIP-30: **Lace, Eternl, Nami, Yoroi, Typhon, Flint, Vespr, NuFi, Gero…**

## Tính năng

| | Mô tả |
|---|---|
| **Phát hiện & kết nối ví** | Liệt kê mọi extension ví đã cài, kèm icon và version. Tự kết nối lại sau khi tải lại trang. |
| **Số dư & tài khoản** | Số dư ADA, số UTxO, địa chỉ payment và địa chỉ stake, kèm link sang Cardanoscan. |
| **Token & NFT** | Liệt kê native token và NFT. Có thể bật metadata (tên, ảnh) qua Blockfrost. |
| **Đăng nhập bằng ví** | Ký nonce theo CIP-8/CIP-30, server xác minh chữ ký và cấp session cookie httpOnly. |
| **Gửi giao dịch ADA** | Dựng, ký và phát giao dịch, kèm kiểm tra địa chỉ đúng mạng và số ADA tối thiểu. |
| **Tự nhận diện mạng** | Đọc `networkId` từ ví (0 = testnet, 1 = mainnet), đổi explorer và hiện cảnh báo tương ứng. |
| **Thanh toán stablecoin & ADA** | Đơn tính bằng USD, trả bằng USDM/iUSD/DJED/USDA (1:1) hoặc ADA (tỷ giá khoá 15 phút). Server tự đối chiếu on-chain rồi chốt đơn. |
| **Link & QR thanh toán** | Mỗi đơn có trang riêng `/pay/<mã>` kèm QR, gửi cho người trả hoặc để họ quét. |
| **Faucet stablecoin thử** | Người test tự lấy token trên Preprod: faucet đúc mới dưới policy của ví mint rồi gửi kèm min-ADA, có cooldown theo địa chỉ. Chỉ Preprod. |
| **API cho dự án bán hàng** | `/api/v1/*` có khoá API, tạo đơn idempotent theo mã đơn của shop, webhook ký HMAC báo ngược khi tiền về. Xem [docs/INTEGRATION.md](docs/INTEGRATION.md). |

## Chạy dự án

```bash
npm install
cp .env.example .env.local   # tuỳ chọn — xem phần Biến môi trường
npm run dev
```

Mở http://localhost:3000

Phần thanh toán (đang xây dựng) cần thêm Postgres và Redis. Không chạy khối này thì
mọi tính năng ví ở trên vẫn hoạt động bình thường:

```bash
npm run db:up      # Postgres + Redis qua Docker (cổng 5442 / 6389)
npm run migrate    # tạo bảng
```

Muốn xem trọn luồng shop → cổng thanh toán → shop: [`demo/README.md`](demo/README.md)
dựng một trang Kolo giả lập ở `localhost:3100` và chạy hết vòng bằng `npm run demo:shop`.

Để thử nghiệm an toàn: chuyển ví sang **Preprod** hoặc **Preview** testnet, rồi
xin ADA miễn phí tại [Cardano Testnet Faucet](https://docs.cardano.org/cardano-testnets/tools/faucet/).

## Biến môi trường

Cả hai đều **tuỳ chọn khi chạy dev**.

| Biến | Bắt buộc | Công dụng |
|---|---|---|
| `SESSION_SECRET` | Khi deploy production | Khoá HMAC ký session cookie (≥16 ký tự). Dev bỏ trống thì app tự sinh khoá tạm, session mất sau mỗi lần restart. |
| `BLOCKFROST_API_KEY` | Không | Hiển thị tên và ảnh NFT. Không có key thì app rơi về asset name đọc từ on-chain. Network suy ra từ prefix của key (`mainnet…`/`preprod…`/`preview…`). |

Riêng phần thanh toán có khối biến riêng — chỉ cần khi dùng tính năng đó, xem
[`.env.example`](.env.example):

| Biến | Công dụng |
|---|---|
| `DATABASE_URL`, `REDIS_URL` | Postgres giữ đơn hàng, Redis giữ cache tỷ giá, khoá watcher và nonce đăng nhập. |
| `BLOCKFROST_API_KEY_MAINNET`, `_PREPROD` | Mỗi mạng một key — một project id chỉ nói chuyện được với đúng một mạng. |
| `MERCHANT_ADDRESS_MAINNET`, `_PREPROD` | Địa chỉ nhận tiền. Chỉ đến từ đây, không bao giờ từ request. |
| `PAYMENT_ENABLED_MAINNET` | Mặc định `false`. Nhận tiền thật phải bật có chủ đích. |
| `PAYMENT_WATCHER_SECRET` | Bảo vệ endpoint watcher. **Bắt buộc ở production** — không có thì không đơn nào được xác nhận. |
| `PAYMENT_HEALTH_TOKEN` | Xem chi tiết `/api/payments/health` ở production. |

Sinh `SESSION_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Triển khai ra máy chủ thật thì xem [Triển khai](#triển-khai) — có checklist đầy đủ,
cách cắm cron, và trình tự bật mainnet.

## Cấu trúc

```
src/
├── app/
│   ├── layout.tsx              Root layout, metadata
│   ├── page.tsx                Server component — vỏ trang
│   ├── globals.css             Theme tối, Tailwind v4
│   ├── pay/[ref]/              Trang thanh toán
│   ├── orders/                 Sổ đơn hàng (cần quyền quản trị)
│   └── api/
│       ├── assets/             Metadata NFT qua Blockfrost (tuỳ chọn)
│       ├── payments/
│       │   ├── health/         Tình trạng hạ tầng + cấu hình + tỷ giá + peg
│       │   ├── orders/         Tạo đơn, đọc đơn, khoá giá, báo giao dịch
│       │   └── watcher/        Quét chain theo lịch (+ gửi webhook)
│       ├── faucet/             Trạng thái faucet + phát token thử (Preprod)
│       ├── v1/                 API tích hợp cho dự án bán hàng (cần khoá API)
│       │   └── orders/         Tạo đơn idempotent, tra ngược, gửi lại webhook
│       └── auth/
│           ├── nonce/          Sinh nonce dùng-một-lần
│           ├── verify/         Xác minh chữ ký → cấp session
│           ├── me/             Đọc session hiện tại
│           └── logout/         Xoá session
├── components/
│   ├── WalletAppLoader.tsx     Nạp động với ssr:false
│   ├── WalletApp.tsx           MeshProvider + bố cục
│   ├── PayAppLoader.tsx        Nạp động trang thanh toán
│   ├── PayApp.tsx              MeshProvider riêng cho /pay
│   ├── PayOrderCard.tsx        Chọn token, ký, dòng thời gian xác nhận
│   ├── CreateOrderCard.tsx     Người bán tạo đơn, sinh link + QR
│   ├── FaucetCard.tsx          Người test tự lấy stablecoin thử (Preprod)
│   ├── PaymentQr.tsx           QR vẽ bằng SVG
│   ├── OrdersRefresher.tsx     Tự làm mới sổ đơn hàng
│   ├── ConnectWallet.tsx       Modal chọn ví, ghi nhớ ví đã dùng
│   ├── AccountCard.tsx         Số dư, địa chỉ, badge mạng
│   ├── AssetsCard.tsx          Token & NFT
│   ├── SignInCard.tsx          Đăng nhập bằng chữ ký
│   ├── SendAdaCard.tsx         Gửi giao dịch ADA
│   └── ui.tsx                  Card, Button, Badge, Alert…
├── lib/
│   ├── format.ts               lovelace↔ADA, decode asset name
│   ├── network.ts              Nhận diện mạng, URL explorer
│   ├── errors.ts               Chuẩn hoá lỗi CIP-30 dạng {code, info}
│   ├── auth-server.ts          Nonce store + session cookie (server-only)
│   ├── money.ts                Số học tiền tệ bằng bigint (không dùng number)
│   ├── db.ts                   Pool Postgres + transaction (server-only)
│   ├── redis.ts                Cache, khoá phân tán (server-only)
│   ├── blockfrost.ts           Client theo từng mạng, kiểm networkMagic (server-only)
│   ├── payment-config.ts       Địa chỉ merchant, công tắc mainnet (server-only)
│   ├── stablecoins.ts          Danh mục token theo mạng, mainnet chốt cứng
│   ├── price-sources.ts        Parser từng sàn, trung vị, ngưỡng lệch (thuần)
│   ├── price.ts                Gọi nguồn giá, cache Redis, kiểm peg (server-only)
│   ├── ref.ts                  Sinh mã đơn, bảng chữ cái kiểu Base58
│   ├── orders.ts               Vòng đời đơn hàng, khoá giá (server-only)
│   ├── payment-verify.ts       Bốn điều kiện đối chiếu on-chain (thuần)
│   ├── watcher.ts              Quét chain, cập nhật đơn (server-only)
│   ├── order-view.ts           Dữ liệu trang thanh toán, dùng chung (server-only)
│   ├── cip13.ts                URI thanh toán CIP-13 cho ADA
│   ├── admin.ts                Quyền xem sổ đơn hàng (server-only)
│   ├── faucet.ts               Phát token thử: đúc, cooldown, hạn mức (server-only)
│   ├── faucet-claims.ts        Sổ phát + advisory lock của faucet (server-only)
│   ├── rate-limit.ts           Giới hạn tần suất qua Redis (server-only)
│   ├── api-key.ts              Xác thực máy-với-máy cho /api/v1 (server-only)
│   ├── return-url.ts           Allowlist origin cho returnUrl (server-only)
│   ├── public-url.ts           Địa chỉ công khai, dựng payUrl (server-only)
│   ├── webhook-signature.ts    Thuật toán ký HMAC (thuần, dùng chung với shop)
│   └── webhook.ts              Hộp thư đi + gửi lại có backoff (server-only)
├── migrations/
│   ├── 001_payment_orders.sql  Bảng đơn hàng + nhật ký chuyển trạng thái
│   ├── 002_merchant_integration.sql  Mã đơn shop, returnUrl, hộp thư webhook
│   └── 003_faucet.sql          Sổ phát của faucet (chỉ testnet)
├── integration/                Copy sang repo shop — xem docs/INTEGRATION.md
│   ├── cardano-pay-client.ts   Client + xác minh webhook, không phụ thuộc package
│   ├── example-webhook-route.ts  Endpoint nhận webhook mẫu
│   └── example-checkout.ts     Luồng checkout + trang cảm ơn mẫu
└── scripts/
    ├── verify-auth.mjs         Kiểm chứng crypto ký/xác minh
    ├── verify-api.mjs          Kiểm thử end-to-end các API route
    ├── verify-browser-login.mjs  Mô phỏng ví CIP-30 + BrowserWallet thật
    ├── verify-payment.mjs      Số học tiền tệ + registry + hạ tầng thanh toán
    ├── verify-onchain-payment.mjs    Trả tiền THẬT trên Preprod, chờ confirmed
    ├── verify-ui.mjs           Trình duyệt thật (Playwright): trang /pay, QR
    ├── verify-integration.mjs  Chữ ký webhook, returnUrl, API /api/v1
    ├── verify-faucet.mjs       Faucet: trạng thái, các nhánh từ chối, xin thật
    ├── migrate.mjs             Chạy migration Postgres
    ├── resolve-stablecoin-units.mjs  Tra & đối chiếu unit thật trên mainnet
    └── mint-test-stablecoins.mjs     Mint 4 token giả trên Preprod
```

## Kiểm thử

```bash
npm run typecheck
npm run lint
npm run verify:auth          # không cần server
npm run verify:payment       # số học tiền tệ — không cần server, không cần DB
npm run verify:integration   # chữ ký webhook + returnUrl — không cần server

npm run dev                  # ở terminal khác
npm run verify:api           # kiểm thử end-to-end qua HTTP
npm run verify:browser       # mô phỏng đúng luồng trình duyệt
npm run verify:payment -- --infra   # thêm Postgres, Redis, Blockfrost
npm run verify:integration -- --http  # API /api/v1: khoá, idempotency, allowlist

npm run verify:faucet        # faucet: trạng thái + các nhánh từ chối (không tốn gì)
npm run verify:faucet -- --claim    # xin thật một lượt trên Preprod

npm run verify:onchain       # trả tiền THẬT trên Preprod, mất vài phút
npm run verify:ui            # trình duyệt thật, cần: npx playwright install chromium
```

`verify:auth` dùng `MeshWallet` (ví sinh từ mnemonic) để chạy đúng chuỗi
`generateNonce → signData → checkSignature`, chứng minh cả đường đi đúng lẫn
việc chống mạo danh.

`verify:api` gọi thật các API route: từ chối địa chỉ rác, chống replay nonce,
từ chối chữ ký của ví khác, cấp cookie httpOnly, và từ chối cookie bị sửa.

`verify:integration` import CẢ HAI bản cài đặt thuật toán ký — bản của dịch vụ
(`src/lib/webhook-signature.ts`) và bản sao dành cho shop
(`integration/cardano-pay-client.ts`) — rồi bắt chúng đối chiếu với nhau. Hai file này
deploy ở hai repo khác nhau; sửa một bên mà quên bên kia thì mọi webhook bị từ chối, và
thông báo "chữ ký không khớp" không hề chỉ về nguyên nhân.

`verify:browser` dựng một **ví CIP-30 giả** cắm vào `window.cardano` rồi chạy
`BrowserWallet` thật của Mesh — đúng lớp mà UI dùng. Kiểm tra được cả hai loại ví
(ký được bằng stake key và không), cùng việc xử lý lỗi CIP-30 dạng object.
Chạy được với cả dev server lẫn production:

```bash
npm run verify:browser http://localhost:3100
```

Cả ba script đều chạy được trên production build — nên dùng để kiểm tra trước khi
deploy, vì có những lỗi chỉ xuất hiện ở `next start` chứ không có ở `next dev`.

## Triển khai

### 1. Hạ tầng cần có

| | Bắt buộc khi | Ghi chú |
|---|---|---|
| **Postgres 14+** | Dùng tính năng thanh toán | Neon, Supabase, RDS, hoặc tự dựng. Nhớ `?sslmode=require` với dịch vụ có host. |
| **Redis 6+** | Dùng thanh toán, hoặc chạy nhiều instance | Upstash, Redis Cloud, hoặc tự dựng. Cần cho cache tỷ giá, khoá watcher, và nonce đăng nhập. |
| **Blockfrost** | Dùng thanh toán | **Một project id cho mỗi mạng.** Free tier đủ cho lưu lượng nhỏ. |
| **Cron** | Dùng thanh toán | Gọi `/api/payments/watcher` mỗi 10–30 giây. Xem mục 4. |

Chỉ triển khai phần kết nối ví (không thanh toán) thì bỏ hết được, chỉ cần
`SESSION_SECRET`.

### 2. Biến môi trường

Sinh mọi secret bằng máy, **không** đặt tay và **không** dùng lại secret của môi
trường khác:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"     # SESSION_SECRET
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))" # các token còn lại
```

| Biến | Bắt buộc | Lấy từ đâu |
|---|---|---|
| `SESSION_SECRET` | ✅ | Tự sinh, ≥16 ký tự. Thiếu thì đăng nhập trả 500. |
| `DATABASE_URL` | thanh toán | Nhà cung cấp Postgres |
| `REDIS_URL` | thanh toán | Nhà cung cấp Redis |
| `BLOCKFROST_API_KEY_MAINNET` / `_PREPROD` | mạng tương ứng | [blockfrost.io](https://blockfrost.io), chọn đúng network |
| `MERCHANT_ADDRESS_MAINNET` / `_PREPROD` | mạng tương ứng | Địa chỉ ví **bạn kiểm soát** |
| `PAYMENT_WATCHER_SECRET` | ✅ ở production | Tự sinh. Không đặt thì watcher trả 401 và **không đơn nào được xác nhận**. |
| `PAYMENT_HEALTH_TOKEN` | nên có | Tự sinh. Không đặt thì `/health` chỉ trả `{ok, ready}`. |
| `PAYMENT_ENABLED_MAINNET` | để bật mainnet | `true`. Mặc định tắt — xem mục 6. |
| `STABLECOINS_PREPROD` | testnet | Do `npm run mint:test-stablecoins` in ra |
| `MERCHANT_API_KEYS` | ghép với dự án bán hàng | Tự sinh, ≥24 ký tự. Không đặt thì `/api/v1` khoá hẳn ở production. |
| `PAYMENT_PUBLIC_URL` | ghép với dự án bán hàng | Domain thật của cổng thanh toán. Thiếu thì không dựng được `payUrl`. |
| `MERCHANT_WEBHOOK_URL` / `_SECRET` | muốn được báo ngược | Endpoint bên shop + khoá ký ≥32 ký tự. |
| `MERCHANT_RETURN_URL_ORIGINS` | dùng `returnUrl` | Origin của shop. Không đặt thì mọi `returnUrl` bị từ chối ở production. |

Danh sách đầy đủ kèm giải thích nằm ở [`.env.example`](.env.example). Phần ghép với dự
án bán hàng có tài liệu riêng: [docs/INTEGRATION.md](docs/INTEGRATION.md).

> **`.env.local` không đi theo khi deploy.** Nó bị `.gitignore` chặn (cố ý). Mọi nền
> tảng đều có chỗ khai biến môi trường riêng — Vercel/Railway/Render có mục
> *Environment Variables*, Docker có `--env-file` hoặc secrets, systemd có
> `EnvironmentFile=`.

### 3. Các bước

```bash
npm ci
npm run migrate     # tạo bảng; chạy được nhiều lần, có khoá chống chạy song song
npm run build
npm start
```

`npm run migrate` cần `DATABASE_URL` trỏ tới đúng database của môi trường đó. Chạy
nó **trước** khi khởi động app, và chạy lại sau mỗi lần deploy có migration mới —
`npm run migrate -- --status` liệt kê mà không đụng gì.

Trên nền tảng tự build (Vercel…), thêm migrate vào lệnh build:
`npm run migrate && npm run build`.

### 4. Cron cho watcher

Không có cron thì **đơn hàng không bao giờ chuyển sang `confirmed`**. Trang thanh
toán tự làm mới được khi có người đang mở, nhưng khoản trả qua QR từ máy khác thì
không ai nhìn — cron là thứ duy nhất tìm ra chúng.

Lượt cron này cũng là đường **bảo đảm** để webhook về được dự án bán hàng: gửi xong lượt
quét, nó đẩy luôn hàng đợi webhook. Các đường kích hoạt khác (trang thanh toán đang poll)
chỉ là đi tắt và có thể không xảy ra — khách đóng tab là hết. Không cắm cron thì một
webhook thất bại lần đầu sẽ nằm lại mãi.

**Vercel** — `vercel.json`. Vercel Cron tự gửi header `authorization: Bearer $CRON_SECRET`,
nên đặt `PAYMENT_WATCHER_SECRET` **bằng đúng** `CRON_SECRET`:

```json
{ "crons": [{ "path": "/api/payments/watcher", "schedule": "* * * * *" }] }
```

Vercel Cron nhanh nhất là mỗi phút. Chậm hơn mong muốn một chút, nhưng trang thanh
toán vẫn tự làm mới cho người đang mở, nên chỉ ảnh hưởng luồng QR.

**VPS / Docker** — crontab mỗi phút, hoặc vòng lặp 15 giây cho phản hồi nhanh hơn:

```bash
* * * * * curl -fsS -X POST https://your-domain/api/payments/watcher \
  -H "authorization: Bearer $PAYMENT_WATCHER_SECRET" > /dev/null
```

```ini
# /etc/systemd/system/cardano-watcher.timer  -> OnUnitActiveSec=15
[Timer]
OnBootSec=30
OnUnitActiveSec=15
```

Gọi chồng nhau không sao: mỗi đơn được bọc trong một khoá Redis, và ràng buộc ở
tầng dữ liệu giữ cho kết quả đúng ngay cả khi khoá hết hạn giữa chừng.

### 5. Kiểm tra sau khi deploy

```bash
curl -H "x-health-token: $PAYMENT_HEALTH_TOKEN" https://your-domain/api/payments/health
```

Cần thấy `"ready": true`. Nếu `false`, trường `problems` của từng mạng nói rõ thiếu gì.

Chạy được cả bộ kiểm thử từ máy mình nhắm vào môi trường đã deploy:

```bash
PAYMENT_HEALTH_TOKEN=… PAYMENT_WATCHER_SECRET=… \
  npm run verify:payment -- --infra https://your-domain
npm run verify:api https://your-domain
```

Hai script này **tạo đơn thật** trên môi trường đó (không tiêu tiền, nhưng có ghi vào
database). Chạy trên staging thì thoải mái; trên production thì nhớ dọn đơn test sau.

### 6. Bật mainnet

Mainnet mặc định tắt dù đã điền đủ key và địa chỉ — nhận tiền thật phải là hành động
cố ý, không phải hệ quả phụ của việc điền xong biến môi trường. Trình tự an toàn:

1. `MERCHANT_ADDRESS_MAINNET` — địa chỉ **bạn thật sự kiểm soát**. Tự gửi một khoản
   nhỏ vào đó bằng ví thường và xác nhận nhận được, trước khi làm gì tiếp.
2. `BLOCKFROST_API_KEY_MAINNET` — key riêng, không dùng chung với preprod.
3. Chạy `verify:payment -- --infra` và xác nhận mainnet báo `networkMagic 764824073`.
   Đây là bằng chứng key nói chuyện đúng chain — khác hẳn với việc prefix tên key
   trông có vẻ đúng.
4. `SESSION_SECRET`, `PAYMENT_WATCHER_SECRET`, `PAYMENT_HEALTH_TOKEN` đều đã đặt.
5. Cron đã chạy và `/health` trả `ready: true`.
6. Chỉ khi đó mới đặt `PAYMENT_ENABLED_MAINNET=true`.
7. **Tự trả thử một đơn nhỏ** (1–2 USD) từ ví của mình, xem nó đi qua
   `pending → seen → confirmed`, rồi mới mở cho khách.

### 7. Vận hành

**`PAYMENT_ORDER_RATE_LIMIT` mặc định xuống 30/giờ ở production.** Nới nếu lưu lượng
thật cao hơn, nhưng đừng bỏ hẳn: đây là endpoint công khai có ghi database.

**Sao lưu Postgres.** Bảng `payment_orders` là sổ sách tiền bạc, còn
`payment_order_events` là thứ duy nhất trả lời được "vì sao đơn này bị đánh dấu đã
trả". Redis thì mất cũng không sao — nó chỉ giữ cache và gợi ý.

**Đơn kẹt ở `seen`** nghĩa là giao dịch đã lên chain nhưng chưa đủ xác nhận, hoặc cron
đã chết. Kiểm cron trước, rồi `/health`.

**Đơn `underpaid`** cần xử lý tay: tiền đã vào ví merchant nhưng thiếu so với yêu cầu.
Hệ thống cố tình không tự quyết — hoàn lại hay bù thêm là quyết định kinh doanh.

**Đổi `MERCHANT_ADDRESS_*` không làm hỏng đơn cũ**: địa chỉ được sao vào từng đơn lúc
tạo. Đơn đang chờ vẫn đối chiếu với địa chỉ cũ, đơn mới dùng địa chỉ mới.

## Những điểm cần biết

### Ví hoạt động ra sao

Extension ví inject một object vào `window.cardano`. Trang web gọi `enable()`,
người dùng bấm đồng ý trong popup, và trang nhận quyền **đọc** địa chỉ cùng UTxO.
Mọi thao tác ký đều phải được người dùng xác nhận thủ công trong ví —
**website không bao giờ chạm được vào private key**.

### Vì sao toàn bộ phần ví nạp động với `ssr: false`

`window.cardano` chỉ tồn tại trên trình duyệt, và Mesh SDK kéo theo WebAssembly.
[`WalletAppLoader.tsx`](src/components/WalletAppLoader.tsx) nạp
[`WalletApp.tsx`](src/components/WalletApp.tsx) với `ssr: false` để tránh lỗi
hydration mismatch và giữ WASM ra khỏi quá trình render phía server. Ở App Router,
`ssr: false` chỉ dùng được trong Client Component — đó là lý do có hai file.

### Bẫy bảo mật trong luồng đăng nhập

`checkSignature(nonce, signature, address)` — **tham số thứ ba là bắt buộc**.
Nếu bỏ, hàm chỉ kiểm tra chữ ký hợp lệ về mặt toán học mà không ràng buộc nó với
địa chỉ nào: kẻ tấn công có thể xin nonce của nạn nhân, ký bằng ví của chính mình,
rồi khai địa chỉ nạn nhân và chiếm được session.

`scripts/verify-auth.mjs` chứng minh cả hai chiều — có `address` thì mạo danh bị
chặn, bỏ `address` thì chữ ký của kẻ tấn công lọt qua.

### Stake address và fallback

Địa chỉ payment đổi theo từng giao dịch, nên **địa chỉ stake** mới là định danh
ổn định của một ví — đó là lựa chọn đầu tiên khi đăng nhập. Một số ví không ký
được bằng stake key, nên [`SignInCard.tsx`](src/components/SignInCard.tsx) tự
fallback sang payment address.

### Ví CIP-30 ném object, không ném `Error`

Đây là bẫy dễ dính nhất khi làm dApp Cardano. Theo đặc tả, ví ném object thuần
`{ code, info }` — nên `err.message` là `undefined` và `String(err)` cho ra
`"[object Object]"`. Nếu bắt lỗi theo kiểu thông thường, người dùng sẽ thấy
`[object Object]` và mọi logic kiểu "người dùng có bấm huỷ không?" đều sai.

Mọi chỗ hiển thị lỗi ví trong dự án đi qua [`src/lib/errors.ts`](src/lib/errors.ts),
trong đó có bảng mã lỗi CIP-30 đầy đủ. Đáng chú ý `DataSignError.AddressNotPK = 2`
chính là tín hiệu để fallback sang địa chỉ khác, chứ không phải lỗi để báo ra.

### Vì sao NFT không có hình ảnh

Ví CIP-30 **chỉ trả về `unit` và `quantity`** — không có tên, không có ảnh. Ảnh NFT
nằm trong metadata on-chain, muốn đọc phải hỏi một chain indexer.

Không cấu hình `BLOCKFROST_API_KEY` → app hiện placeholder gradient sinh từ policy ID.
Đó là hành vi có chủ đích, không phải lỗi. Thêm key vào `.env.local` là có ảnh.

Ngoài ra, trường `image` trên chain lộn xộn hơn tài liệu nhiều. Xử lý riêng
`ipfs://` là mất ảnh của rất nhiều NFT:

| Dạng thật gặp | Ghi chú |
|---|---|
| `ipfs://Qm…` | dạng chuẩn |
| `Qm…` / `bafy…` | **CID trần, không scheme** — rất phổ biến |
| `ipfs://ipfs/Qm…` | lặp `ipfs/`, nối naive ra URL sai |
| `["ipfs://Qm", "abc…"]` | CIP-25 cắt chuỗi >64 ký tự thành mảng |
| `http://…` | không phải `https` |
| `ar://…` | Arweave |
| `files[0].src` | một số bộ NFT không dùng `image` |
| `metadata.logo` | fungible token: base64 **không** tiền tố `data:` |

[`lib/nft.ts`](src/lib/nft.ts) xử lý tất cả các dạng trên; `npm run verify:nft` kiểm
tra 20 trường hợp gồm cả đầu vào rác.

#### Một gateway IPFS là không đủ

Đo thật với 6 CID NFT mainnet (SpaceBudz, Clay Nation):

| Gateway | Tải được | Trung bình |
|---|---|---|
| ipfs.io | 3/6 (50%) | 1044ms |
| dweb.link | 2/6 (33%) | 1270ms |
| w3s.link | 2/6 (33%) | 480ms |
| gateway.pinata.cloud | 2/6 (33%) | 5380ms |
| 4everland.io | 0/6 (0%) | — |

Không gateway nào đáng tin khi dùng một mình. Nhưng mỗi gateway thành công với CID
**khác nhau**, nên thử lần lượt nâng tỉ lệ lên **75%** với trung bình **435ms**.
(Đua song song cũng 75% nhưng chậm hơn nhiều vì phải chờ các gateway timeout.)

Vì vậy `/api/assets` trả về **danh sách URL ứng viên** thay vì một URL, và
[`AssetsCard`](src/components/AssetsCard.tsx) chuyển sang gateway kế tiếp mỗi lần
`<img>` báo `onError`. Hết ứng viên thì rơi về placeholder gradient — không bao giờ
để ảnh vỡ. Sửa danh sách ở hằng `IPFS_GATEWAYS` trong `lib/nft.ts`.

Phần còn lại (~25%) là NFT có nội dung thực sự không còn được pin trên IPFS — không
có cách nào lấy được, và placeholder là kết quả đúng.

### Cảnh báo hydration do extension ví

Extension ví chạy **trước** khi React hydrate và thường sửa attribute trên `<html>`
hoặc `<body>` (`class`, `style`, `data-*`). React so sánh rồi báo:

> A tree hydrated but some **attributes** of the server rendered HTML didn't match…

Chữ **attributes** là dấu hiệu nhận diện: nếu là lỗi thật của app thì thường lệch
*nội dung*, không phải attribute của thẻ gốc. Mở trang trong browser không có
extension (hoặc cửa sổ ẩn danh đã tắt extension) sẽ thấy console sạch.

[`layout.tsx`](src/app/layout.tsx) đặt `suppressHydrationWarning` trên `<html>` và
`<body>`. Cờ này **chỉ** bỏ qua cảnh báo cho attribute/text của đúng phần tử mang nó
— một cấp, không lan xuống con — nên không che được mismatch thật bên trong
component. Đừng rải nó vào component ứng dụng để "cho hết lỗi": làm vậy là bịt miệng
đúng cái cảnh báo cần nghe.

### Modal phải render qua portal, không render tại chỗ

Header của trang dùng `backdrop-blur`. Theo chuẩn CSS, phần tử có `backdrop-filter`
(hoặc `filter`, `transform`, `perspective`, `contain`) trở thành **containing block**
cho mọi con `position: fixed`.

Hệ quả: popup chọn ví đặt trong header với `fixed inset-0` sẽ bám theo khung header
cao ~73px thay vì viewport — đo được popup lệch lên trên 414px, tràn hẳn khỏi màn hình.

[`Modal`](src/components/ui.tsx) vì vậy dùng `createPortal(…, document.body)`.
Đây là lỗi rất dễ tái phát: chỉ cần đặt modal vào bất kỳ container nào có
`backdrop-blur` hay `transform` là lặp lại ngay.

### Không phải ví nào cũng ký được dữ liệu

Eternl (và một số ví khác) trả về lỗi
**“This wallet doesn't support general data signing.”** khi tài khoản đang kết nối là:

| Loại tài khoản | Vì sao không ký được |
|---|---|
| **Trezor** | Firmware Cardano chưa có CIP-8. PR của Vacuumlabs vẫn chưa được merge ([issue #5492](https://github.com/trezor/trezor-firmware/issues/5492)) |
| **Ledger** | Có CIP-8, nhưng **giới hạn payload 31 byte** |
| **Keystone** | Có hỗ trợ |
| Multi-sig / shared | Không có khoá đơn để ký |
| Read-only (thêm bằng địa chỉ) | Hoàn toàn không có khoá |

#### Vì sao thông điệp đăng nhập phải ngắn và là ASCII

Không phải vì "Ledger chặn ở 31 byte" — Ledger ký được thông điệp dài hơn thế.
Lý do thật nằm ở chỗ khác:

Khi thông điệp không hiển thị hết trên màn hình thiết bị, ví buộc phải gọi Ledger
với `hashPayload: true`. Lúc đó thứ nằm trong COSE payload là **hash**, không còn
là nonce gốc. Mà `checkSignature` của Mesh so sánh trực tiếp:

```js
Buffer.from(data, "hex").compare(builder.getPayload())
```

→ payload đã hash sẽ không khớp nonce, **xác minh thất bại dù chữ ký hoàn toàn hợp lệ**.

Ngưỡng hiển thị trong thư viện Ledger (`ledgerjs-cardano-shelley`):

| Hằng số | Giá trị |
|---|---|
| `MAX_CIP8_MSG_FIRST_CHUNK_ASCII_SIZE` | 198 |
| `MAX_CIP8_MSG_FIRST_CHUNK_HEX_SIZE` | 99 |

Giữ ASCII in được vừa được ngưỡng rộng hơn (198 thay vì 99), vừa để người dùng đọc
được thông điệp trên thiết bị thay vì một dãy hex vô nghĩa. Tránh dấu tiếng Việt:
UTF-8 đa byte vừa đội kích thước vừa mất tính ASCII.

Dự án dùng `"Login "` + 24 ký tự ngẫu nhiên = **30 byte**, nằm sâu dưới mọi ngưỡng.
[`/api/auth/nonce`](src/app/api/auth/nonce/route.ts) tự chặn nếu ai đó sửa nhãn dài
ra hoặc thêm ký tự ngoài ASCII; `verify:api` kiểm tra cả hai ràng buộc tự động.

#### `"This wallet doesn't support general data signing."` — đã truy ra nguồn

Chuỗi này **không nằm trong bất kỳ dependency nào** (đã grep toàn bộ `node_modules`).
Nó là khoá dịch của chính Eternl, tìm thấy trong
`eternl.io/translations/locales/en-US/tx-build.json`:

```json
"errors": {
  "dataSign": {
    "notAMnemonic": "This isn't a mnemonic wallet.",
    "credentialNotFound": "We couldn't find credentials that match the address to sign.",
    "invalidAddress": "The address provided for signing is invalid.",
    "invalidPayload": "The payload you're trying to sign isn't a hex string.",
    "unsupportedWalletType": "This wallet doesn't support general data signing.",
    "deviceNotFound": "Device not found."
  }
}
```

Tên khoá là **`unsupportedWalletType`** → lỗi phụ thuộc **loại ví**, không phụ thuộc
địa chỉ hay payload. Đáng chú ý: với `txSign` Eternl có hai khoá riêng
`isMultiSigWallet` và `isReadOnlyWallet`, nhưng với `dataSign` thì không — nó gộp mọi
loại ví không ký được dữ liệu vào `unsupportedWalletType`.

**Hệ quả: không có thay đổi nào ở phía dApp sửa được lỗi này.** Đổi địa chỉ, rút ngắn
payload, đổi thư viện — đều vô ích. Phải kết nối bằng một ví Eternl loại khác
(ví mnemonic tạo từ seed phrase).

Các khoá lỗi khác của `dataSign` rất hữu ích để chẩn đoán, vì mỗi khoá chỉ đúng một
nguyên nhân:

| Thông điệp Eternl | Nghĩa thật |
|---|---|
| `unsupportedWalletType` | Loại ví không ký được dữ liệu — dApp bó tay |
| `notAMnemonic` | Ví không phải loại mnemonic |
| `credentialNotFound` | Địa chỉ gửi lên không thuộc ví này |
| `invalidPayload` | Payload không phải chuỗi hex |
| `deviceNotFound` | Ví cứng chưa cắm / chưa mở app |

#### Đừng suy diễn từ thông điệp lỗi của ví

Dù với Eternl khoá `unsupportedWalletType` là lỗi cấp-ví, **không** dựa vào việc so
khớp chuỗi tiếng Anh để dừng vòng thử địa chỉ: ví khác có thể dùng câu tương tự cho
lỗi cấp-địa-chỉ. Đã từng có lúc code dừng sớm khi gặp câu này và **chặn mất fallback**.

Nguyên tắc hiện tại: chỉ dừng sớm khi người dùng chủ động huỷ; mọi lỗi khác đều thử
nốt địa chỉ còn lại. Đánh đổi: người dùng có thể thấy 2 popup ký. Đó là giá phải trả
để không bao giờ bỏ sót đường đi hợp lệ.

Khi không rõ ví bị gì, dùng thẻ **Chẩn đoán ví**
([`WalletDiagnostics.tsx`](src/components/WalletDiagnostics.tsx)) — nó thử `signData`
với stake / change / used address và in ra mã lỗi CIP-30 thô của từng lần.

Đây là **giới hạn của ví, không phải lỗi dApp** — không có cách nào vòng qua bằng
code, kể cả đổi sang địa chỉ khác. Vì vậy khi gặp lỗi này app **dừng ngay sau lần
thử đầu tiên** thay vì bật popup ký lần hai, và hiện hướng dẫn cụ thể.

Muốn thử đăng nhập, hãy chuyển Eternl sang một tài khoản thường (tạo từ seed
phrase). Các tính năng còn lại — số dư, token, NFT, gửi giao dịch — vẫn chạy bình
thường với mọi loại tài khoản, vì chúng dùng `signTx` chứ không phải `signData`.

### `SESSION_SECRET` khi chạy production

Ở production, thiếu `SESSION_SECRET` thì `/api/auth/verify` trả **500 kèm thông báo
rõ ràng**. App vẫn build và start bình thường, chỉ riêng đăng nhập báo lỗi — nên nếu
thấy đăng nhập hỏng sau khi deploy, kiểm tra biến này trước tiên.

`next dev` không cần biến này (tự sinh khoá tạm), nên lỗi **chỉ xuất hiện ở
production** — hãy chạy `npm run verify:browser` với `next start` trước khi deploy.

### Nonce store: Redis, với dự phòng trong RAM

[`auth-server.ts`](src/lib/auth-server.ts) lưu nonce trong Redis khi có `REDIS_URL`,
và rơi về `Map` trong RAM khi không có.

Bản RAM chỉ dùng được lúc dev một tiến trình: sau load balancer, người dùng xin nonce
ở instance A rồi gửi chữ ký tới instance B sẽ **luôn** bị từ chối.

Trên Redis dùng **`GETDEL`** chứ không phải `GET` rồi `DEL`. Nonce chỉ được dùng một
lần; tách làm hai lệnh thì hai request đồng thời đều đọc được cùng một nonce trước khi
nó bị xoá, và chống replay mất tác dụng.

### Hạ tầng thanh toán — những quyết định không hiển nhiên

Phần này mới có hạ tầng, chưa có giao diện. Sáu quyết định dưới đây khó đổi về sau
nên chốt ngay từ đầu.

**Tiền luôn là `bigint` ở đơn vị nhỏ nhất.** Không có `number` nào chạm vào số tiền,
kể cả để hiển thị — [`money.ts`](src/lib/money.ts) format thẳng từ `bigint` ra chuỗi.
Cột `bigint` của Postgres được driver trả về dạng **chuỗi** chứ không phải number, cố
ý, vì int8 vượt `Number.MAX_SAFE_INTEGER`; đọc bằng `toBigInt()` chứ đừng `Number()`.

Chiều làm tròn cũng là quyết định, không phải chi tiết: quy đổi ra số phải trả thì làm
tròn **lên**, ngưỡng chấp nhận thì làm tròn **xuống**. `verify:payment` chạy 2000 mẫu
ngẫu nhiên để chứng minh `USD → ADA → USD` không bao giờ ra ít hơn số ban đầu — sai
chiều ở đây nghĩa là mỗi đơn merchant lỗ một chút, âm thầm, mãi mãi.

**Địa chỉ nhận tiền chỉ đến từ biến môi trường.** Nếu client khai được địa chỉ nhận
lúc tạo đơn, kẻ tấn công tạo đơn trỏ về ví của chính họ, tự trả, và hệ thống ghi nhận
"đã thanh toán" trong khi tiền không hề về merchant. Giá trị này được **sao vào từng
đơn** lúc tạo, nên đổi env sau đó không làm sai kết luận của các đơn cũ.

**`UNIQUE(tx_hash)` là chốt chặn cuối chống double-credit.** Một giao dịch không bao
giờ thanh toán được cho hai đơn, kể cả khi logic ứng dụng có lỗ hổng. Khoá Redis chỉ
là khoá **tư vấn** để giảm việc trùng lặp giữa các instance — nó tự hết hạn, nên không
bao giờ được dùng thay cho ràng buộc ở tầng dữ liệu. `verify:payment -- --infra` kiểm
tra điều này bằng hành vi thật (chèn hai dòng cùng `tx_hash`, chờ SQLSTATE 23505), rồi
ROLLBACK nên không để lại dòng rác nào.

**Blockfrost key được xác minh bằng `networkMagic`, không phải bằng prefix.** Prefix
`mainnet…`/`preprod…` chỉ là chuỗi tự khai. App gọi `/genesis` và đối chiếu
`network_magic` do chính chain trả về (mainnet 764824073, preprod 1, preview 2). Lý do
phải chặt: nhét key preprod vào ô mainnet thì đơn mainnet sẽ được đối chiếu với chain
preprod, mà ADA preprod xin miễn phí ở faucet — kẻ tấn công trả bằng tiền giả vẫn được
ghi nhận. Địa chỉ **không** chặn được lỗi này: preprod và preview dùng chung prefix
`addr_test1`, nên `networkMagic` là cách duy nhất phân biệt.

**Mạng bị tắt phải báo *mọi* lý do, không dừng ở lý do đầu tiên.** Đây là lỗi đã gặp
lúc dựng: `/api/payments/health` dừng ở "chưa cấu hình MERCHANT_ADDRESS" và **che mất**
cảnh báo "key trỏ nhầm mạng" nằm ngay dưới. Lỗi vặt che lỗi mất tiền là kiểu hỏng tệ
nhất của một trang health, nên giờ trường `problems` liệt kê tất cả.

**`ref` dùng bảng chữ cái kiểu Base58.** Mã đơn bị đọc to qua điện thoại, chép tay từ
hoá đơn và gõ lại từ QR, nên bỏ hẳn `I`, `O`, `l` và giữ lại `1`, `0` — mỗi cặp dễ nhìn
nhầm chỉ giữ một đại diện. Ràng buộc nằm ở tầng DB (`CHECK`), không chỉ ở tầng ứng dụng.

Mainnet mặc định **tắt** dù đã điền đủ key và địa chỉ: nhận tiền thật phải là hành động
cố ý, không phải hệ quả phụ của việc điền xong biến môi trường.

### Policy ID không được chép tay

Ai cũng mint được một token tên `USDM`, và nó hiện trong ví **y hệt** hàng thật. Thứ
duy nhất phân biệt được là policy id — nên nó không bao giờ được viết từ trí nhớ hay
chép từ một bài blog.

[`resolve-stablecoin-units.mjs`](scripts/resolve-stablecoin-units.mjs) bắt hai nguồn
độc lập phải cùng đồng ý: **Cardano Token Registry** (repo có kiểm duyệt của Cardano
Foundation) dùng để *tìm* subject theo ticker, và **Blockfrost mainnet** dùng để *xác
nhận* asset tồn tại thật, đang lưu hành, ticker cùng decimals khớp nhau. Ticker nào ra
0 hoặc nhiều hơn 1 ứng viên thì script **báo lỗi** thay vì tự chọn giúp.

Hai cái bẫy gặp phải khi tra:

| | |
|---|---|
| **CIP-68** | Asset name của USDM là `0014df105553444d` — 4 byte nhãn 333 đứng trước `USDM`. Decode thẳng ra rác, phải bóc nhãn mới khớp. |
| **Token pool của DEX** | Tìm theo chuỗi con sẽ dính `DJED-USDM-SLP`, `USDM-iUSD-SLP`… của Minswap. Phải so khớp **chính xác** tên đã giải mã. |

Kết quả nằm trong [`stablecoins.ts`](src/lib/stablecoins.ts), và `verify:payment` khoá
cứng cả 4 unit lại để một lần sửa nhầm tay không lọt qua review.

Testnet thì ngược lại: **không có** stablecoin thật, nên `stablecoins.ts` để trống và
danh mục đến từ `STABLECOINS_PREPROD`. Token thử tự mint bằng
[`mint-test-stablecoins.mjs`](scripts/mint-test-stablecoins.mjs) — cả 4 dùng chung một
policy native script "cần chữ ký của ví mint", và script in ra sẵn dòng env hoàn chỉnh:

```bash
npm run mint:test-stablecoins             # lần đầu: sinh ví, bảo bạn nạp ADA từ faucet
npm run mint:test-stablecoins -- --status # xem trước policy id, chưa cần Blockfrost key
```

Env đọc đè được cả mainnet (khi token đổi hợp đồng), nhưng đó là đổi chính policy id
được coi là tiền thật — nên trang health giương cờ `registryOverridesBuiltin`. Dòng env
hỏng thì từng phần tử bị loại riêng kèm lý do, không bao giờ âm thầm trả về danh sách rỗng.

### Tỷ giá: ba nguồn, trung vị, và fail-closed

ADA quy đổi ra USD theo **trung vị của CoinGecko, Kraken và Coinbase** — một trang
tổng hợp và hai sàn, độc lập nhau về hạ tầng. Kết quả cache trong Redis 30 giây, đủ
ngắn để không lỗi thời trong một luồng checkout và đủ dài để không đốt hạn mức
CoinGecko free.

Ba tầng từ chối, tất cả đều **fail-closed** — thà không tạo được đơn mới còn hơn tạo
đơn ở mức giá không kiểm chứng được (đơn đã khoá giá vẫn thanh toán bình thường vì tỷ
giá của chúng nằm sẵn trong DB):

| Tầng | Chặn cái gì |
|---|---|
| Chặn trên/dưới mỗi nguồn | Nguồn trả `0`, trả giá của tài sản khác, hay parse ra số lạ. Ngoài khoảng 0,0001–1.000 USD là loại. |
| Tối thiểu 2 nguồn | Một nguồn sống sót không đủ để báo giá — không có gì đối chiếu. |
| Lệch nhau tối đa 3% | Các nguồn mâu thuẫn nghĩa là **có nguồn đang hỏng**. Trung vị lúc này chỉ che mất vấn đề. |

Không có `number` nào chạm vào tiền, kể cả ở đây. CoinGecko trả JSON *number*
(`0.17304511`), nhưng `String(n)` trong JS cho ra chuỗi ngắn nhất round-trip đúng lại
số đó, nên chữ số gốc được giữ nguyên rồi mới chuyển sang số nguyên micro-USD. Phần lẻ
thừa bị **cắt chứ không làm tròn** — tỷ giá thấp đi một chút, người trả trả nhiều ADA
hơn một chút, lệch về phía an toàn cho merchant.

Parser của từng sàn nằm ở [`price-sources.ts`](src/lib/price-sources.ts) tách hẳn khỏi
phần gọi mạng, và được test bằng response thật chép nguyên văn. Đây là chỗ hỏng âm thầm
nhất trong cả tính năng: API đổi hình dạng một chút là giá thành `null` — hoặc tệ hơn,
thành một con số vô nghĩa — mà không có gì báo.

### Peg chỉ có một nguồn, nên nó không được dùng để tính tiền

Kraken và Coinbase không niêm yết iUSD/DJED/USDA, nên phần kiểm peg **chỉ dựa vào
CoinGecko** — khác hẳn tỷ giá ADA vốn có ba nguồn. Vì vậy lệch peg chỉ **tắt token khỏi
checkout**, tuyệt đối không được dùng làm căn cứ quy đổi. Tiền vẫn tính theo quy ước 1:1.

Id CoinGecko phải tra bằng **contract address**, không bao giờ bằng ticker:

| Tra bằng ticker | Thực tế |
|---|---|
| `USDA` → `usda-3` | Token **Binance Smart Chain**, không liên quan Anzens. Đúng phải là `anzens-usda`. |
| `USDM` → 4 coin trùng ký hiệu | Chỉ `usdm-2` có `platforms.cardano` khớp policy id. |
| `iUSD` → không ra kết quả nào | Thực ra có, id là `iusd` — chỉ tìm được khi dò theo contract address. |

Ba trạng thái, và `unknown` **không phải** là đạt peg:

- `ok` — lệch dưới ngưỡng (mặc định 2%)
- `depegged` — có bằng chứng rõ ràng là lệch → tắt token
- `unknown` — không có nguồn giá (token thử trên testnet, hoặc CoinGecko chết) → vẫn
  cho thanh toán nhưng nói thẳng là chưa kiểm chứng được, chứ không im lặng coi như đạt

Đo thật lúc dựng (18/08/2026): USDM lệch 0,40% · **iUSD 1,95%** · DJED 1,37% · USDA 0,21%.
iUSD và DJED chạy sát ngưỡng 2% là chuyện bình thường với stablecoin thế chấp vượt mức —
chỉnh `PAYMENT_PEG_MAX_DEVIATION_BPS` nếu ngưỡng mặc định quá chặt cho nhu cầu của bạn.

### Đơn hàng: khoá giá, hết hạn, và nhật ký

```
POST /api/payments/orders              { network, amountUsd: "12.34", description? }
GET  /api/payments/orders/[ref]        trạng thái + danh sách token trả được
POST /api/payments/orders/[ref]/quote  { unit } — chọn token, khoá số phải trả
GET  /api/payments/orders?network=…    danh sách để đối soát
```

**Chỉ ADA mới có báo giá hết hạn.** Stablecoin quy ước 1:1 nên không có tỷ giá nào để
khoá — `quoteExpiresAt` là `null`, và thứ duy nhất hết hạn là bản thân đơn hàng. Với ADA
thì tỷ giá khoá 15 phút, đủ cho người trả ký và giao dịch vào block (20–60 giây) kể cả
khi họ đi pha cà phê.

**Chọn lại token được, nhưng chỉ khi chưa có ai trả.** Điều kiện nằm trong mệnh đề
`WHERE status = 'pending' AND tx_hash IS NULL AND expires_at > now()` của câu UPDATE, chứ
không kiểm ở tầng ứng dụng: giữa lúc đọc đơn và lúc ghi, một request khác có thể đã gắn
`txHash` vào. Đổi số tiền sau khi người ta đã ký là tự tay làm hỏng việc đối chiếu on-chain.

**Đơn quá nhỏ bị chặn ngay ở bước khoá giá.** Cardano yêu cầu mỗi output tối thiểu ~1 ADA,
nên đơn 0,01 USD không trả bằng ADA được. Bắt ở đây, lúc còn nói được một câu rõ ràng,
thay vì để ví báo lỗi khó hiểu lúc ký.

**Hết hạn tính lười, và không bao giờ đụng vào đơn đã `seen`.** Đơn chỉ chuyển sang
`expired` khi có người đọc đến nó — không cần tiến trình quét chạy nền. Nhưng `seen` nghĩa
là tiền đang trên đường: hết hạn lúc đó mà đổi trạng thái là xoá mất một khoản thanh toán
có thật.

**Mọi chuyển trạng thái đều vào `payment_order_events`.** Bảng đơn hàng chỉ giữ trạng thái
CUỐI; khi cần trả lời "vì sao đơn này bị đánh dấu đã trả" thì nhật ký là thứ duy nhất còn
giữ lại quá trình — kèm số tiền đã chốt, tỷ giá và nguồn giá tại đúng thời điểm đó.

#### Giới hạn tần suất fail-OPEN, ngược với tầng giá

`POST /orders` là endpoint công khai có ghi database, nên có giới hạn theo IP. Nhưng khi
Redis chết thì nó **cho qua** chứ không chặn: giới hạn tần suất là biện pháp giảm lạm dụng,
không phải chốt chặn đúng/sai, và chặn hết khi Redis nấc một cái là tự tay làm sập API của
mình. Tầng giá thì ngược lại — ở đó sai một cái là mất tiền, nên fail-closed.

Ngưỡng mặc định khác nhau theo môi trường (30/giờ ở production, 500/giờ khi dev) vì mối đe
doạ khác nhau — và vì ngưỡng thấp lúc dev chủ yếu chặn đúng `verify:payment`, vốn tạo cả
chục đơn mỗi lần chạy.

#### `enabled` khác `ready`

`enabled` chỉ xét cấu hình, không gọi mạng — nó chạy trên **mọi** request tạo đơn nên không
được phép round-trip tới Blockfrost. `ready` mới là đã kiểm chứng thật (networkMagic khớp
chain). Bật một mạng bằng key hỏng thì vẫn tạo được đơn nhưng không bao giờ xác minh được,
nên tình huống đó kéo `ready` xuống `false` và hiện thành lỗi ở `/api/payments/health`.

#### Typecheck xanh không chứng minh route được phục vụ

Gặp thật lúc dựng: `POST /api/payments/orders/[ref]/quote` trả 404 trong khi mã nguồn đúng,
`RouteContext` đúng, và `tsc` sạch. Nguyên nhân là **manifest route của Turbopack nằm trong
`.next` cũ hơn cây thư mục** — nó bỏ sót thư mục lồng được tạo cùng lúc. Xoá `.next` rồi
chạy lại là hết.

`verify:payment` vì vậy probe route bằng một mã đơn **sai định dạng** (phải ra 400), không
phải mã không tồn tại: "không tìm thấy đơn" cũng trả 404, trùng đúng mã lỗi của route chưa
đăng ký nên không phân biệt được.

### Xác minh on-chain: bốn điều kiện, và không tin client một chữ nào

```
POST /api/payments/orders/[ref]/submit  { txHash } — người trả báo giao dịch
POST /api/payments/watcher?network=…              — một lượt quét, gọi định kỳ
```

Ghép với dự án bán hàng thì thêm một tầng nữa, có khoá API riêng:

```
POST /api/v1/orders                    — tạo đơn, idempotent theo externalOrderId
GET  /api/v1/orders?externalOrderId=…  — tra ngược từ mã đơn của shop
GET  /api/v1/orders/[ref]              — trạng thái + nhật ký giao webhook
POST /api/v1/orders/[ref]/replay       — xếp lại hàng đợi webhook
```

Chi tiết ở [docs/INTEGRATION.md](docs/INTEGRATION.md).

Mọi kết luận "đã trả tiền" đều rút ra từ dữ liệu Blockfrost. `txHash` client gửi lên chỉ là
**gợi ý để biết đi hỏi chain ở đâu**. Bỏ hẳn endpoint `/submit` đi thì hệ thống vẫn đúng,
chỉ chậm hơn vài giây — đó là phép thử xem một thiết kế thanh toán có chắc hay không.

[`payment-verify.ts`](src/lib/payment-verify.ts) nhận dữ liệu đã tải sẵn và kiểm đúng bốn
điều kiện, nên toàn bộ quy tắc "thế nào là đã trả tiền" test được bằng dữ liệu mẫu:

| | Chặn cái gì |
|---|---|
| **1. Metadata mang `pay:<ref>`** | Không có bước này, kẻ tấn công chỉ cần khai lại `txHash` của một khoản trả cho đơn khác là chiếm được đơn này. |
| **2. Có output về đúng địa chỉ merchant** | Địa chỉ đã snapshot trong đơn lúc tạo, không đọc lại từ env. |
| **3. Đúng token, đủ số lượng** | Cộng **tất cả** output khớp địa chỉ (chia tiền nhiều output là hợp lệ), bỏ qua output `collateral`, và chỉ đếm đúng `unit` — output mang token luôn kèm min-ADA, không được tính nhầm phần đó. |
| **4. Đủ số xác nhận** | Mặc định 3 block. Quy ước: giao dịch trong block mới nhất tính là **1** xác nhận. |

Ngoài ra `valid_contract: false` bị từ chối ngay — script thất bại thì chain chỉ tiêu
collateral, không có khoản trả nào.

**Giao dịch bị từ chối KHÔNG bao giờ được gắn vào đơn.** Gắn vào là vừa chiếm mất ràng buộc
`UNIQUE(tx_hash)`, vừa chặn luôn khoản thanh toán thật đến sau. Nó chỉ để lại một dòng trong
`payment_order_events` để còn lần ra được.

#### Hai đường, cùng một hàm xác minh

```
người trả ký  ──►  ví gửi lên chain
      │
      ├─► trang thanh toán báo txHash        (nhanh — 3 lời gọi Blockfrost)
      │
      └─► không báo được? watcher quét
          /addresses/<merchant>/transactions  (chắc — đọc metadata để tự ghép)
```

Đường "chắc" không phải phòng hờ mà là đường đi **thật** của mọi khoản trả qua QR từ máy
khác, và của bất kỳ ai đóng tab ngay sau khi ký. Đã kiểm chứng riêng bằng
`npm run verify:onchain -- --no-submit`.

Watcher nhớ trong Redis những giao dịch đã soi mà không khớp đơn nào, để lượt sau khỏi tải
lại metadata của chúng. Gợi ý `txHash` từ client cũng nằm ở Redis chứ không phải Postgres —
nó là gợi ý, mất cũng không sao, và Postgres chỉ giữ dữ liệu tài chính.

#### Vì sao poll chứ không webhook

Giao dịch Cardano mất 20–60 giây để vào block, rồi còn chờ đủ số xác nhận. Trong bối cảnh
đó, poll mỗi 10 giây chậm hơn webhook một cách **không ai cảm nhận được** — mà lại chạy được
ở local, không cần domain public, không phải verify chữ ký webhook, và tự quét bù sau khi
server sập.

Ở production nhớ đặt `PAYMENT_WATCHER_SECRET`: endpoint này đổi trạng thái thanh toán, ai
cũng gọi được nghĩa là ai cũng đốt được hạn mức Blockfrost của bạn.

#### Kiểm chứng bằng tiền thật

```bash
npm run verify:onchain                       # trả bằng stablecoin thử
npm run verify:onchain -- --unit lovelace    # trả bằng ADA
npm run verify:onchain -- --no-submit        # buộc watcher tự quét ra
```

Script tạo đơn thật, gửi giao dịch thật lên Preprod, rồi chờ đơn tự đi qua
`pending → seen → confirmed`. Đo được lúc dựng: **~45 giây** từ lúc gửi tới lúc đủ 3 xác nhận.

Nó cũng chạy hai đường tấn công, cả hai đều dùng giao dịch có thật trên chain nên không tốn
thêm đồng nào: khai `txHash` của một giao dịch không liên quan (→ 422, đơn vẫn `pending`), và
dùng lại `txHash` của một khoản trả đã dùng cho đơn khác (→ 422, chặn ngay ở điều kiện 1,
trước cả khi chạm tới `UNIQUE`).

### Giao diện: trang thanh toán và mã QR

Người bán tạo đơn trong [`CreateOrderCard`](src/components/CreateOrderCard.tsx) và nhận về
một link `/pay/<mã>` kèm QR. Người trả mở link đó — họ **không cần** đăng nhập hay đi qua
trang chủ.

**Đơn được nạp ở server, không phải fetch rồi setState.** Trang `/pay/[ref]` là server
component: nó lấy đơn qua [`order-view.ts`](src/lib/order-view.ts) rồi truyền xuống làm
props. Hai cái lợi — người trả thấy số tiền ngay lập tức thay vì một spinner, và client chỉ
còn `setState` từ callback của interval. Kiểu fetch-rồi-setState ngay trong `useEffect` bị
eslint của React 19 chặn thẳng (`react-hooks/set-state-in-effect`), và chặn đúng: nó sinh
render dây chuyền.

**Hai loại QR, hai mục đích khác nhau:**

| Ở đâu | Mã hoá gì | Vì sao |
|---|---|---|
| Thẻ tạo đơn | URL `/pay/<mã>` | Quét bằng điện thoại rồi mở trong dApp browser của ví — đường **duy nhất** chạy được cho stablecoin. |
| Trang thanh toán | URI CIP-13 | Chỉ hiện khi trả bằng ADA. CIP-13 không mô tả được native asset, nên trả bằng token thì cố tình **không** có QR — một URI thiếu số tiền sẽ khiến người ta gửi nhầm. |

QR dùng `qrcode-generator` (một file, không phụ thuộc gì thêm) thay vì tự viết. Bộ mã hoá
QR đúng chuẩn cần Reed-Solomon, chèn pattern, chọn mask theo điểm phạt và ghi format info —
sai một bước là mã không quét được, mà không có bộ giải mã thì cũng không có cách nào biết
mình đã sai. `verify:ui` đọc ngược ma trận từ SVG đã render và so với ma trận chuẩn, nên
phần tự viết (dựng path SVG) vẫn được kiểm.

**Nền QR luôn trắng**, không theo theme tối của trang: máy quét cần tương phản đúng chiều,
và QR trắng trên nền đen thì phần lớn máy quét chịu thua. Vùng lặng 4 module quanh mã cũng
bắt buộc — thiếu nó là lý do phổ biến nhất khiến một QR "trông đúng" mà quét mãi không ra.

**Không có ví thì hướng dẫn, không để nút chết.** Trình duyệt thường trên điện thoại không
có `window.cardano` — CIP-30 chỉ tồn tại trong extension desktop và trong dApp browser tích
hợp của ví mobile. Trang nói rõ điều đó kèm link để copy sang.

**Cảnh báo lệch mạng trước khi ký.** Ví ở Mainnet mà đơn ở Preprod (hoặc ngược lại) thì hiện
cảnh báo đỏ — gửi nhầm mạng là mất tiền và không lấy lại được.

### Dòng thời gian sau khi ký

Khoảng từ lúc bấm ký tới lúc đơn chốt kéo dài **20–60 giây để vào block, rồi ~40 giây nữa
cho đủ 3 xác nhận**. Không hiện gì trong khoảng đó thì người dùng tưởng hỏng và bấm trả
lần nữa — mà lần nữa là mất thêm tiền thật.

Nên khi giao dịch đang trên đường, trang chuyển sang một dòng thời gian bốn chặng, và
**ẩn hẳn phần chọn token** (đổi token lúc này vô nghĩa, chỉ khiến người ta tưởng phải trả
lại):

```
✓ Ký trong ví
✓ Gửi lên mạng Cardano        d4d5788f60e5…84ef0bd9 ↗
✓ Vào block
◐ Đủ 3 xác nhận               1/3 — mỗi block khoảng 20 giây
```

Trạng thái ghép từ **hai nguồn**: chặng cục bộ ở client (biết sớm nhất — "đang dựng giao
dịch", "ví đã mở popup, bấm xác nhận trong ví") và trạng thái đơn từ server (chậm hơn
nhưng bền). Nhờ vậy người dùng có phản hồi ngay khi bấm, mà **tải lại trang giữa chừng
vẫn không mất dấu** — dòng thời gian dựng lại được hoàn toàn từ đơn hàng.

Ngay khi ví trả về `txHash`, trang hiện luôn link explorer — trước cả khi server biết
giao dịch tồn tại. Kèm câu "bạn có thể đóng trang này": đó là sự thật, và là điều người
đang chờ cần nghe nhất.

### Sổ đơn hàng `/orders`

Trang đối soát cho người bán: tổng đã thu, tổng đang chờ, số đơn cần xử lý tay, và bảng
đơn kèm link explorer. Server component đọc thẳng database, tự làm mới mỗi 10 giây bằng
`router.refresh()` — chỉ lấy lại payload rồi ghép vào cây React hiện tại, không tải lại
cả trang nên không mất vị trí cuộn.

Số liệu tổng hợp tính bằng SQL chứ không tải hết đơn về rồi cộng trong JS: sổ đơn hàng
chỉ có tăng, và một ngày nào đó nó sẽ không vừa bộ nhớ.

**Trang này và `GET /api/payments/orders` đều cần quyền quản trị.** Danh sách để lộ số
tiền, địa chỉ merchant, địa chỉ người trả và txHash của mọi đơn; biết `ref` của người
khác còn xem được cả trang thanh toán của họ. Đây là sổ sách kinh doanh, không phải dữ
liệu công khai.

Quyền dựa trên phiên đăng nhập bằng ví (CIP-8) vốn đã có sẵn — chữ ký chứng minh người
dùng thật sự sở hữu địa chỉ. Nhưng "đăng nhập được" chưa phải "được xem": **bất kỳ ví nào
cũng đăng nhập được**, nên phải có thêm `PAYMENT_ADMIN_ADDRESSES` liệt kê địa chỉ quản trị.

Chưa cấu hình biến đó thì dev mở (đỡ phiền lúc đang code) còn **production khoá hẳn**.
Fail-closed là cố ý: quên cấu hình mà mặc định mở nghĩa là sổ sách nằm công khai trên
internet, và không có gì báo cho bạn biết. Ở chế độ mở của dev, trang hiện băng cảnh báo
màu vàng để không ai deploy nhầm mà tưởng đã được bảo vệ.

Trang tự poll trạng thái mỗi 4 giây, và **dừng hẳn** khi đơn đã `confirmed`/`expired` để một
tab bỏ quên không gọi API mãi mãi. Việc đối chiếu on-chain kèm theo mỗi lần đọc được tiết
chế 6 giây dùng chung toàn cụm (khoá trong Redis) — nhờ vậy trang tự tiến triển kể cả khi
chưa cắm cron watcher, mà mười người mở cùng một đơn cũng không đốt hạn mức Blockfrost.

### Faucet: đúc mới, không xuất kho

Trang `/pay` đòi người trả phải có sẵn token trong ví, mà trên testnet thì không mua
được tUSDM ở đâu cả. Trước đây cách duy nhất là nhờ người giữ `MINT_MNEMONIC` chạy
`npm run mint:test-stablecoins -- --to <địa chỉ>` cho từng người; faucet chính là việc
đó, mở thành endpoint có cooldown và có ghi sổ.

**Phát bằng cách đúc.** Ví faucet chính là ví giữ policy của bộ token thử, nên nó đúc
mới ngay trong giao dịch phát thay vì trừ vào một kho có sẵn. Hệ quả: faucet không bao
giờ "hết token", chỉ có thể hết ADA. Token nào KHÔNG thuộc policy đó (ai đó khai tay vào
`STABLECOINS_PREPROD`) thì tự động rơi về chế độ chuyển từ số dư, và trang trạng thái
báo rõ nó còn bao nhiêu.

`mintAsset` được gọi **không kèm `recipient`**. Truyền recipient thì Mesh tạo một output
riêng cho từng token, mỗi output lại phải tự đạt min-ADA — 4 token thành ~5 ADA mỗi lượt
phát. Bỏ recipient đi thì token vừa đúc nằm trong giá trị giao dịch và một `sendAssets`
duy nhất gom tất cả vào một output, tốn đúng một suất min-ADA.

Tên asset được kiểm khứ hồi `hex → chữ → hex` trước khi đúc lại. `mintAsset` nhận tên
dạng CHỮ rồi tự hex hoá, nên với asset name không phải UTF-8 sạch (ví dụ tiền tố CIP-68
`0014df10`), chuỗi đi ra khác chuỗi đi vào và faucet sẽ đúc một token khác mang tên gần
giống. Không khớp thì coi như không đúc được.

**Hai hàng rào, chặn hai thứ khác nhau.** Hạn mức theo IP chặn vòng lặp curl trước khi
nó đụng tới Blockfrost và ví; cooldown theo ĐỊA CHỈ NHẬN (lưu trong Postgres) chặn đúng
thứ mà đổi IP không lách được. Thiếu `DATABASE_URL` thì faucet **tắt**, không phải chạy
tiếp mà bỏ cooldown — faucet không cooldown chỉ là một cái vòi mở sẵn.

**Một ví chỉ dựng được một giao dịch tại một thời điểm.** Hai lượt phát song song là hai
giao dịch cùng tiêu một UTxO, và cái tới sau bị chain từ chối sau khi người dùng đã tưởng
mình xin xong. Cả luồng phát nằm trong một `pg_try_advisory_lock`: giành không được thì
trả 409 "đang bận" ngay, chứ không xếp hàng giữ request HTTP treo. Khoá gắn với phiên kết
nối nên tiến trình chết giữa chừng thì nó tự rơi ra — khác hẳn một cột `locked` trong
bảng, vốn sẽ kẹt mãi.

Dòng `pending` được ghi **trước** khi gửi giao dịch. Ghi sau thì một lần crash giữa hai
bước để lại giao dịch trên chain mà không có dòng nào trong sổ. Đổi lại, cooldown chỉ
tính dòng `pending` trong 5 phút đầu: một dòng mắc kẹt không được phép khoá địa chỉ đó
vĩnh viễn, còn đơn `failed` thì không tính chút nào — lỗi của faucet không nên làm người
test mất lượt.

**Mạng chốt cứng trong code.** `FAUCET_NETWORK = "preprod"` là hằng số, không đọc từ biến
môi trường và không nhận từ request; ví faucet luôn dựng với `networkId: 0`; bảng
`faucet_claims` có `CHECK` chặn mainnet ở tầng DB. Faucet trên mainnet là phát tiền thật
cho người lạ, nên nó không được phép tồn tại ở dạng "chỉ cần đổi một biến là bật".

### `overrides` trong package.json

`libsodium-wrappers-sumo@0.7.16` (đi kèm `@cardano-sdk/crypto` của Mesh) có bug
đóng gói: bản ESM `import "./libsodium-sumo.mjs"` bằng đường dẫn tương đối, nhưng
file đó nằm ở package khác nên bundler không resolve được. Dự án pin về `0.7.15`
— bản chỉ ship CJS với `require("libsodium-sumo")` đúng. **Gỡ override ra thì
build sẽ fail.**

### Phiên bản Mesh SDK

`@meshsdk/core` và `@meshsdk/react` được **pin cứng ở `1.8.14`** (không dùng `^`).
Lý do: nhánh `1.9.x` của `@meshsdk/react` chưa có bản stable, và dải `^1.8.14`
sẽ kéo `core` lên `1.9.1` trong khi `react` đứng yên ở `1.8.14` — hai package
dùng `@meshsdk/wallet` khác phiên bản, dễ sinh lỗi khó lần.

## Mở rộng tiếp

- **Smart contract**: Mesh có sẵn transaction builder cho Plutus — xem [meshjs.dev/apis/txbuilder](https://meshjs.dev/apis/txbuilder).
- **Gửi token/NFT**: `tx.sendAssets(address, [{ unit, quantity }])` thay cho `sendLovelace`.
- **Bảo vệ route bằng session**: đọc cookie trong middleware hoặc Server Component qua `readSessionToken`.
- **Mobile**: CIP-30 chỉ chạy trên extension desktop. Ví mobile cần [CIP-45](https://cips.cardano.org/cip/CIP-45) (WebRTC) — hiện chưa phổ biến.

## Stack

Next.js 16 (App Router, Turbopack) · React 19 · TypeScript · Tailwind CSS v4 · Mesh SDK 1.8.14
