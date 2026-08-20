/**
 * Mint 5 stablecoin GIẢ trên Preprod để thử luồng thanh toán.
 *
 *   npm run mint:test-stablecoins                  mint về chính ví mint
 *   npm run mint:test-stablecoins -- --to addr_test1…   mint về ví khác (vd Eternl của bạn)
 *   npm run mint:test-stablecoins -- --status      chỉ xem ví mint, không mint
 *
 * VÌ SAO CẦN
 * USDM/iUSD/DJED/USDA chỉ tồn tại trên mainnet — không ai vận hành chúng trên
 * testnet. Muốn thử trọn luồng thanh toán mà không tiêu tiền thật thì phải tự mint
 * token có cùng hình dạng (6 decimals, fungible) rồi khai vào STABLECOINS_PREPROD.
 *
 * Cả 5 token dùng CHUNG một policy native script "cần chữ ký của ví này" — đủ cho
 * mục đích thử, và không có gì bí ẩn: bất kỳ ai cũng mint được token trùng tên, đó
 * chính là lý do mainnet phải chốt policy id trong code.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import nextEnv from "@next/env";
import {
  BlockfrostProvider,
  ForgeScript,
  MeshWallet,
  resolveScriptHash,
  stringToHex,
  Transaction,
} from "@meshsdk/core";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
nextEnv.loadEnvConfig(projectDir, false, { info: () => {}, error: console.error });

const args = process.argv.slice(2);
const statusOnly = args.includes("--status");
const toIndex = args.indexOf("--to");
const recipientArg = toIndex >= 0 ? args[toIndex + 1] : undefined;

/** Mỗi token mint 1.000.000 đơn vị hiển thị, 6 decimals — thoải mái để test. */
const SUPPLY = 1_000_000n;

const TOKENS = [
  { assetName: "tUSDM", ticker: "tUSDM", label: "Test USDM", decimals: 6 },
  { assetName: "tiUSD", ticker: "tiUSD", label: "Test iUSD", decimals: 6 },
  { assetName: "tDJED", ticker: "tDJED", label: "Test DJED", decimals: 6 },
  { assetName: "tUSDA", ticker: "tUSDA", label: "Test USDA", decimals: 6 },
  // tUSDC khác bốn dòng trên: nó KHÔNG có bản thật trong danh mục mainnet ở
  // src/lib/stablecoins.ts, vì Cardano chưa có USDC native nào qua được hai nguồn
  // đối chiếu của `npm run resolve:stablecoins`. Ở đây nó chỉ là thêm một token cùng
  // hình dạng (6 decimals, fungible) để có cái mà thử — muốn đưa USDC lên mainnet thì
  // phải chạy script tra unit trước, không chép tay policy id từ đây sang.
  { assetName: "tUSDC", ticker: "tUSDC", label: "Test USDC", decimals: 6 },
];

/** Đủ cho phí + min-ADA của output mang 5 token. Dư ra để còn gửi đi thử. */
const MIN_ADA_NEEDED = 10_000_000n;

const FAUCET = "https://docs.cardano.org/cardano-testnets/tools/faucet/";

/* ------------------------------------------------------------------ */

// Key Blockfrost chỉ cần khi thật sự đọc số dư và gửi giao dịch. Policy id và dòng
// env suy ra được từ chính ví, nên `--status` chạy được trước khi có key.
const key = process.env.BLOCKFROST_API_KEY_PREPROD?.trim();
if (!statusOnly && (!key || !key.startsWith("preprod"))) {
  console.error(
    "Cần BLOCKFROST_API_KEY_PREPROD (project id bắt đầu bằng 'preprod').\n" +
      "Lấy miễn phí tại https://blockfrost.io — nhớ chọn đúng network Preprod.\n\n" +
      "Chưa có key vẫn xem trước được policy id và dòng env:\n" +
      "  npm run mint:test-stablecoins -- --status",
  );
  process.exit(1);
}

const words = process.env.MINT_MNEMONIC?.trim().split(/\s+/).filter(Boolean);

