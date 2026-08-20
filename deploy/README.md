# Triển khai lên VPS (aaPanel) — pay.bboapp.xyz + demo.bboapp.xyz

Hai subdomain, hai tiến trình Node, một nginx đứng trước, mạng **mainnet**.

```
                    ┌──────────────── VPS (aaPanel) ────────────────┐
                    │   một thư mục /www/wwwroot/pay.bboapp.xyz      │
  demo.bboapp.xyz ──┤ nginx :443 ──► 127.0.0.1:4100  shop demo      │
                    │                    │  ① tạo đơn (khoá API)    │
                    │                    ▼                          │
   pay.bboapp.xyz ──┤ nginx :443 ──► 127.0.0.1:3000  cổng thanh toán│
                    │                    │                          │
                    │        Postgres :5432   Redis :6379           │
                    │        (chỉ nghe 127.0.0.1)                   │
                    │                    ▲                          │
                    │   systemd timer 15s ┘ POST /api/payments/watcher
                    └───────────────────────────────────────────────┘
                                         │
                                    Blockfrost (mainnet)
```

Mọi file cấu hình nhắc tới bên dưới đều nằm sẵn trong thư mục này.

> **Trang demo sẽ nhận tiền thật.** `KOLO_SHOP_NETWORK=mainnet` nghĩa là bất kỳ ai vào
> demo.bboapp.xyz bấm mua đều tạo một đơn ADA/stablecoin thật, 4.90 / 49.00 / 9.90 USD
> theo bảng hàng trong [`demo/kolo-shop/server.ts`](../demo/kolo-shop/server.ts), và
> tiền chảy về `MERCHANT_ADDRESS_MAINNET`. Trang demo lại giữ đơn **trong RAM** —
> restart tiến trình là mất hết đơn, người đã trả không tra cứu lại được ở phía shop
> (cổng thanh toán vẫn giữ đủ trong Postgres). Nếu chỉ muốn *trình diễn*, đặt
> `KOLO_SHOP_NETWORK=preprod` và bật thêm preprod ở cổng thanh toán — mục 10.

---

## 1. DNS

Hai bản ghi A trỏ về IP của VPS:

| Tên | Kiểu | Giá trị |
|---|---|---|
| `pay` | A | IP VPS |
| `demo` | A | IP VPS |

Dùng Cloudflare thì để **DNS only** (đám mây xám) lúc cấp SSL lần đầu; sau đó muốn bật
proxy thì nhớ đổi `TRUSTED_PROXY_HOPS=2` — chi tiết ở mục 5.

Chờ DNS lan rồi hãy làm tiếp. Cấp Let's Encrypt lúc DNS chưa trỏ đúng thì thất bại kèm
một thông báo không nói lên nguyên nhân:

```bash
dig +short pay.bboapp.xyz demo.bboapp.xyz
```

## 2. Chuẩn bị cho mainnet

