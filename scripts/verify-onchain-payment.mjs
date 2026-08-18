/**
 * Kiểm chứng ĐẦU-CUỐI luồng thanh toán bằng tiền thật trên Preprod.
 *
 *   npm run verify:onchain                    trả bằng token đầu tiên trong registry
 *   npm run verify:onchain -- --unit lovelace trả bằng ADA
 *   npm run verify:onchain -- http://localhost:3100
 *
 * Cần: dev server đang chạy, preprod đã bật, và MINT_MNEMONIC có đủ tADA.
 *
 * Khác với verify:payment (dùng dữ liệu mẫu), script này thật sự gửi giao dịch lên
 * chain rồi chờ đơn tự chuyển pending -> seen -> confirmed. Nó tốn tADA và mất vài
 * phút, nên tách riêng khỏi bộ kiểm thử chạy thường xuyên.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import nextEnv from "@next/env";
import { BlockfrostProvider, MeshWallet, Transaction } from "@meshsdk/core";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
nextEnv.loadEnvConfig(projectDir, false, { info: () => {}, error: console.error });

const args = process.argv.slice(2);
const BASE = args.find((a) => a.startsWith("http")) ?? "http://localhost:3000";
const unitArg = args[args.indexOf("--unit") + 1];
const wantUnit = args.includes("--unit") ? unitArg : null;

/**
 * Bỏ hẳn bước báo txHash về server, buộc watcher phải tự tìm ra bằng cách quét giao
 * dịch tới địa chỉ merchant và đọc metadata.
 *
 * Đây là đường đi thật của mọi khoản trả qua QR từ máy khác, và của bất kỳ ai đóng
 * tab ngay sau khi ký. Nếu đường này hỏng thì tiền vào mà đơn không bao giờ chốt.
 */
const skipSubmit = args.includes("--no-submit");

let failures = 0;
let passes = 0;

function assert(label, actual, expected) {
  const ok = String(actual) === String(expected);
  if (ok) {
    passes++;
    console.log(`PASS  ${label}`);
  } else {
    failures++;
    console.log(`FAIL  ${label}\n      nhận: ${actual}\n      chờ : ${expected}`);
  }
}

function assertTrue(label, value) {
  assert(label, Boolean(value), true);
}

