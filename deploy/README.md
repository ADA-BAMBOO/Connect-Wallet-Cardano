# Triển khai — pay.bboapp.xyz + demo.bboapp.xyz

Hai máy: một VM chạy app trong LAN, một máy aaPanel cầm IP công cộng và làm reverse
proxy. Mạng **mainnet**.

```
                              ┌───────────────────────────────────────┐
  Internet ──► máy aaPanel ──►│ 192.168.79.59  (VM "bamboolab")       │
              (IP công cộng)  │                                       │
              TLS ở đây       │  :4000  cổng thanh toán  npm start    │
                              │  :4100  trang demo       demo:shop    │
                              │     một checkout, một .env.local      │
                              │                                       │
                              │  docker: cardano-pay-postgres :5442   │
                              │          cardano-pay-redis    :6389   │
                              │                                       │
                              │  systemd timer 15s ─► watcher         │
                              └───────────────────────────────────────┘
                                              │
                                       Blockfrost (mainnet)
```

Máy app **không có IP công cộng** — mọi thứ đi vào đều phải qua máy aaPanel.

**Cổng 3000 và 3100 không dùng được**: chúng đã thuộc về stack `talosmine-*` chạy trên
cùng VM. Cổng thanh toán dùng **4000**, trang demo dùng **4100**.

> **Trang demo sẽ nhận tiền thật.** `KOLO_SHOP_NETWORK=mainnet` nghĩa là bất kỳ ai vào
> demo.bboapp.xyz bấm mua đều tạo một đơn ADA/stablecoin thật, 4.90 / 49.00 / 9.90 USD
> theo bảng hàng trong [`demo/kolo-shop/server.ts`](../demo/kolo-shop/server.ts), và
> tiền chảy về `MERCHANT_ADDRESS_MAINNET`. Trang demo lại giữ đơn **trong RAM** —
> restart tiến trình là mất hết đơn, người đã trả không tra cứu lại được ở phía shop
> (cổng thanh toán vẫn giữ đủ trong Postgres). Chỉ muốn *trình diễn* thì đặt
> `KOLO_SHOP_NETWORK=preprod` và bật thêm preprod ở cổng thanh toán — mục 9.

---

# Phần I — trên máy app (192.168.79.59)

## 1. Mã nguồn

Đã có sẵn ở `/home/talosmine/Connect-Wallet-Cardano`. Cập nhật về commit mới nhất:

```bash
cd ~/Connect-Wallet-Cardano
git fetch origin main && git reset --hard origin/main
```

Cả hai tiến trình chạy từ thư mục này: `npm start` phục vụ pay.bboapp.xyz, còn
`npm run demo:shop` phục vụ demo.bboapp.xyz. Chúng dùng chung một `node_modules`, một
`.env.local`, và một lần `git pull` — nên không bao giờ có chuyện hai bên lệch phiên bản
thuật toán ký webhook, thứ mà triệu chứng (401 hàng loạt) không hề chỉ về nguyên nhân.

Đánh đổi, nói cho rõ: `demo/kolo-shop/server.ts` nạp `.env.local` ở gốc repo, nên tiến
trình demo đọc được toàn bộ biến của cổng thanh toán — `SESSION_SECRET`, chuỗi kết nối
Postgres, Blockfrost key — trong khi nó chỉ cần hai khoá. Tách thư mục **không** sửa được
điều này chừng nào hai tiến trình còn chạy dưới cùng user; cách ly thật phải đi kèm một
user hệ thống riêng.

## 2. Postgres và Redis

Đã chạy sẵn bằng Docker:

```bash
docker ps --filter name=cardano-pay --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'
```

Phải thấy `cardano-pay-postgres` (5442) và `cardano-pay-redis` (6389). Chưa chạy thì
`npm run db:up`. Hai cổng lệch chuẩn là cố ý — máy này đã có Postgres khác của stack
`talosmine-*`.