| Thứ cần | Lấy ở đâu | Kiểm tra |
|---|---|---|
| Blockfrost project **mainnet** | [blockfrost.io](https://blockfrost.io) → New project → Network **Mainnet** | Project id bắt đầu bằng `mainnet` |
| Ví nhận tiền | Ví **bạn kiểm soát**, không phải địa chỉ nạp của sàn | Địa chỉ bắt đầu bằng `addr1` |
| Địa chỉ stake để xem sổ đơn | Cùng ví đó, mục Account | Bắt đầu bằng `stake1` |

Một project id chỉ nói chuyện được với đúng một mạng. Đặt nhầm key preprod vào ô mainnet
thì đơn mainnet sẽ được đối chiếu trên chain preprod — nơi ADA xin miễn phí ở faucet.
Ứng dụng chặn thẳng trường hợp này ở `/api/payments/health`, nhưng đừng để nó phải chặn.

**Sinh secret mới, tất cả.** Đừng chép `.env.local` từ máy dev lên: những giá trị đó đã
sống trên một máy có trình duyệt, có extension, có repo — dùng lại nghĩa là một lần lộ
máy dev kéo theo cả nơi giữ tiền.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"       # SESSION_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"       # MERCHANT_WEBHOOK_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"       # MERCHANT_API_KEYS
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))" # PAYMENT_WATCHER_SECRET
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))" # PAYMENT_HEALTH_TOKEN
```

## 3. Postgres và Redis

aaPanel → **App Store**: cài **PostgreSQL 14+** và **Redis 6+**.

- Postgres: tạo database `cardano_pay` với user riêng, mật khẩu mạnh.
- Redis: đặt `requirepass` (aaPanel → Redis → Config).
- **Cả hai chỉ nghe `127.0.0.1`.** Trong aaPanel → Security, đừng mở cổng 5432/6379 ra
  ngoài. Redis không mật khẩu mà mở ra internet thì bị quét thấy trong vài phút.

Redis không phải thứ tuỳ chọn ở đây: nó giữ cache tỷ giá ADA, khoá watcher và nonce
đăng nhập.

## 4. Mã nguồn — một thư mục, hai tiến trình

```bash
cd /www/wwwroot
git clone https://github.com/ADA-BAMBOO/Connect-Wallet-Cardano.git pay.bboapp.xyz
chown -R www:www pay.bboapp.xyz
```

Cả hai tiến trình chạy từ thư mục này: `npm start` phục vụ pay.bboapp.xyz, còn
`npm run demo:shop` phục vụ demo.bboapp.xyz. Chúng dùng chung một `node_modules`, một
`.env.local`, và một lần `git pull` — nên không bao giờ có chuyện hai bên lệch phiên
bản thuật toán ký webhook, thứ mà triệu chứng (401 hàng loạt) không hề chỉ về nguyên
nhân.

Thư mục site `demo.bboapp.xyz` mà aaPanel tạo vẫn giữ nguyên, để trống — nginx chỉ cần
nó làm chỗ xác thực ACME lúc gia hạn chứng chỉ. Không có mã nguồn nào nằm ở đó.

**Đánh đổi, nói cho rõ:** `demo/kolo-shop/server.ts` nạp `.env.local` ở gốc repo, nên
tiến trình demo đọc được toàn bộ biến của cổng thanh toán — `SESSION_SECRET`, chuỗi kết
nối Postgres, Blockfrost key — trong khi nó chỉ cần hai khoá. Tách thành hai thư mục
cũng **không** sửa được điều này nếu cả hai tiến trình cùng chạy dưới user `www`: tiến
trình demo đọc thẳng file của thư mục kia. Muốn cách ly thật thì phải cho trang demo một
**user hệ thống riêng** — xem mục 7.

**Node.** Cần **Node 22.6+** — trang demo chạy thẳng file `.ts`, dựa vào type stripping
của Node. Node 24 LTS là lựa chọn an toàn. aaPanel cài Node qua App Store → Node.js
Version Manager; nhớ đường dẫn thật của `npm`, các unit systemd cần nó:

```bash
which npm     # ví dụ /www/server/nodejs/v24.9.0/bin/npm
```

**Build.** `next build` với Mesh SDK ngốn RAM. VPS dưới 2 GB thì tạo swap trước, không
thì build chết giữa chừng với chữ `killed` — thông báo đó không nói gì về nguyên nhân:

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

```bash
cd /www/wwwroot/pay.bboapp.xyz
npm ci
npm run migrate      # tạo bảng; chạy được nhiều lần, có khoá chống chạy song song
npm run build
```

**Đừng dùng `--omit=dev`.** `demo/kolo-shop/server.ts` import `@next/env` để đọc
`.env.local`, mà gói đó nằm trong `devDependencies` — bỏ dev là tiến trình demo chết ngay
lúc khởi động. `next build` cũng cần TypeScript và Tailwind.

`npm run migrate` cần `.env.local` đã có `DATABASE_URL` — làm mục 5 trước rồi quay lại
đây. `npm run migrate -- --status` liệt kê mà không đụng gì.

## 5. Biến môi trường

Một file duy nhất, cả hai tiến trình cùng đọc:

```bash
cd /www/wwwroot/pay.bboapp.xyz
cp deploy/env/pay.bboapp.xyz.env.example .env.local
chmod 600 .env.local && chown www:www .env.local
```

Điền theo chú thích trong file. Khối `KOLO_*` ở cuối file là phần của trang demo — nó nằm
chung ở đây vì hai tiến trình dùng chung thư mục.

Bốn giá trị phải **trỏ đúng vào nhau**, lệch một ký tự là hỏng theo kiểu khó đoán:

| Biến | Giá trị | Sai thì sao |
|---|---|---|
| `PAYMENT_PUBLIC_URL` | `https://pay.bboapp.xyz` | Khách bị đưa tới link `localhost` |
| `KOLO_PAY_URL` | `https://pay.bboapp.xyz` | Trang demo gọi vào hư không |
| `KOLO_SHOP_URL` | `https://demo.bboapp.xyz` | returnUrl trỏ sai chỗ |
| `MERCHANT_RETURN_URL_ORIGINS` | phải **chứa** `https://demo.bboapp.xyz` | Tạo đơn bị từ chối vì returnUrl không nằm trong allowlist |

