/**
 * Tra và ĐỐI CHIẾU `unit` thật của các stablecoin trên mainnet.
 *
 *   npm run resolve:stablecoins           in bảng chứng cứ
 *   npm run resolve:stablecoins -- --json in JSON để dán vào src/lib/stablecoins.ts
 *
 * VÌ SAO CẦN SCRIPT NÀY
 * Policy ID không được phép viết từ trí nhớ hay chép từ một bài blog. Sai một ký tự
 * nghĩa là hệ thống chấp nhận một token khác cùng tên — ai cũng mint được một token
 * tên "USDM", và nó sẽ hiện ra trong ví y hệt hàng thật.
 *
 * Hai nguồn độc lập phải cùng đồng ý thì mới nhận:
 *   1. Cardano Token Registry — repo có kiểm duyệt của Cardano Foundation, dùng để
 *      TÌM ra subject theo ticker.
 *   2. Blockfrost trên mainnet — dùng để XÁC NHẬN asset tồn tại thật, đang lưu hành,
 *      và metadata khớp với thứ registry khai.
 *
 * Script cố tình BÁO LỖI khi một ticker ra 0 hoặc nhiều hơn 1 ứng viên, thay vì tự
 * chọn giúp. Trùng ticker là chuyện có thật và phải do người quyết định.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import nextEnv from "@next/env";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
nextEnv.loadEnvConfig(projectDir, false, { info: () => {}, error: console.error });

const asJson = process.argv.includes("--json");

/**
 * Thứ chúng ta ĐANG TÌM, khai báo rõ ràng thay vì dò mò.
 *
 * `assetName` là tên asset đọc được, phải khớp CHÍNH XÁC — nếu chỉ so khớp một phần
 * thì các token pool của DEX ("DJED-USDM-SLP", "USDM-iUSD-SLP") cũng lọt vào.
 */
const TARGETS = [
  { symbol: "USDM", assetName: "USDM", label: "Moneta USDM", expectDecimals: 6 },
  { symbol: "iUSD", assetName: "iUSD", label: "Indigo iUSD", expectDecimals: 6 },
  { symbol: "DJED", assetName: "DjedMicroUSD", label: "COTI Djed", expectDecimals: 6 },
  { symbol: "USDA", assetName: "USDA", label: "Anzens USDA", expectDecimals: 6 },
];

const REGISTRY_TREE =
  "https://api.github.com/repos/cardano-foundation/cardano-token-registry/git/trees/master?recursive=1";

/* ------------------------------------------------------------------ */

function resolveMainnetKey() {
  const specific = process.env.BLOCKFROST_API_KEY_MAINNET?.trim();
  if (specific) {
    if (!specific.startsWith("mainnet")) {
      console.error("BLOCKFROST_API_KEY_MAINNET không phải key mainnet.");
      process.exit(1);
    }
    return specific;
  }

  const legacy = process.env.BLOCKFROST_API_KEY?.trim();
  if (legacy?.startsWith("mainnet")) return legacy;

  console.error(
    "Cần một Blockfrost key MAINNET để đối chiếu on-chain.\n" +
      "Đặt BLOCKFROST_API_KEY_MAINNET trong .env.local.",
  );
  process.exit(1);
}

const KEY = resolveMainnetKey();