Mật khẩu hiện là `cardano/cardano` để trần trong `docker-compose.yml`, Redis chưa có
`requirepass`. Máy không có IP công cộng nên chúng chỉ lộ ra LAN. Siết lại trước khi bật
mainnet — mục 7.

## 3. Biến môi trường

Một file duy nhất, cả hai tiến trình cùng đọc:

```bash
cd ~/Connect-Wallet-Cardano
cp deploy/env/pay.bboapp.xyz.env.example .env.local
chmod 600 .env.local
```

Sinh secret **mới** ngay trên máy này, đừng chép từ `.env.local` của máy dev — giá trị đó
đã sống trên một máy có trình duyệt, có extension, có repo:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"       # SESSION_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"       # MERCHANT_WEBHOOK_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"       # MERCHANT_API_KEYS
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))" # PAYMENT_WATCHER_SECRET
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))" # PAYMENT_HEALTH_TOKEN
```

Mainnet cần thêm ba thứ lấy từ bên ngoài:

| Biến | Lấy ở đâu | Kiểm tra |
|---|---|---|
| `BLOCKFROST_API_KEY_MAINNET` | [blockfrost.io](https://blockfrost.io) → New project → **Mainnet** | Bắt đầu bằng `mainnet` |
| `MERCHANT_ADDRESS_MAINNET` | Ví **bạn kiểm soát**, không phải địa chỉ nạp của sàn | Bắt đầu bằng `addr1` |
| `PAYMENT_ADMIN_ADDRESSES` | Địa chỉ stake của ví dùng để xem sổ đơn | Bắt đầu bằng `stake1` |

Một project id chỉ nói chuyện được với đúng một mạng. Đặt nhầm key preprod vào ô mainnet
thì đơn mainnet sẽ được đối chiếu trên chain preprod — nơi ADA xin miễn phí ở faucet.
`/api/payments/health` chặn thẳng trường hợp này, nhưng đừng để nó phải chặn.

Bốn giá trị phải **trỏ đúng vào nhau**, lệch một ký tự là hỏng theo kiểu khó đoán:

| Biến | Giá trị | Sai thì sao |
|---|---|---|
| `PAYMENT_PUBLIC_URL` | `https://pay.bboapp.xyz` | Khách bị đưa tới link nội bộ |
| `KOLO_PAY_URL` | `https://pay.bboapp.xyz` | Trang demo gọi vào hư không |
| `KOLO_SHOP_URL` | `https://demo.bboapp.xyz` | returnUrl trỏ sai chỗ |
| `MERCHANT_RETURN_URL_ORIGINS` | phải **chứa** `https://demo.bboapp.xyz` | Tạo đơn bị từ chối vì returnUrl không nằm trong allowlist |

`MERCHANT_API_KEYS` và `MERCHANT_WEBHOOK_SECRET` chỉ khai một lần — trang demo đọc đúng
file này, nên không còn cửa để hai bên lệch nhau.

**`TRUSTED_PROXY_HOPS=1`** — đúng một proxy đứng trước app: nginx của máy aaPanel.
bboapp.xyz không qua Cloudflare. Bật Cloudflare sau này thì đổi thành `2`; quên đổi là
hạn mức theo IP đọc nhầm địa chỉ của Cloudflare và gom mọi khách vào chung một bucket.
`/api/payments/health` báo rõ khi biến này vắng mặt.

Để `PAYMENT_ENABLED_MAINNET=false` lúc này. Bật ở mục 8, sau khi mọi thứ đã xanh.

## 4. Cài, migrate, build

```bash
cd ~/Connect-Wallet-Cardano
npm ci
npm run migrate      # tạo bảng; chạy được nhiều lần, có khoá chống chạy song song
npm run build
```

**Đừng dùng `--omit=dev`.** `demo/kolo-shop/server.ts` import `@next/env` để đọc
`.env.local`, mà gói đó nằm trong `devDependencies` — bỏ dev là tiến trình demo chết ngay
lúc khởi động. `next build` cũng cần TypeScript và Tailwind.