So khớp **chính xác**: `https` chứ không `http`, không dấu `/` ở cuối, đúng subdomain.

`MERCHANT_API_KEYS` và `MERCHANT_WEBHOOK_SECRET` giờ chỉ khai một lần — trang demo đọc
đúng file này, nên không còn cửa để hai bên lệch nhau.

**`TRUSTED_PROXY_HOPS`** — số proxy tin cậy đứng trước app. Chỉ nginx của aaPanel thì
`1`; thêm Cloudflare bật proxy thì `2`. Đặt sai thì hạn mức theo IP hoặc mất tác dụng
hoàn toàn (mỗi request rơi vào một bucket riêng), hoặc gom cả thiên hạ vào một bucket.
`/api/payments/health` báo rõ khi biến này vắng mặt.

Để `PAYMENT_ENABLED_MAINNET=false` lúc này. Bật ở mục 9, sau khi mọi thứ đã xanh.

## 6. nginx + SSL

Với **mỗi** subdomain, trong aaPanel:

1. **Website → Add site**: domain `pay.bboapp.xyz` (rồi `demo.bboapp.xyz`), không tạo
   FTP, không tạo database, PHP chọn **Static/Pure**.
2. **SSL → Let's Encrypt** → cấp chứng chỉ → bật **Force HTTPS**.
3. **Config file** → thay phần thân bằng [`nginx/pay.bboapp.xyz.conf`](nginx/pay.bboapp.xyz.conf)
   / [`nginx/demo.bboapp.xyz.conf`](nginx/demo.bboapp.xyz.conf). Xoá các `location` mặc
   định phục vụ file tĩnh và PHP — ở đây không có file tĩnh nào để phục vụ.
4. `nginx -t && systemctl reload nginx`

Điểm dễ hỏng nhất là dòng `X-Forwarded-For`. Nó có sẵn trong hai file conf; đừng đổi
thành `$remote_addr`.

**Nếu bật WAF của aaPanel** (Nginx Free WAF): thêm ngoại lệ cho các đường API, nếu không
nó chặn POST kèm JSON và bạn sẽ đi tìm lỗi ở nhầm chỗ.

| Site | Đường cần bỏ qua |
|---|---|
| pay.bboapp.xyz | `/api/` (gồm `/api/v1/orders` và `/api/payments/watcher`) |
| demo.bboapp.xyz | `/api/webhooks/kolo-pay` |

**Tường lửa.** aaPanel → Security: chỉ mở 80, 443, và cổng SSH. Đóng **3000, 4100,
5432, 6379**. Hai tiến trình Node nghe trên mọi interface (cổng thanh toán chỉ nghe
loopback nếu chạy bằng systemd của mục 7, trang demo thì luôn nghe mọi interface —
`server.listen(PORT)` trong `demo/kolo-shop/server.ts` không có cờ nào đổi được).
Cổng 4100 để hở nghĩa là `http://IP:4100` vào thẳng: không https, không WAF, không
hạn mức của nginx.

## 7. Chạy hai tiến trình

Hai lựa chọn, **chọn một**. Chạy cả hai thì bản khởi động sau chết vì cổng đã bị chiếm,
và triệu chứng trông y hệt "deploy không ăn".

**Cách A — trình quản lý Node của aaPanel (PM2).** App Store → Node.js Project → Add
project. Hai project, **cùng một thư mục**:

| | Cổng thanh toán | Trang demo |
|---|---|---|
| Thư mục | `/www/wwwroot/pay.bboapp.xyz` | `/www/wwwroot/pay.bboapp.xyz` |
| Lệnh chạy | `npm start` | `npm run demo:shop` |
| Cổng | 3000 | 4100 |
| Tự khởi động | bật | bật |

Trong ô cấu hình của aaPanel, **bỏ** phần map domain — nginx đã lo ở mục 6.

**Cách B — systemd.** Các file trong [`systemd/`](systemd/). Sửa `ExecStart` cho khớp
đường dẫn `npm` thật (mục 4) rồi:

```bash
cp deploy/systemd/kolo-pay.service deploy/systemd/kolo-demo.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now kolo-pay kolo-demo
journalctl -u kolo-pay -f
journalctl -u kolo-demo -f     # nhật ký ①③✓ của luồng demo nằm ở đây
```

Kiểm tra hai tiến trình đã nghe đúng chỗ trước khi đi tiếp:

```bash
curl -sI http://127.0.0.1:3000 | head -1
curl -sI http://127.0.0.1:4100 | head -1
```

