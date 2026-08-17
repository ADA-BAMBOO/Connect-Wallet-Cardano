/**
 * Kiểm thử end-to-end các API route đăng nhập, gọi qua HTTP đúng như trình duyệt.
 *
 * Yêu cầu server đang chạy (npm run dev hoặc npm start).
 * Chạy: node scripts/verify-api.mjs [baseUrl]
 */
import { MeshWallet } from "@meshsdk/core";

const BASE = process.argv[2] ?? "http://localhost:3000";

let failures = 0;

function assert(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.log(`FAIL  ${label}\n      nhận: ${JSON.stringify(actual)}\n      chờ : ${JSON.stringify(expected)}`);
  } else {
    console.log(`PASS  ${label}`);
  }
}

/** MeshWallet ký bằng payment key nên dùng change address (xem verify-auth.mjs). */
function makeWallet() {
  return new MeshWallet({ networkId: 0, key: { type: "mnemonic", words: MeshWallet.brew() } });
}

const wallet = makeWallet();
const address = wallet.getChangeAddress();

console.log(`Base URL: ${BASE}\nĐịa chỉ: ${address}\n`);

/* 1. Địa chỉ rác phải bị từ chối ------------------------------------ */
const badRes = await fetch(`${BASE}/api/auth/nonce`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ address: "khong-phai-dia-chi" }),
});
assert("nonce từ chối địa chỉ không hợp lệ", badRes.status, 400);

/* 2. Xin nonce hợp lệ ------------------------------------------------ */
const nonceRes = await fetch(`${BASE}/api/auth/nonce`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ address }),
});
const { nonce } = await nonceRes.json();
assert("nonce trả về 200", nonceRes.status, 200);
assert("nonce là chuỗi hex", /^[0-9a-f]+$/i.test(nonce ?? ""), true);

// Ràng buộc để ký được trên ví cứng (xem chú thích trong api/auth/nonce/route.ts):
//  1. Đủ ngắn để ví không phải dùng hashPayload — payload đã hash sẽ không khớp
//     nonce khi checkSignature so sánh, làm xác minh thất bại.
//  2. ASCII in được — Ledger hiển thị thành chữ, và ngưỡng độ dài rộng hơn.
const payload = Buffer.from(nonce ?? "", "hex");
const printable = payload.every((b) => b >= 0x20 && b <= 0x7e);

console.log(`      payload = ${payload.length} byte, nội dung = ${JSON.stringify(payload.toString("ascii"))}`);
assert("payload đủ ngắn cho ví cứng (<= 31 byte)", payload.length <= 31, true);
assert("payload là ASCII in được (Ledger hiện thành chữ)", printable, true);

/* 3. Chữ ký sai (ví khác) phải bị từ chối ---------------------------- */
const attacker = makeWallet();
const attackerSig = await attacker.signData(nonce, attacker.getChangeAddress());
const badVerify = await fetch(`${BASE}/api/auth/verify`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ address, signature: attackerSig }),
});
assert("verify từ chối chữ ký của ví khác", badVerify.status, 401);

/* 4. Nonce đã bị tiêu thụ ở bước 3 -> phải xin lại (chống replay) ---- */
const replayRes = await fetch(`${BASE}/api/auth/verify`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ address, signature: attackerSig }),
});
assert("nonce dùng một lần: lần 2 bị chặn", replayRes.status, 400);

/* 5. Luồng đăng nhập đúng ------------------------------------------- */
const freshRes = await fetch(`${BASE}/api/auth/nonce`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ address }),
});
const { nonce: freshNonce } = await freshRes.json();
const signature = await wallet.signData(freshNonce, address);

const verifyRes = await fetch(`${BASE}/api/auth/verify`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ address, signature }),
});
assert("verify chấp nhận chữ ký hợp lệ", verifyRes.status, 200);

const cookie = verifyRes.headers.get("set-cookie") ?? "";
assert("có set cookie session", cookie.includes("cardano_session="), true);
assert("cookie là httpOnly", /httponly/i.test(cookie), true);

/* 6. /api/auth/me đọc đúng danh tính từ cookie ----------------------- */
const sessionCookie = cookie.split(";")[0];
const meRes = await fetch(`${BASE}/api/auth/me`, { headers: { cookie: sessionCookie } });
const me = await meRes.json();
assert("me: đã xác thực", me.authenticated, true);
assert("me: đúng địa chỉ", me.address, address);

/* 7. Cookie bị sửa -> chữ ký HMAC không khớp -> từ chối -------------- */
const tampered = sessionCookie.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
const tamperedRes = await fetch(`${BASE}/api/auth/me`, { headers: { cookie: tampered } });
assert("cookie bị sửa bị từ chối", (await tamperedRes.json()).authenticated, false);

/* 8. Không cookie -> chưa đăng nhập ---------------------------------- */
const anonRes = await fetch(`${BASE}/api/auth/me`);
assert("không cookie => chưa đăng nhập", (await anonRes.json()).authenticated, false);

console.log(`\n${failures === 0 ? "Tất cả kiểm tra API đã pass." : `${failures} kiểm tra thất bại.`}`);
process.exit(failures === 0 ? 0 : 1);