`next build` với Mesh SDK ngốn RAM. Dưới 2 GB trống thì build chết giữa chừng với chữ
`killed`, thông báo đó không nói gì về nguyên nhân. Kiểm tra bằng `free -h`; thiếu thì
tạo swap:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 5. Hai tiến trình + watcher

Ba unit trong [`systemd/`](systemd/) đã điền sẵn user `talosmine`, thư mục
`/home/talosmine/Connect-Wallet-Cardano`, và đường dẫn npm của nvm
(`/home/talosmine/.nvm/versions/node/v25.2.1/bin`).

**Nâng cấp Node bằng nvm là phải sửa lại đường dẫn đó** trong cả hai unit, nếu không
service chết với `status=203/EXEC` — lỗi này chỉ nói "không chạy được file", không nói vì
sao. Cùng lý do, `ProtectHome` đã bị bỏ khỏi cả hai unit: mã nguồn lẫn Node đều nằm trong
`/home/talosmine`.

```bash
cd ~/Connect-Wallet-Cardano
sudo cp deploy/systemd/kolo-pay.service deploy/systemd/kolo-demo.service \
        deploy/systemd/kolo-watcher.service deploy/systemd/kolo-watcher.timer \
        /etc/systemd/system/

printf 'PAYMENT_WATCHER_SECRET=%s\n' 'giá-trị-thật-trong-.env.local' \
  | sudo tee /etc/kolo-watcher.env > /dev/null
sudo chmod 600 /etc/kolo-watcher.env

sudo systemctl daemon-reload
sudo systemctl enable --now kolo-pay kolo-demo kolo-watcher.timer
```

Kiểm tra:

```bash
curl -sI http://127.0.0.1:4000 | head -1      # cổng thanh toán
curl -sI http://127.0.0.1:4100 | head -1      # trang demo
systemctl list-timers kolo-watcher
journalctl -u kolo-demo -f                    # nhật ký ①③✓ của luồng demo
```

**Không có watcher thì không đơn nào chuyển sang `confirmed`.** Trang `/pay/<ref>` tự làm
mới được khi có người đang mở tab, nhưng khoản trả bằng QR từ máy khác thì không ai nhìn.
Lượt quét này cũng là đường **bảo đảm** duy nhất để webhook về được trang shop: các đường
khác đều là đi tắt và có thể không xảy ra. Nó gọi thẳng `127.0.0.1:4000`, không vòng ra
tên miền — bớt phụ thuộc DNS, TLS và một máy khác cho một việc nội bộ chạy mỗi 15 giây.

---

# Phần II — trên máy aaPanel

## 6. Hai site reverse proxy

DNS: `pay` và `demo` đều là bản ghi A trỏ về **IP công cộng của máy aaPanel** — không phải
192.168.79.59, địa chỉ đó không định tuyến được từ internet.

Với mỗi subdomain, trong aaPanel:

1. **Website → Add site** — không tạo FTP, không tạo database, PHP chọn Static/Pure.
2. **SSL → Let's Encrypt** → cấp chứng chỉ → bật **Force HTTPS**.
3. **Config file** → dán [`nginx/pay.bboapp.xyz.conf`](nginx/pay.bboapp.xyz.conf) /
   [`nginx/demo.bboapp.xyz.conf`](nginx/demo.bboapp.xyz.conf), đã trỏ sẵn upstream
   `192.168.79.59:4000` và `:4100`. Xoá các `location` mặc định phục vụ file tĩnh và PHP.
4. `nginx -t && systemctl reload nginx`

Dùng nút **Reverse Proxy** của aaPanel cũng được, nhưng phải kiểm tra đủ ba header —
thiếu là hỏng theo kiểu khó truy:

| Header | Thiếu thì sao |
|---|---|
| `X-Forwarded-For $proxy_add_x_forwarded_for` | Hạn mức theo IP đọc nhầm, mọi người chung một bucket |
| `X-Forwarded-Proto $scheme` | App tưởng đang chạy http |
| `Host $host` | Link và cookie sai domain |

Bật WAF thì thêm ngoại lệ cho `/api/` ở site pay và `/api/webhooks/kolo-pay` ở site demo,
nếu không nó chặn POST kèm JSON và bạn sẽ đi tìm lỗi ở nhầm chỗ.

## 7. Siết mạng trước khi bật mainnet

Làm trên máy app.

**a. Đóng Postgres và Redis khỏi LAN.** Không tiến trình nào ngoài máy này cần chúng:

```yaml
# docker-compose.yml
ports:
  - "127.0.0.1:5442:5432"     # thay cho "5442:5432"
  - "127.0.0.1:6389:6379"     # thay cho "6389:6379"
```

`docker compose up -d` để áp dụng. Mật khẩu `cardano/cardano` khi đó chỉ còn với được từ
chính máy này.

**b. Chỉ cho máy aaPanel gọi vào 4000/4100.** iptables đang trống (policy ACCEPT), nghĩa
là mọi máy trong LAN đều gọi thẳng vào hai cổng đó, bỏ qua TLS và WAF.

Luật này phải đặt **trên máy app**, không phải trong dashboard aaPanel: tường lửa của
panel chỉ quản cổng của chính máy aaPanel, còn 4000/4100 nằm ở VM này. Coi LAN
192.168.79.0/24 là mạng tin cậy thì bỏ qua bước b cũng được — đó là một lựa chọn, miễn
là lựa chọn có ý thức.

```bash
sudo iptables -A INPUT -p tcp -s <IP-LAN-của-máy-aaPanel> --dport 4000 -j ACCEPT
sudo iptables -A INPUT -p tcp -s <IP-LAN-của-máy-aaPanel> --dport 4100 -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 4000 -j DROP
sudo iptables -A INPUT -p tcp --dport 4100 -j DROP
```

Nhớ lưu lại để sống qua reboot (`netfilter-persistent save`), và đừng khoá nhầm SSH.

**c. Chặng aaPanel → app là http trần.** Nằm trong LAN riêng nên chấp nhận được. Nếu hai
máy nói chuyện qua internet công cộng thì phải dựng WireGuard giữa chúng — mã đơn và
trạng thái thanh toán không nên đi ở dạng thô.

---

# Phần III — bật mainnet và vận hành

## 8. Bật mainnet

Theo đúng thứ tự. Mainnet mặc định tắt là có chủ đích: nhận tiền thật phải là một hành
động cố ý, không phải hệ quả phụ của việc điền xong biến môi trường.

**a. Kiểm tra khi còn tắt** — mong đợi mainnet chỉ còn đúng một lý do là "Mainnet chưa bật":

```bash
curl -s -H "x-health-token: $PAYMENT_HEALTH_TOKEN" \
  http://127.0.0.1:4000/api/payments/health | jq
```

**b. Kiểm tra từ ngoài vào**, sau khi máy aaPanel đã xong:

```bash
curl -s -H "x-health-token: …" https://pay.bboapp.xyz/api/payments/health | jq '.ok, .rateLimit'
```

Hai lượt khác nhau ở chỗ lượt thứ hai đi qua nginx — nó là thứ duy nhất chứng minh proxy,
DNS và TLS đã đúng.

**c. Bật.** `PAYMENT_ENABLED_MAINNET=true` trong `.env.local`, rồi
`sudo systemctl restart kolo-pay`. Biến môi trường chỉ đọc lúc khởi động.

**d. Xác nhận** `"ready": true` và mainnet `"enabled": true`.