// Chưa có ví mint thì sinh một ví mới rồi DỪNG. Không tự ghi vào .env.local:
// seed phrase là bí mật, phải do người quyết định lưu ở đâu.
if (!words || words.length < 12) {
  const fresh = MeshWallet.brew();
  const temp = new MeshWallet({ networkId: 0, key: { type: "mnemonic", words: fresh } });

  console.log("Chưa có ví mint. Đã sinh một ví mới cho Preprod:\n");
  console.log(`  Địa chỉ:  ${temp.getChangeAddress()}\n`);
  console.log("Thêm dòng này vào .env.local (đây là ví TESTNET, nhưng vẫn đừng commit):\n");
  console.log(`MINT_MNEMONIC="${Array.isArray(fresh) ? fresh.join(" ") : fresh}"\n`);
  console.log(`Rồi xin ADA testnet cho địa chỉ trên tại:\n  ${FAUCET}\n`);
  console.log("Xong thì chạy lại lệnh này.");
  process.exit(0);
}

const provider = key ? new BlockfrostProvider(key) : undefined;
const wallet = new MeshWallet({
  networkId: 0,
  fetcher: provider,
  submitter: provider,
  key: { type: "mnemonic", words },
});

const changeAddress = wallet.getChangeAddress();
const recipient = recipientArg ?? changeAddress;

if (recipientArg && !recipientArg.startsWith("addr_test1")) {
  console.error(`--to phải là địa chỉ Preprod (addr_test1…), nhận được: ${recipientArg}`);
  process.exit(1);
}

// Policy: native script "cần chữ ký của ví mint". Policy id suy ra từ chính script
// nên tính trước được, không cần chờ giao dịch lên chain.
const forgeScript = ForgeScript.withOneSignature(changeAddress);
const policyId = resolveScriptHash(forgeScript);

console.log(`Ví mint:   ${changeAddress}`);
console.log(`Nhận về:   ${recipient}${recipientArg ? "" : "  (chính ví mint)"}`);
console.log(`Policy id: ${policyId}\n`);

/** Dòng env in ra cuối cùng — đây mới là thứ dùng được ngay. */
function envLine() {
  const entries = TOKENS.map((token) => ({
    symbol: token.ticker,
    label: token.label,
    unit: policyId + stringToHex(token.assetName),
    decimals: token.decimals,
  }));
  return `STABLECOINS_PREPROD=${JSON.stringify(entries)}`;
}

if (statusOnly) {
  console.log("Unit của từng token (suy ra từ policy id, chưa cần mint):\n");
  for (const token of TOKENS) {
    console.log(`  ${token.assetName.padEnd(6)} ${policyId}${stringToHex(token.assetName)}`);
  }
  console.log("\nDòng env cho registry:\n");
  console.log(envLine());
  process.exit(0);
}

let balance;
try {
  balance = await wallet.getBalance();
} catch (error) {
  console.error(`Không đọc được số dư qua Blockfrost: ${error.message}`);
  process.exit(1);
}

const lovelace = BigInt(balance.find((asset) => asset.unit === "lovelace")?.quantity ?? "0");
console.log(`Số dư:     ${(Number(lovelace) / 1e6).toFixed(6)} ADA`);

const existing = balance.filter((asset) => asset.unit.startsWith(policyId));
if (existing.length > 0) {
  console.log(`Đã mint trước đó: ${existing.length} token dưới policy này.`);
}

if (lovelace < MIN_ADA_NEEDED) {
  console.error(
    `\nKhông đủ ADA. Cần tối thiểu ${Number(MIN_ADA_NEEDED) / 1e6} ADA để trả phí và min-ADA.\n` +
      `Xin ADA testnet miễn phí cho ${changeAddress} tại:\n  ${FAUCET}`,
  );
  process.exit(1);
}

console.log(`\nMint ${SUPPLY.toLocaleString("en-US")} mỗi loại:`);
for (const token of TOKENS) console.log(`  ${token.assetName.padEnd(6)} ${token.decimals} decimals`);