**Nếu sau này muốn cách ly thật sự trang demo.** Bố cục một thư mục không làm được điều
đó, kể cả khi cho trang demo một user riêng: nó cần đọc `.env.local` để lấy hai khoá, mà
file đó cũng chính là nơi giữ `SESSION_SECRET` và mật khẩu Postgres. Muốn tách thì phải
tách cả ba thứ cùng lúc —

1. checkout riêng ở `/www/wwwroot/demo.bboapp.xyz`,
2. `.env.local` riêng, chỉ có khối `KOLO_*` cùng `MERCHANT_API_KEYS` và
   `MERCHANT_WEBHOOK_SECRET` (dùng [`env/demo.bboapp.xyz.env.example`](env/demo.bboapp.xyz.env.example)),
3. user hệ thống riêng (`useradd -r -s /usr/sbin/nologin kolo-demo`), đặt vào
   `User=`/`Group=` của `kolo-demo.service` và `chown` thư mục đó cho user ấy.

Thiếu bước 3 thì hai bước đầu chỉ là dọn dẹp cho gọn: hai tiến trình cùng chạy dưới `www`
thì bên nào cũng đọc được file của bên kia.

## 8. Watcher

**Không có watcher thì không đơn nào chuyển sang `confirmed`.** Trang `/pay/<ref>` tự làm
mới được khi có người đang mở tab, nhưng khoản trả bằng QR từ máy khác thì không ai nhìn.
Lượt quét này cũng là đường **bảo đảm** duy nhất để webhook về được trang shop: các đường
khác đều là đi tắt và có thể không xảy ra.

```bash
printf 'PAYMENT_WATCHER_SECRET=%s\n' 'giá-trị-thật' > /etc/kolo-watcher.env
chmod 600 /etc/kolo-watcher.env

cp deploy/systemd/kolo-watcher.service deploy/systemd/kolo-watcher.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now kolo-watcher.timer
systemctl list-timers kolo-watcher
```

Thích dùng aaPanel → Cron hơn thì tạo một **Shell Script** chạy **mỗi 1 phút**, nội dung
gọi [`watcher.sh`](watcher.sh). Đánh đổi: chậm hơn, khách nhìn thanh tiến trình lâu hơn
tới một phút. Secret nằm ở `/etc/kolo-watcher.env` chứ không viết thẳng vào ô lệnh — lệnh
cron hiện nguyên văn trong `ps aux` của mọi user trên máy.

Gọi chồng nhau không sao: mỗi đơn được bọc trong một khoá Redis, và ràng buộc ở tầng dữ
liệu giữ cho kết quả đúng ngay cả khi khoá hết hạn giữa chừng.

## 9. Bật mainnet

Theo đúng thứ tự này. Mainnet mặc định tắt là có chủ đích: nhận tiền thật phải là một
hành động cố ý, không phải hệ quả phụ của việc điền xong biến môi trường.

**a. Kiểm tra khi mainnet còn tắt** — mong đợi `ready: false` với đúng một lý do là
"Mainnet chưa bật":

```bash
curl -s -H "x-health-token: $PAYMENT_HEALTH_TOKEN" \
  https://pay.bboapp.xyz/api/payments/health | jq
```

Trường `problems` của mạng mainnet nói rõ còn thiếu gì. Sửa cho tới khi chỉ còn đúng dòng
"Mainnet chưa bật".

**b. Bật.** Đổi `PAYMENT_ENABLED_MAINNET=true` trong `.env.local` rồi khởi động lại tiến
trình (`systemctl restart kolo-pay`, hoặc nút Restart của aaPanel). Biến môi trường chỉ
đọc lúc khởi động.

**c. Xác nhận:** gọi lại lệnh trên, phải thấy `"ready": true` và mainnet
`"enabled": true`.

**d. Chạy thử một đơn nhỏ bằng tiền thật.** Mở demo.bboapp.xyz, mua gói rẻ nhất, trả bằng
ví mainnet của chính bạn, theo dõi tới cùng:

```bash
journalctl -u kolo-demo -f    # phải thấy ① tạo đơn → ③ webhook order.confirmed → ✓ GIAO HÀNG
```