async function blockfrost(pathname) {
  const res = await fetch(`https://cardano-mainnet.blockfrost.io/api/v0${pathname}`, {
    headers: { project_id: KEY },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Blockfrost ${pathname}: HTTP ${res.status}`);
  return res.json();
}

const toHex = (text) => Buffer.from(text, "utf8").toString("hex");

/**
 * Giải mã phần asset name của subject.
 *
 * CIP-68 gắn tiền tố nhãn 4 byte vào trước tên (USDM dùng `0014df10` = nhãn 333,
 * fungible token). Bỏ qua chuyện này thì USDM decode ra rác và không khớp gì cả.
 */
function decodeAssetName(hex) {
  const direct = Buffer.from(hex, "hex").toString("utf8");
  if (/^[\x20-\x7e]*$/.test(direct)) return { name: direct, cip68: false };

  if (hex.length > 8 && hex.startsWith("00")) {
    const stripped = Buffer.from(hex.slice(8), "hex").toString("utf8");
    if (/^[\x20-\x7e]+$/.test(stripped)) return { name: stripped, cip68: true, label: hex.slice(0, 8) };
  }

  return { name: null, cip68: false };
}

function formatSupply(quantity, decimals) {
  if (quantity === undefined || quantity === null) return "?";
  const value = BigInt(quantity);
  const divisor = 10n ** BigInt(decimals ?? 0);
  const whole = (value / divisor).toLocaleString("en-US");
  return decimals ? `${whole}` : whole;
}

/* ------------------------------------------------------------------ */

console.error("Tải Cardano Token Registry…");
const treeRes = await fetch(REGISTRY_TREE);
if (!treeRes.ok) {
  console.error(`Không tải được registry: HTTP ${treeRes.status}`);
  process.exit(1);
}
const tree = await treeRes.json();
if (tree.truncated) {
  console.error("CẢNH BÁO: cây thư mục bị cắt bớt, kết quả có thể thiếu.");
}

const subjects = tree.tree
  .filter((entry) => entry.path.startsWith("mappings/") && entry.path.endsWith(".json"))
  .map((entry) => entry.path.slice("mappings/".length, -".json".length));

console.error(`  ${subjects.length} subject trong registry\n`);

const resolved = [];
let problems = 0;

for (const target of TARGETS) {
  const wantedHex = toHex(target.assetName).toLowerCase();

  // Lọc thô bằng hex rồi mới so khớp chính xác tên đã giải mã — bước hai là bước
  // loại các token pool DEX có ticker nằm lồng trong tên.
  const candidates = subjects
    .filter((subject) => subject.toLowerCase().includes(wantedHex))
    .map((subject) => ({
      subject,
      policyId: subject.slice(0, 56),
      assetNameHex: subject.slice(56),
      ...decodeAssetName(subject.slice(56)),
    }))
    .filter((candidate) => candidate.name === target.assetName);

  console.log(`\n${"═".repeat(70)}`);
  console.log(`${target.symbol}  (${target.label})`);
  console.log("═".repeat(70));

  if (candidates.length === 0) {
    console.log("  KHÔNG TÌM THẤY trong token registry — cần tra tay.");
    problems++;
    continue;
  }
  if (candidates.length > 1) {
    console.log(`  ${candidates.length} ỨNG VIÊN TRÙNG TÊN — phải chọn tay:`);
    for (const candidate of candidates) console.log(`    ${candidate.subject}`);
    problems++;
    continue;
  }

  const [candidate] = candidates;
  const asset = await blockfrost(`/assets/${candidate.subject}`);

  if (!asset) {
    console.log(`  Registry có, nhưng Blockfrost KHÔNG THẤY asset này on-chain.`);
    problems++;
    continue;
  }

  const meta = asset.metadata ?? {};
  const decimals = typeof meta.decimals === "number" ? meta.decimals : 0;
  const tickerOk = !meta.ticker || meta.ticker === target.symbol;
  const decimalsOk = decimals === target.expectDecimals;

  console.log(`  policy id     ${candidate.policyId}`);
  console.log(`  asset name    ${candidate.assetNameHex}  -> "${candidate.name}"${candidate.cip68 ? `  (CIP-68, nhãn ${candidate.label})` : ""}`);
  console.log(`  unit          ${candidate.subject}`);
  console.log(`  registry name ${meta.name ?? "—"}`);
  console.log(`  ticker        ${meta.ticker ?? "—"}${tickerOk ? "" : "   ❗ KHÁC ticker mong đợi"}`);
  console.log(`  decimals      ${decimals}${decimalsOk ? "" : `   ❗ mong đợi ${target.expectDecimals}`}`);
  console.log(`  đang lưu hành ${formatSupply(asset.quantity, decimals)} ${meta.ticker ?? target.symbol}`);
  console.log(`  số lần mint   ${asset.mint_or_burn_count ?? "?"}`);
  console.log(`  url           ${meta.url ?? "—"}`);

  if (!tickerOk || !decimalsOk) problems++;

  resolved.push({
    symbol: target.symbol,
    label: meta.name ?? target.label,
    unit: candidate.subject,
    policyId: candidate.policyId,
    decimals,
  });
}

console.log(`\n${"═".repeat(70)}`);
console.log(`Tra được ${resolved.length}/${TARGETS.length}, ${problems} cần chú ý.`);

if (asJson) {
  console.log("\n// dán vào MAINNET_STABLECOINS trong src/lib/stablecoins.ts");
  console.log(JSON.stringify(resolved, null, 2));
}

process.exit(problems === 0 ? 0 : 1);