/**
 * Giới hạn cứng của Cardano: mỗi chuỗi trong metadata tối đa 64 BYTE.
 *
 * Đơn vị là BYTE chứ không phải ký tự — một dòng tiếng Việt 57 ký tự đã là 71 byte.
 * Vi phạm thì Mesh ném `JsValue("Max metadata string too long: 71, max = 64")` lúc
 * dựng giao dịch, không nói là chuỗi nào, nên tự kiểm ở đây để chỉ đúng thủ phạm.
 */
const METADATA_MAX_BYTES = 64;

function assertMetadataFits(metadata, context) {
  for (const [key, value] of Object.entries(metadata)) {
    for (const [what, text] of [
      ["khoá", key],
      ["giá trị", typeof value === "string" ? value : null],
    ]) {
      if (text === null) continue;
      const bytes = Buffer.byteLength(text, "utf8");
      if (bytes > METADATA_MAX_BYTES) {
        console.error(
          `\nMetadata của ${context} vượt giới hạn: ${what} "${key}" dài ${bytes} byte ` +
            `(tối đa ${METADATA_MAX_BYTES}).\n  ${JSON.stringify(text)}\n` +
            "  Lưu ý đếm theo BYTE: tiếng Việt có dấu tốn 2–3 byte mỗi ký tự.",
        );
        process.exit(1);
      }
    }
  }
}

const tx = new Transaction({ initiator: wallet });

for (const token of TOKENS) {
  tx.mintAsset(forgeScript, {
    assetName: token.assetName,
    // Số lượng on-chain là số nguyên ở đơn vị nhỏ nhất — decimals chỉ là quy ước
    // hiển thị do metadata khai, chain không biết gì về nó.
    assetQuantity: (SUPPLY * 10n ** BigInt(token.decimals)).toString(),
    recipient,
  });
}

/**
 * Metadata nhãn 20 (fungible token) gắn MỘT LẦN cho cả 5 token.
 *
 * Không truyền `label`/`metadata` vào từng lời gọi `mintAsset`: một giao dịch chỉ có
 * một khối metadata cho mỗi nhãn, nên lần gọi sau ghi đè lần trước và cuối cùng chỉ
 * token cuối cùng còn metadata. Lần mint đầu tiên đã dính đúng lỗi này — trên chain
 * chỉ còn mỗi tUSDA.
 *
 * Cấu trúc bắt buộc: { policyId: { assetName: { … } } }.
 */
const ftMetadata = { [policyId]: {} };

for (const token of TOKENS) {
  const entry = {
    name: token.label,
    ticker: token.ticker,
    decimals: token.decimals,
    version: "1.0",
    // Đã kiểm giới hạn 64 byte bên dưới. Giữ ASCII: tiếng Việt có dấu tốn 2–3 byte
    // mỗi ký tự nên vượt ngưỡng rất nhanh mà nhìn vào không thấy dài.
    desc: "Test token for payment flow. No value.",
  };
  assertMetadataFits(entry, token.assetName);
  ftMetadata[policyId][token.assetName] = entry;
}

tx.setMetadata(20, ftMetadata);

try {
  console.log("\nDựng giao dịch…");
  const unsignedTx = await tx.build();

  console.log("Ký…");
  const signedTx = await wallet.signTx(unsignedTx);

  console.log("Gửi lên chain…");
  const txHash = await wallet.submitTx(signedTx);

  console.log(`\nXong. txHash: ${txHash}`);
  console.log(`  https://preprod.cardanoscan.io/transaction/${txHash}`);
  console.log("\nGiao dịch cần khoảng 20–60 giây để vào block.\n");
  console.log("Thêm dòng này vào .env.local rồi khởi động lại dev server:\n");
  console.log(envLine());
  console.log("\nKiểm tra lại bằng:  npm run verify:payment -- --infra");
} catch (error) {
  console.error(`\nMint thất bại: ${error.message ?? JSON.stringify(error)}`);
  process.exit(1);
}