**e. Mua thử một đơn thật.** Mở demo.bboapp.xyz, mua gói rẻ nhất, trả bằng ví mainnet của
chính bạn, theo dõi `journalctl -u kolo-demo -f` tới dòng `✓ GIAO HÀNG`. Rồi mở
https://pay.bboapp.xyz/orders, đăng nhập bằng ví có địa chỉ stake trong
`PAYMENT_ADMIN_ADDRESSES`, đối chiếu số tiền và txHash. Tiền phải thật sự nằm trong ví
nhận — kiểm tra trên [cardanoscan.io](https://cardanoscan.io), đừng chỉ tin màn hình xanh.

Đây là bước duy nhất chứng minh cả chuỗi chạy được. Bỏ qua nó thì lỗi đầu tiên bạn gặp sẽ
là của một khách hàng thật.

## 9. Muốn demo chạy preprod trong khi cổng thanh toán phục vụ mainnet

Hợp lý khi trang demo là để *cho xem*, không phải để bán. Cổng thanh toán bật được nhiều
mạng cùng lúc; mạng nào dùng cho đơn nào là do bên gọi khai.

Thêm vào `.env.local`:

```bash
BLOCKFROST_API_KEY_PREPROD=preprod...
MERCHANT_ADDRESS_PREPROD=addr_test1...
STABLECOINS_PREPROD=[…]        # do `npm run mint:test-stablecoins` in ra ở máy dev
KOLO_SHOP_NETWORK=preprod
FAUCET_ENABLED=true            # để người xem tự lấy token thử
FAUCET_MNEMONIC="…"            # ví mint — cân nhắc kỹ
```

Cân nhắc nằm ở `FAUCET_MNEMONIC`: bật faucet là đặt một seed phrase lên đúng cái máy đang
giữ cổng nhận tiền thật. Ví đó chỉ có tADA nên mất cũng không sao, nhưng nó là thêm một bí
mật để lộ và thêm một endpoint công khai tiêu tài nguyên. Không bật thì người xem tự xin
tADA ở [faucet chính thức](https://docs.cardano.org/cardano-testnets/tools/faucet).

## 10. Deploy lại

```bash
cd ~/Connect-Wallet-Cardano
git pull && npm ci && npm run migrate && npm run build
sudo systemctl restart kolo-pay kolo-demo
```

Một thư mục nên chỉ một lượt pull, và hai tiến trình luôn cùng phiên bản. `next build`
chạy khi tiến trình cũ vẫn đang phục vụ, nên chỉ gián đoạn vài giây lúc restart. Có
migration mới thì migrate **trước** khi restart. Nhớ restart cả `kolo-demo`: nó chạy thẳng
file `.ts` nên không cần build, nhưng mã cũ vẫn nằm trong RAM.

## 11. Những chỗ hành xử khác lúc chạy ở localhost

| | Ở localhost | Ở đây |
|---|---|---|
| **Ngôn ngữ** | Bấm VI/EN ở một bên, bên kia đi theo — cookie `cardano_locale` phân định theo host, mà cả hai cùng ở `localhost` | Hai host khác nhau nên **không** dùng chung cookie. Đặt `DEFAULT_LOCALE` giống nhau để ít nhất mặc định là khớp |
| **Cookie phiên** | Không có cờ `Secure` | Có `Secure` (do `NODE_ENV=production`). Vào bằng http thuần sẽ không đăng nhập được — Force HTTPS ở mục 6 lo việc này |
| **returnUrl** | Tự động nhận mọi địa chỉ localhost | Chỉ nhận origin trong `MERCHANT_RETURN_URL_ORIGINS`, bắt buộc https |
| **Faucet** | Bật sẵn | Tắt sẵn, phải khai `FAUCET_ENABLED=true` |
| **Hạn mức tạo đơn** | 500/giờ/IP | 30/giờ/IP — chỉnh bằng `PAYMENT_ORDER_RATE_LIMIT` |
| **Sổ đơn `/orders`** | Ai cũng xem được | Khoá hẳn nếu `PAYMENT_ADMIN_ADDRESSES` trống |