async function api(method, endpoint, body) {
  const response = await fetch(`${BASE}${endpoint}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* route trả HTML => 404, status đã nói lên điều đó */
  }
  return { status: response.status, json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */

const key = process.env.BLOCKFROST_API_KEY_PREPROD?.trim();
const words = process.env.MINT_MNEMONIC?.trim().split(/\s+/).filter(Boolean);

if (!key?.startsWith("preprod") || !words?.length) {
  console.error("Cần BLOCKFROST_API_KEY_PREPROD và MINT_MNEMONIC trong .env.local.");
  process.exit(1);
}

const provider = new BlockfrostProvider(key);
const payer = new MeshWallet({
  networkId: 0,
  fetcher: provider,
  submitter: provider,
  key: { type: "mnemonic", words },
});

const payerAddress = payer.getChangeAddress();
console.log(`Ví trả tiền: ${payerAddress}`);
console.log(`Server:      ${BASE}\n`);

/* 1. Tạo đơn --------------------------------------------------------- */

const created = await api("POST", "/api/payments/orders", {
  network: "preprod",
  amountUsd: "1.25",
  description: "Kiem chung dau-cuoi",
});
assert("tạo đơn => 201", created.status, 201);

if (created.status !== 201) {
  console.error(created.json?.error ?? "(không rõ lỗi)");
  process.exit(1);
}

const ref = created.json.order.ref;
const merchantAddress = created.json.order.merchantAddress;
console.log(`\nMã đơn: ${ref}\nMerchant: ${merchantAddress}\n`);

/* 2. Chọn token và khoá giá ------------------------------------------ */

const detail = await api("GET", `/api/payments/orders/${ref}`);
const tokens = detail.json?.tokens ?? [];

const token = wantUnit
  ? tokens.find((t) => t.unit === wantUnit)
  : (tokens.find((t) => t.pegged && t.available) ?? tokens[0]);

if (!token) {
  console.error("Không tìm thấy token phù hợp trong danh mục của preprod.");
  process.exit(1);
}

const quoted = await api("POST", `/api/payments/orders/${ref}/quote`, {
  unit: token.unit,
  buyerAddress: payerAddress,
});
assert(`khoá giá bằng ${token.symbol} => 200`, quoted.status, 200);

const payment = quoted.json?.order?.payment;
console.log(`\nPhải trả: ${payment.quantityFormatted} ${payment.symbol}\n`);

/* 3. Giao dịch KHÔNG có metadata phải bị từ chối ---------------------- */
// Dùng luôn một giao dịch có thật trên chain (giao dịch mint) để chứng minh rằng
// khai lại txHash của người khác không chiếm được đơn. Không tốn thêm đồng nào.

const unrelatedTx = await api("GET", `/api/payments/orders/${ref}`);
void unrelatedTx;

const addressTxs = await fetch(
  `https://cardano-preprod.blockfrost.io/api/v0/addresses/${payerAddress}/transactions?order=desc&count=1`,
  { headers: { project_id: key } },
).then((r) => r.json());

if (Array.isArray(addressTxs) && addressTxs[0]?.tx_hash) {
  const foreign = await api("POST", `/api/payments/orders/${ref}/submit`, {
    txHash: addressTxs[0].tx_hash,
  });
  assert("khai txHash của giao dịch không liên quan => 422", foreign.status, 422);
  // Lý do cụ thể phụ thuộc vào giao dịch gần nhất của ví trả tiền: nếu nó không có
  // metadata thì là "thiếu pay:<ref>", còn nếu nó là một khoản trả cho đơn KHÁC thì
  // là "metadata mang mã đơn khác". Cả hai đều đúng và đều chặn được, nên chỉ khẳng
  // định điều thật sự quan trọng: bị từ chối VÌ metadata, và có nói lý do.
  // Hai nhánh này được phân biệt rạch ròi trong phần dữ liệu mẫu của verify:payment.
  assertTrue(
    `từ chối vì metadata — "${foreign.json?.error ?? ""}"`,
    /metadata/i.test(foreign.json?.error ?? ""),
  );

  const untouched = await api("GET", `/api/payments/orders/${ref}`);
  // Giao dịch bị từ chối tuyệt đối không được gắn vào đơn: gắn vào là chiếm mất
  // UNIQUE(tx_hash) và chặn luôn khoản trả thật đến sau.
  assert("đơn vẫn pending, không bị gắn tx rác", untouched.json?.order?.status, "pending");
  assert("không có tx nào bị gắn vào đơn", untouched.json?.order?.tx, null);
}

/* 4. Trả tiền thật ---------------------------------------------------- */

console.log("\nDựng giao dịch thanh toán…");

const tx = new Transaction({ initiator: payer });

if (token.unit === "lovelace") {
  tx.sendLovelace(merchantAddress, payment.quantity);
} else {
  tx.sendAssets(merchantAddress, [{ unit: token.unit, quantity: payment.quantity }]);
}

// Đây là thứ buộc giao dịch với đơn hàng. Ví hiển thị được cho người dùng đọc.
tx.setMetadata(674, { msg: [`pay:${ref}`] });

const unsigned = await tx.build();
const signed = await payer.signTx(unsigned);
const txHash = await payer.submitTx(signed);

console.log(`Đã gửi: ${txHash}`);
console.log(`  https://preprod.cardanoscan.io/transaction/${txHash}\n`);

/* 5. Báo về server ---------------------------------------------------- */

if (skipSubmit) {
  console.log("(--no-submit: KHÔNG báo txHash — watcher phải tự quét địa chỉ merchant)");
} else {
  const submitted = await api("POST", `/api/payments/orders/${ref}/submit`, { txHash });
  // 202 = chưa vào block (bình thường), 200 = đã thấy ngay.
  assertTrue(`báo giao dịch => ${submitted.status}`, [200, 202].includes(submitted.status));
}

/* 6. Chờ watcher đưa đơn qua seen -> confirmed ------------------------ */

console.log("\nChờ watcher (giao dịch cần vào block rồi đủ 3 xác nhận)…\n");

const DEADLINE = Date.now() + 6 * 60_000;
const seenStates = new Set();
let final = null;

while (Date.now() < DEADLINE) {
  const sweep = await api("POST", "/api/payments/watcher?network=preprod");
  if (sweep.status !== 200) {
    console.log(`      watcher trả ${sweep.status}: ${sweep.json?.error ?? ""}`);
    break;
  }

  const order = (await api("GET", `/api/payments/orders/${ref}`)).json?.order;
  const status = order?.status;
  const confirmations = order?.tx?.confirmations ?? 0;

  if (!seenStates.has(`${status}:${confirmations}`)) {
    seenStates.add(`${status}:${confirmations}`);
    console.log(`      ${new Date().toLocaleTimeString()}  ${status.padEnd(10)} ${confirmations} xác nhận`);
  }

  if (status === "confirmed" || status === "underpaid" || status === "expired") {
    final = order;
    break;
  }
  await sleep(10_000);
}

console.log("");

if (!final) {
  failures++;
  console.log("FAIL  đơn không đạt trạng thái cuối trong 6 phút");
} else {
  assert("đơn kết thúc ở trạng thái confirmed", final.status, "confirmed");
  assert("gắn đúng giao dịch đã gửi", final.tx?.hash, txHash);
  assertTrue("đạt đủ số xác nhận yêu cầu", (final.tx?.confirmations ?? 0) >= 3);
  assert("số nhận được khớp số phải trả", final.tx?.receivedQuantity, payment.quantity);
  assertTrue("có mốc thời gian xác nhận", Boolean(final.confirmedAt));
  // Đơn đã đi qua `seen` chứ không nhảy thẳng sang `confirmed`.
  assertTrue(
    "đơn có đi qua trạng thái seen",
    [...seenStates].some((s) => s.startsWith("seen:")),
  );
}

/* 7. Một giao dịch không thanh toán được cho hai đơn ------------------ */

const second = await api("POST", "/api/payments/orders", {
  network: "preprod",
  amountUsd: "1.25",
  description: "Don thu hai",
});

if (second.status === 201) {
  const ref2 = second.json.order.ref;
  await api("POST", `/api/payments/orders/${ref2}/quote`, { unit: token.unit });

  // Cùng txHash, đơn khác. Metadata mang mã đơn CŨ nên phải bị chặn ngay ở điều kiện
  // đầu tiên — trước cả khi chạm tới ràng buộc UNIQUE ở tầng dữ liệu.
  const reuse = await api("POST", `/api/payments/orders/${ref2}/submit`, { txHash });
  assert("dùng lại txHash cho đơn khác => 422", reuse.status, 422);
  assertTrue(
    "lý do là metadata mang mã đơn khác",
    (reuse.json?.error ?? "").includes(ref),
  );

  const check2 = await api("GET", `/api/payments/orders/${ref2}`);
  assert("đơn thứ hai vẫn pending", check2.json?.order?.status, "pending");
}

console.log(`\n${"═".repeat(66)}`);
console.log(
  failures === 0 ? `Tất cả ${passes} kiểm tra đều đạt.` : `${failures} thất bại / ${passes + failures} kiểm tra.`,
);
process.exit(failures === 0 ? 0 : 1);
