# Cardano Connect — dự án mẫu kết nối ví

Website mẫu cho phép kết nối ví trong hệ sinh thái Cardano, xây trên chuẩn
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

## Chạy dự án

```bash
npm install
cp .env.example .env.local   # tuỳ chọn — xem phần Biến môi trường
npm run dev
```

Mở http://localhost:3000

Để thử nghiệm an toàn: chuyển ví sang **Preprod** hoặc **Preview** testnet, rồi
xin ADA miễn phí tại [Cardano Testnet Faucet](https://docs.cardano.org/cardano-testnets/tools/faucet/).

## Biến môi trường

Cả hai đều **tuỳ chọn khi chạy dev**.

| Biến | Bắt buộc | Công dụng |
|---|---|---|
| `SESSION_SECRET` | Khi deploy production | Khoá HMAC ký session cookie (≥16 ký tự). Dev bỏ trống thì app tự sinh khoá tạm, session mất sau mỗi lần restart. |
| `BLOCKFROST_API_KEY` | Không | Hiển thị tên và ảnh NFT. Không có key thì app rơi về asset name đọc từ on-chain. Network suy ra từ prefix của key (`mainnet…`/`preprod…`/`preview…`). |

Sinh `SESSION_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Cấu trúc

```
src/
├── app/
│   ├── layout.tsx              Root layout, metadata
│   ├── page.tsx                Server component — vỏ trang
│   ├── globals.css             Theme tối, Tailwind v4
│   └── api/
│       ├── assets/             Metadata NFT qua Blockfrost (tuỳ chọn)
│       └── auth/
│           ├── nonce/          Sinh nonce dùng-một-lần
│           ├── verify/         Xác minh chữ ký → cấp session
│           ├── me/             Đọc session hiện tại
│           └── logout/         Xoá session
├── components/
│   ├── WalletAppLoader.tsx     Nạp động với ssr:false
│   ├── WalletApp.tsx           MeshProvider + bố cục
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
│   └── auth-server.ts          Nonce store + session cookie (server-only)
└── scripts/
    ├── verify-auth.mjs         Kiểm chứng crypto ký/xác minh
    ├── verify-api.mjs          Kiểm thử end-to-end các API route
    └── verify-browser-login.mjs  Mô phỏng ví CIP-30 + BrowserWallet thật
```

## Kiểm thử

```bash
npm run typecheck
npm run lint
npm run verify:auth          # không cần server

npm run dev                  # ở terminal khác
npm run verify:api           # kiểm thử end-to-end qua HTTP
npm run verify:browser       # mô phỏng đúng luồng trình duyệt
```

`verify:auth` dùng `MeshWallet` (ví sinh từ mnemonic) để chạy đúng chuỗi
`generateNonce → signData → checkSignature`, chứng minh cả đường đi đúng lẫn
việc chống mạo danh.

`verify:api` gọi thật các API route: từ chối địa chỉ rác, chống replay nonce,
từ chối chữ ký của ví khác, cấp cookie httpOnly, và từ chối cookie bị sửa.

`verify:browser` dựng một **ví CIP-30 giả** cắm vào `window.cardano` rồi chạy
`BrowserWallet` thật của Mesh — đúng lớp mà UI dùng. Kiểm tra được cả hai loại ví
(ký được bằng stake key và không), cùng việc xử lý lỗi CIP-30 dạng object.
Chạy được với cả dev server lẫn production:

```bash
npm run verify:browser http://localhost:3100
```

Cả ba script đều chạy được trên production build — nên dùng để kiểm tra trước khi
deploy, vì có những lỗi chỉ xuất hiện ở `next start` chứ không có ở `next dev`.

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

### Nonce store chỉ dành cho demo

[`auth-server.ts`](src/lib/auth-server.ts) lưu nonce trong RAM của tiến trình:
mất khi restart, không chia sẻ được giữa nhiều instance. Khi lên production hãy
thay bằng Redis hoặc DB có TTL. Phần ký và xác minh chữ ký thì đã đúng chuẩn.

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
