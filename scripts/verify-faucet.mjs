/**
 * Kiểm chứng faucet qua HTTP, đúng cách trình duyệt gọi.
 *
 *   npm run verify:faucet                 kiểm tra trạng thái + các nhánh từ chối
 *   npm run verify:faucet -- --claim      xin thật một lượt về ví ngẫu nhiên (tốn ADA testnet)
 *   npm run verify:faucet -- --claim --to addr_test1…    xin về ví của bạn
 *   npm run verify:faucet -- http://localhost:3100
 *
 * Mặc định KHÔNG xin thật: mỗi lượt phát tiêu min-ADA + phí từ ví faucet, và chạy
 * kiểm thử không nên âm thầm rút cạn ví. Các nhánh từ chối (địa chỉ mainnet, địa chỉ
 * rác, token lạ) thì không tốn gì nên luôn chạy.
 *
 * Yêu cầu server đang chạy (npm run dev hoặc npm start).
 */
import { MeshWallet } from "@meshsdk/core";

const args = process.argv.slice(2);
const doClaim = args.includes("--claim");
const toIndex = args.indexOf("--to");
const recipientArg = toIndex >= 0 ? args[toIndex + 1] : undefined;
const BASE = args.find((arg) => arg.startsWith("http")) ?? "http://localhost:3000";

let failures = 0;

function assert(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`PASS  ${label}`);
  } else {
    failures++;
    console.log(
      `FAIL  ${label}\n      nhận: ${JSON.stringify(actual)}\n      chờ : ${JSON.stringify(expected)}`,
    );
  }
}

function note(text) {
  console.log(`      ${text}`);
}

console.log(`Base URL: ${BASE}\n`);

/* 1. Trạng thái ------------------------------------------------------ */

const statusRes = await fetch(`${BASE}/api/faucet`);
const status = await statusRes.json();

assert("GET /api/faucet trả 200", statusRes.status, 200);
assert("faucet chốt ở preprod", status.network, "preprod");

if (!status.enabled) {
  console.log("\nFaucet đang TẮT. Lý do server đưa ra:");
  for (const problem of status.problems ?? []) console.log(`  · ${problem}`);
  console.log("\nCác nhánh từ chối vẫn được kiểm tra bên dưới.\n");
} else {
  note(`ví faucet: ${status.address}`);
  note(`còn ${status.balanceAda} ADA${status.balanceLow ? "  (SẮP CẠN)" : ""}`);
  note(
    `mỗi lượt: ${(status.tokens ?? []).map((t) => `${t.amount} ${t.symbol}`).join(" · ")} + ${status.ada} ADA`,
  );
  note(`cooldown: ${status.cooldownSeconds}s mỗi địa chỉ`);
  assert(
    "mọi token đều phát được",
    (status.tokens ?? []).every((token) => token.available !== false),
    true,
  );
  console.log("");
}

/* 2. Các nhánh phải bị từ chối ---------------------------------------- */

async function claim(body) {
  const res = await fetch(`${BASE}/api/faucet/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

const noAddress = await claim({});
assert("thiếu address -> 400", noAddress.status, 400);

const junk = await claim({ address: "khong-phai-dia-chi" });
assert("địa chỉ rác -> 400", junk.status, 400);

// Địa chỉ mainnet hợp lệ về hình thức. Đây là nhánh quan trọng nhất trong file này:
// faucet không được phép coi một địa chỉ addr1… là hợp lệ ở BẤT KỲ hoàn cảnh nào.
const mainnetWallet = new MeshWallet({
  networkId: 1,
  key: { type: "mnemonic", words: MeshWallet.brew() },
});
const mainnet = await claim({ address: mainnetWallet.getChangeAddress() });
assert("địa chỉ mainnet -> 400", mainnet.status, 400);
note(`server nói: ${mainnet.data.error}`);

const testWallet = new MeshWallet({
  networkId: 0,
  key: { type: "mnemonic", words: MeshWallet.brew() },
});
const testAddress = testWallet.getChangeAddress();

const unknownUnit = await claim({ address: testAddress, units: ["deadbeef".repeat(7)] });
assert("token ngoài danh mục -> 400", unknownUnit.status, 400);

const badUnits = await claim({ address: testAddress, units: "khong-phai-mang" });
assert('"units" sai kiểu -> 400', badUnits.status, 400);

/* 3. Xin thật (chỉ khi có --claim) ------------------------------------ */

if (!doClaim) {
  console.log("\nBỏ qua lượt xin thật (thêm --claim để chạy).");
} else if (!status.enabled) {
  console.log("\nBỏ qua lượt xin thật: faucet đang tắt.");
} else {
  const recipient = recipientArg ?? testAddress;

  if (recipientArg && !recipientArg.startsWith("addr_test1")) {
    console.error(`--to phải là địa chỉ Preprod (addr_test1…), nhận được: ${recipientArg}`);
    process.exit(1);
  }

  console.log(`\nXin về ${recipient}${recipientArg ? "" : "  (ví ngẫu nhiên, token sẽ nằm đó vĩnh viễn)"}`);

  const result = await claim({ address: recipient });
  assert("xin lần đầu -> 201", result.status, 201);

  if (result.status === 201) {
    note(`txHash: ${result.data.txHash}`);
    note(result.data.explorerUrl);

    // Cooldown chỉ chứng minh được ở đây: xin ngay lần hai phải bị chặn. Cooldown ở
    // dev mặc định 60 giây nên nhánh này chạy nhanh.
    const again = await claim({ address: recipient });
    assert("xin lại ngay -> 429 (cooldown)", again.status, 429);
    note(`server nói: ${again.data.error}`);
  } else {
    note(`server nói: ${result.data.error}`);
  }
}

console.log(`\n${failures === 0 ? "Tất cả kiểm tra faucet đã pass." : `${failures} kiểm tra thất bại.`}`);
process.exit(failures === 0 ? 0 : 1);