Rồi mở https://pay.bboapp.xyz/orders, đăng nhập bằng ví có địa chỉ stake nằm trong
`PAYMENT_ADMIN_ADDRESSES`, kiểm tra đơn hiện đúng số tiền và đúng txHash. Tiền phải thật
sự nằm trong ví nhận — kiểm tra trên [cardanoscan.io](https://cardanoscan.io), đừng chỉ
tin màn hình xanh.

Đây là bước duy nhất chứng minh cả chuỗi chạy được. Bỏ qua nó thì lỗi đầu tiên bạn gặp sẽ
là của một khách hàng thật.

## 10. Muốn demo chạy preprod trong khi cổng thanh toán phục vụ mainnet

Hợp lý khi trang demo là để *cho xem*, không phải để bán. Cổng thanh toán bật được nhiều
mạng cùng lúc; mạng nào dùng cho đơn nào là do bên gọi khai.

Bên `pay.bboapp.xyz/.env.local`, thêm cạnh khối mainnet:

```bash
BLOCKFROST_API_KEY_PREPROD=preprod...
MERCHANT_ADDRESS_PREPROD=addr_test1...
STABLECOINS_PREPROD=[…]        # do `npm run mint:test-stablecoins` in ra ở máy dev
FAUCET_ENABLED=true            # để người xem tự lấy token thử
FAUCET_MNEMONIC="…"            # ví mint — cân nhắc kỹ, xem bên dưới
```

Bên `demo.bboapp.xyz/.env.local`: `KOLO_SHOP_NETWORK=preprod`.

Cân nhắc thật sự nằm ở `FAUCET_MNEMONIC`. Bật faucet là đặt một seed phrase lên đúng cái
máy đang giữ cổng nhận tiền thật. Ví đó chỉ có tADA nên mất cũng không sao, nhưng nó là
thêm một bí mật để lộ và thêm một endpoint công khai tiêu tài nguyên. Không bật thì người
xem tự xin tADA ở [faucet chính thức](https://docs.cardano.org/cardano-testnets/tools/faucet)
— chậm hơn một chút, sạch hơn nhiều.

## 11. Sau khi deploy

```bash
# Cổng thanh toán sẵn sàng
curl -s -H "x-health-token: $PAYMENT_HEALTH_TOKEN" https://pay.bboapp.xyz/api/payments/health | jq

# Watcher đang thật sự chạy
systemctl list-timers kolo-watcher
journalctl -u kolo-watcher --since '5 min ago'

# Bộ kiểm thử nhắm vào môi trường đã deploy — CHÚ Ý: tạo đơn thật, có ghi database.
# Chạy khi mainnet CÒN TẮT, hoặc chấp nhận dọn đơn test sau.
npm run verify:api https://pay.bboapp.xyz
```

**Khi cập nhật mã nguồn:**

```bash
cd /www/wwwroot/pay.bboapp.xyz
git pull && npm ci && npm run migrate && npm run build
systemctl restart kolo-pay kolo-demo
```

Một thư mục nên chỉ một lượt pull, và hai tiến trình luôn cùng phiên bản — không có cửa
để bên này ký webhook bằng thuật toán mà bên kia chưa biết.

`next build` chạy khi tiến trình cũ vẫn đang phục vụ, nên trang chỉ gián đoạn vài giây
lúc restart. Có migration mới thì chạy `npm run migrate` **trước** khi restart. Nhớ
restart cả `kolo-demo`: nó chạy thẳng file `.ts` nên không cần build, nhưng mã cũ vẫn
nằm trong RAM cho tới khi khởi động lại.

## Những chỗ hành xử khác lúc chạy ở localhost

| | Ở localhost | Ở hai subdomain |
|---|---|---|
| **Ngôn ngữ** | Bấm VI/EN ở một bên, bên kia đi theo — cookie `cardano_locale` phân định theo host, mà cả hai cùng ở `localhost` | Hai host khác nhau nên **không** dùng chung cookie. Khách bấm VI ở demo rồi sang trang thanh toán vẫn thấy ngôn ngữ mặc định. Đặt `DEFAULT_LOCALE` giống nhau ở hai bên để ít nhất mặc định là khớp |
| **Cookie phiên** | Không có cờ `Secure` | Có `Secure` (do `NODE_ENV=production`). Vào bằng http thuần sẽ không đăng nhập được — Force HTTPS ở mục 6 lo việc này |
| **returnUrl** | Tự động nhận mọi địa chỉ localhost | Chỉ nhận origin nằm trong `MERCHANT_RETURN_URL_ORIGINS`, và bắt buộc https |
| **Faucet** | Bật sẵn | Tắt sẵn, phải khai `FAUCET_ENABLED=true` |
| **Hạn mức tạo đơn** | 500/giờ/IP | 30/giờ/IP — chỉnh bằng `PAYMENT_ORDER_RATE_LIMIT` |
| **Sổ đơn `/orders`** | Ai cũng xem được | Khoá hẳn nếu `PAYMENT_ADMIN_ADDRESSES` trống |
