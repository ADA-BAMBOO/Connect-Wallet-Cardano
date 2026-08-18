/**
 * Kiểm chứng hạ tầng thanh toán (giai đoạn 1).
 *
 *   npm run verify:payment              chỉ phần logic thuần — không cần server, không cần DB
 *   npm run verify:payment -- --infra   thêm Postgres, Redis, Blockfrost (cần dev server chạy)
 *   npm run verify:payment -- --infra http://localhost:3100
 *
 * Phần logic import thẳng file .ts — Node 23+ tự bỏ kiểu, không cần bước build.
 * Phần hạ tầng đi qua HTTP tới /api/payments/health để kiểm tra đúng code chạy
 * trong runtime Next thật, giống cách verify:api đang làm.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

// @next/env là CommonJS và không khai báo named export cho Node ESM — phải lấy
// qua default import. Dùng chính loader của Next để thứ tự ưu tiên .env giống
// hệt lúc chạy `next dev`.
import nextEnv from "@next/env";

import {
  applyBps,
  ceilDiv,
  DEFAULT_TOLERANCE_BPS,
  formatAmount,
  lovelaceToUsd,
  minAcceptable,
  parseAmount,
  toBigInt,
  usdToLovelace,
  usdToStablecoin,
} from "../src/lib/money.ts";
import {
  addressMatchesCardanoNetwork,
  looksLikePaymentAddress,
  networkFromBlockfrostKey,
  networkMeta,
} from "../src/lib/network.ts";
import {
  ADA,
  findPayToken,
  getPayableTokens,
  getStablecoinRegistry,
  getStablecoins,
} from "../src/lib/stablecoins.ts";
import {
  ADA_USD_SOURCES,
  aggregateRates,
  evaluatePeg,
  median,
  parseRateToMicro,
  spreadBps,
} from "../src/lib/price-sources.ts";
import { generateRef, isValidRef, REF_ALPHABET } from "../src/lib/ref.ts";
import { clientIpFromForwarded, parseProxyHops } from "../src/lib/client-ip.ts";
import {
  confirmationsFor,
  extractPaymentRefs,
  paymentMemo,
  PAYMENT_METADATA_LABEL,
  sumToAddress,
  verifyPayment,
} from "../src/lib/payment-verify.ts";
import { ceilDiv as ceilDivForQuote } from "../src/lib/money.ts";

const projectDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
nextEnv.loadEnvConfig(projectDir, false, {
  info: () => {},
  error: console.error,
});

const args = process.argv.slice(2);
const withInfra = args.includes("--infra");
const BASE =
  args.find((arg) => arg.startsWith("http")) ?? "http://localhost:3000";

let failures = 0;
let passes = 0;

function assert(label, actual, expected) {
  const ok = String(actual) === String(expected);
  if (ok) {
    passes++;
    console.log(`PASS  ${label}`);
  } else {
    failures++;
    console.log(
      `FAIL  ${label}\n      nhận: ${actual}\n      chờ : ${expected}`,
    );
  }
}

function assertTrue(label, value) {
  assert(label, Boolean(value), true);
}

function section(title) {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 62 - title.length))}`);
}

/**
 * Dừng một nhánh kiểm thử khi điều kiện tiên quyết hỏng.
 *
 * Không có nó thì một lần tạo đơn thất bại sẽ sinh ra hai chục lỗi dây chuyền, và
 * nguyên nhân thật chìm nghỉm giữa đống lỗi hệ quả.
 */
class SkipRest extends Error {}

/**
 * Ở production, /health chỉ trả {ok, ready} và /watcher trả 401 nếu không có secret
 * — hai chốt chặn cố ý, vì cả hai endpoint đều không nên để công khai. Script gửi
 * kèm secret khi môi trường có, để kiểm được đầy đủ ở cả dev lẫn production build.
 */
const HEALTH_TOKEN = process.env.PAYMENT_HEALTH_TOKEN?.trim();
const WATCHER_SECRET = process.env.PAYMENT_WATCHER_SECRET?.trim();

const healthHeaders = () => (HEALTH_TOKEN ? { "x-health-token": HEALTH_TOKEN } : undefined);
const watcherHeaders = () => (WATCHER_SECRET ? { authorization: `Bearer ${WATCHER_SECRET}` } : undefined);

/* ================================================================== */
/* 1. money.ts — số học tiền tệ                                        */
/* ================================================================== */

section("money.ts — đọc & format");

assert("parseAmount 10 USD", parseAmount("10", 6), 10_000_000n);
assert("parseAmount 10.5 USD", parseAmount("10.5", 6), 10_500_000n);
assert("parseAmount đơn vị nhỏ nhất", parseAmount("0.000001", 6), 1n);
assert("parseAmount bỏ khoảng trắng", parseAmount("  2.25  ", 6), 2_250_000n);

// Đầu vào rác phải trả null, không được ném và không được trả 0 âm thầm.
assert(
  "parseAmount từ chối thừa số thập phân",
  parseAmount("1.1234567", 6),
  null,
);
assert("parseAmount từ chối số âm", parseAmount("-5", 6), null);
assert("parseAmount từ chối chuỗi rỗng", parseAmount("", 6), null);
assert("parseAmount từ chối dấu chấm đơn độc", parseAmount(".", 6), null);
assert("parseAmount từ chối chữ", parseAmount("abc", 6), null);
assert("parseAmount từ chối ký hiệu mũ", parseAmount("1e6", 6), null);
assert("parseAmount từ chối hai dấu chấm", parseAmount("1.2.3", 6), null);
assert("parseAmount chặn chuỗi quá dài", parseAmount("1".repeat(40), 6), null);

assert("formatAmount bỏ số 0 thừa", formatAmount(10_500_000n, 6), "10.5");
assert("formatAmount số nguyên", formatAmount(10_000_000n, 6), "10");
assert(
  "formatAmount ngăn cách nghìn",
  formatAmount(1_234_567_890n, 6),
  "1,234.56789",
);
assert("formatAmount số âm", formatAmount(-1_500_000n, 6), "-1.5");
assert(
  "formatAmount giữ số 0 khi trim=false",
  formatAmount(10_500_000n, 6, { trim: false }),
  "10.500000",
);

// Vòng tròn parse -> format phải khớp tuyệt đối, không được trôi chữ số.
assert(
  "parse/format khứ hồi",
  formatAmount(parseAmount("1234.567891", 6), 6),
  "1,234.567891",
);

section("money.ts — quy đổi");

assert("ceilDiv làm tròn lên", ceilDiv(7n, 2n), 4n);
assert("ceilDiv chia hết thì giữ nguyên", ceilDiv(6n, 2n), 3n);
assert("applyBps 99%", applyBps(10_000_000n, 9_900), 9_900_000n);

assert(
  "stablecoin 6 decimals là 1:1",
  usdToStablecoin(10_000_000n, 6),
  10_000_000n,
);
assert("stablecoin 8 decimals nhân lên", usdToStablecoin(1n, 8), 100n);
// decimals=0 nghĩa là token không chia nhỏ được: 10.5 USD phải làm tròn LÊN 11,
// vì làm tròn xuống là merchant nhận hụt.
assert(
  "stablecoin 0 decimals làm tròn lên",
  usdToStablecoin(10_500_000n, 0),
  11n,
);

// 10 USD ở tỷ giá 0.45 USD/ADA = 22.222223 ADA (làm tròn lên từ 22.2222222…).
assert(
  "usdToLovelace 10 USD @ 0.45",
  usdToLovelace(10_000_000n, 450_000n),
  22_222_223n,
);
assert(
  "lovelaceToUsd đảo lại",
  lovelaceToUsd(22_222_223n, 450_000n),
  10_000_000n,
);

assert("minAcceptable sai số 1%", minAcceptable(10_000_000n, 100), 9_900_000n);
assert(
  "minAcceptable sai số 0% giữ nguyên",
  minAcceptable(10_000_000n, 0),
  10_000_000n,
);
assert("sai số mặc định là 1%", DEFAULT_TOLERANCE_BPS, 100);

// Tính chất quan trọng nhất của toàn bộ phần quy đổi: đổi USD sang ADA rồi đổi
// ngược lại KHÔNG BAO GIỜ được ra ít hơn số USD ban đầu. Sai chiều làm tròn ở đây
// nghĩa là mỗi đơn hàng merchant chịu lỗ một chút, âm thầm, mãi mãi.
let roundTripOk = true;
let worstCase = null;
for (let i = 0; i < 2_000; i++) {
  const usd = BigInt(1 + Math.floor(Math.random() * 5_000_000_000)); // tới 5.000 USD
  const rate = BigInt(1_000 + Math.floor(Math.random() * 5_000_000)); // 0.001 .. 5 USD/ADA
  const back = lovelaceToUsd(usdToLovelace(usd, rate), rate);
  if (back < usd) {
    roundTripOk = false;
    worstCase = `usd=${usd} rate=${rate} -> ${back}`;
    break;
  }
}
assertTrue(
  `quy đổi USD→ADA→USD không bao giờ hụt (2000 mẫu)${worstCase ? ` — ${worstCase}` : ""}`,
  roundTripOk,
);

// Tỷ giá hỏng là lỗi cấu hình, phải ném chứ không được âm thầm ra 0.
let threwOnBadRate = false;
try {
  usdToLovelace(10_000_000n, 0n);
} catch {
  threwOnBadRate = true;
}
assertTrue("usdToLovelace ném lỗi khi tỷ giá = 0", threwOnBadRate);

assert(
  "toBigInt đọc chuỗi từ pg",
  toBigInt("9007199254740993"),
  9_007_199_254_740_993n,
);
let threwOnFloat = false;
try {
  toBigInt(1.5);
} catch {
  threwOnFloat = true;
}
assertTrue("toBigInt từ chối số thập phân", threwOnFloat);

/* ================================================================== */
/* 2. network.ts — chốt chặn nhầm mạng                                 */
/* ================================================================== */

section("network.ts — nhận diện mạng");

assert(
  "key preprod -> preprod",
  networkFromBlockfrostKey("preprodAbC123"),
  "preprod",
);
assert(
  "key mainnet -> mainnet",
  networkFromBlockfrostKey("mainnetAbC123"),
  "mainnet",
);
assert(
  "key preview -> preview",
  networkFromBlockfrostKey("previewAbC123"),
  "preview",
);
assert("key rác -> null", networkFromBlockfrostKey("xyz123"), null);

const MAINNET_ADDR =
  "addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp";
const TESTNET_ADDR =
  "addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x";

assertTrue(
  "addr1 khớp mainnet",
  addressMatchesCardanoNetwork(MAINNET_ADDR, "mainnet"),
);
assertTrue(
  "addr_test1 KHÔNG khớp mainnet",
  !addressMatchesCardanoNetwork(TESTNET_ADDR, "mainnet"),
);
assertTrue(
  "addr1 KHÔNG khớp preprod",
  !addressMatchesCardanoNetwork(MAINNET_ADDR, "preprod"),
);
assertTrue(
  "addr_test1 khớp preprod",
  addressMatchesCardanoNetwork(TESTNET_ADDR, "preprod"),
);

// Giới hạn đã biết: preprod và preview dùng chung prefix, địa chỉ không phân biệt
// được. Đây là lý do networkMagic tồn tại.
assertTrue(
  "addr_test1 khớp CẢ preview (giới hạn đã biết)",
  addressMatchesCardanoNetwork(TESTNET_ADDR, "preview"),
);

assertTrue(
  "looksLikePaymentAddress nhận addr1",
  looksLikePaymentAddress(MAINNET_ADDR),
);
assertTrue(
  "looksLikePaymentAddress từ chối stake address",
  !looksLikePaymentAddress("stake1u9abcdefghijklmnopqrstuvwxyz234567"),
);
assertTrue(
  "looksLikePaymentAddress từ chối chuỗi ngắn",
  !looksLikePaymentAddress("addr1q"),
);
assertTrue(
  "looksLikePaymentAddress từ chối rác",
  !looksLikePaymentAddress("khong-phai-dia-chi"),
);

assert("networkMagic mainnet", networkMeta("mainnet").networkMagic, 764824073);
assert("networkMagic preprod", networkMeta("preprod").networkMagic, 1);
assert("networkMagic preview", networkMeta("preview").networkMagic, 2);

/* ================================================================== */
/* 3. stablecoins.ts — danh mục token                                  */
/* ================================================================== */

section("stablecoins.ts — danh mục mainnet");

const mainnetTokens = getStablecoins("mainnet");
assert(
  "mainnet có đủ 4 stablecoin",
  mainnetTokens.map((t) => t.symbol).join(","),
  "USDM,iUSD,DJED,USDA",
);
assertTrue(
  "tất cả đều 6 decimals",
  mainnetTokens.every((t) => t.decimals === 6),
);
assertTrue(
  "tất cả đều neo 1:1",
  mainnetTokens.every((t) => t.pegged),
);
assertTrue(
  "tất cả đều là hằng số trong code",
  mainnetTokens.every((t) => t.source === "builtin"),
);
assertTrue(
  "unit đều là hex thường, tối thiểu 56 ký tự",
  mainnetTokens.every(
    (t) => /^[0-9a-f]{56,}$/.test(t.unit) && t.unit.length % 2 === 0,
  ),
);
assert(
  "không có unit trùng nhau",
  new Set(mainnetTokens.map((t) => t.unit)).size,
  mainnetTokens.length,
);

// Khoá cứng policy id đã tra được bằng `npm run resolve:stablecoins`. Test này tồn
// tại để một lần sửa tay nhầm tay không lọt qua review — ai cũng mint được token
// tên "USDM", chỉ policy id mới phân biệt được hàng thật.
const UNITS = Object.fromEntries(mainnetTokens.map((t) => [t.symbol, t.unit]));
assert(
  "USDM đúng policy đã đối chiếu (CIP-68)",
  UNITS.USDM,
  "c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad0014df105553444d",
);
assert(
  "iUSD đúng policy đã đối chiếu",
  UNITS.iUSD,
  "f66d78b4a3cb3d37afa0ec36461e51ecbde00f26c8f0a68f94b6988069555344",
);
assert(
  "DJED đúng policy đã đối chiếu (asset name DjedMicroUSD)",
  UNITS.DJED,
  "8db269c3ec630e06ae29f74bc39edd1f87c819f1056206e879a1cd61446a65644d6963726f555344",
);
assert(
  "USDA đúng policy đã đối chiếu",
  UNITS.USDA,
  "fe7c786ab321f41c654ef6c1af7b3250a613c24e4213e0425a7ae45655534441",
);

assert(
  "ADA luôn đứng đầu danh sách trả được",
  getPayableTokens("mainnet")[0].symbol,
  "ADA",
);
assert("ADA dùng unit 'lovelace' theo chuẩn CIP-30", ADA.unit, "lovelace");
assertTrue("ADA KHÔNG neo 1:1 (phải quy đổi theo tỷ giá)", !ADA.pegged);
assert(
  "tra token theo unit",
  findPayToken("mainnet", UNITS.USDM)?.symbol,
  "USDM",
);
assert("unit lạ trả về null", findPayToken("mainnet", "f".repeat(60)), null);
// Token của mainnet không được rò sang preprod — đó là cách đơn preprod bị đối chiếu
// nhầm với asset mainnet.
assert(
  "unit mainnet không tìm thấy ở preprod",
  findPayToken("preprod", UNITS.USDM),
  null,
);

section("stablecoins.ts — đọc đè từ env");

const savedEnv = process.env.STABLECOINS_PREPROD;
const savedMainnetEnv = process.env.STABLECOINS_MAINNET;

// Phần này phải KÍN với môi trường xung quanh: nó kiểm chính cơ chế đọc env, nên
// không được phụ thuộc vào .env.local của máy đang chạy. Ngay khi bạn mint token
// thử và điền STABLECOINS_PREPROD vào .env.local, mọi khẳng định "mặc định rỗng"
// sẽ sai — mà cái sai đó nằm ở bộ kiểm thử, không phải ở sản phẩm.
delete process.env.STABLECOINS_PREPROD;
delete process.env.STABLECOINS_MAINNET;

const TEST_UNIT =
  "5da40b87f282536039b1e9779fd51ccd9cc8a2a217f1535a6cf14321745553444d";

assert("preprod mặc định rỗng", getStablecoins("preprod").length, 0);
assert(
  "preprod vẫn trả được ADA",
  getPayableTokens("preprod")
    .map((t) => t.symbol)
    .join(","),
  "ADA",
);

// Đúng dạng chuỗi mà `npm run mint:test-stablecoins` in ra.
process.env.STABLECOINS_PREPROD = JSON.stringify([
  { symbol: "tUSDM", label: "Test USDM", unit: TEST_UNIT, decimals: 6 },
]);
let registry = getStablecoinRegistry("preprod");
assert("env thêm được token cho preprod", registry.tokens.length, 1);
assert("token từ env đánh dấu source=env", registry.tokens[0]?.source, "env");
assert("mặc định coi token env là neo 1:1", registry.tokens[0]?.pegged, true);
assert("không có cảnh báo với env hợp lệ", registry.issues.length, 0);
assert(
  "tra được token env theo unit",
  findPayToken("preprod", TEST_UNIT)?.symbol,
  "tUSDM",
);

// Env hỏng phải báo lý do, tuyệt đối không im lặng trả về danh sách rỗng.
process.env.STABLECOINS_PREPROD = "{khong-phai-json";
registry = getStablecoinRegistry("preprod");
assert("JSON hỏng => 0 token", registry.tokens.length, 0);
assert("JSON hỏng => có cảnh báo", registry.issues.length, 1);

process.env.STABLECOINS_PREPROD = JSON.stringify({ symbol: "tUSDM" });
assert(
  "env không phải mảng => có cảnh báo",
  getStablecoinRegistry("preprod").issues.length,
  1,
);

process.env.STABLECOINS_PREPROD = JSON.stringify([
  { symbol: "tOK", unit: TEST_UNIT, decimals: 6 },
  { symbol: "tHOA", unit: "KHONG-PHAI-HEX", decimals: 6 },
  { symbol: "tLE", unit: "a".repeat(56), decimals: 99 },
  { unit: "b".repeat(56), decimals: 6 },
]);
registry = getStablecoinRegistry("preprod");
assert(
  "dòng hỏng bị loại, dòng tốt vẫn giữ",
  registry.tokens.map((t) => t.symbol).join(","),
  "tOK",
);
assert("mỗi dòng hỏng một cảnh báo", registry.issues.length, 3);

process.env.STABLECOINS_PREPROD = JSON.stringify([
  { symbol: "tA", unit: TEST_UNIT, decimals: 6 },
  { symbol: "tB", unit: TEST_UNIT, decimals: 6 },
]);
assertTrue(
  "hai token trùng unit => cảnh báo",
  getStablecoinRegistry("preprod").issues.some((i) =>
    i.message.includes("trùng"),
  ),
);

// Ghi đè token mainnet là đổi chính policy id được coi là tiền thật. Cho phép,
// nhưng phải giương cờ để trang health hiện ra.
process.env.STABLECOINS_MAINNET = JSON.stringify([
  { symbol: "USDM", unit: "c".repeat(56) + "1234", decimals: 6 },
]);
registry = getStablecoinRegistry("mainnet");
assertTrue(
  "ghi đè token mainnet bị đánh dấu overridesBuiltin",
  registry.overridesBuiltin,
);
assert("ghi đè không làm mất các token còn lại", registry.tokens.length, 4);

// Trả env về nguyên trạng, không để rò sang phần kiểm tra sau.
if (savedEnv === undefined) delete process.env.STABLECOINS_PREPROD;
else process.env.STABLECOINS_PREPROD = savedEnv;
if (savedMainnetEnv === undefined) delete process.env.STABLECOINS_MAINNET;
else process.env.STABLECOINS_MAINNET = savedMainnetEnv;

assertTrue(
  "khôi phục env, mainnet trở lại 4 token dựng sẵn",
  getStablecoins("mainnet").every((t) => t.source === "builtin"),
);

/* ================================================================== */
/* 4. price-sources.ts — tỷ giá                                        */
/* ================================================================== */

section("price-sources.ts — đọc giá");

assert("đọc chuỗi thập phân", parseRateToMicro("0.45"), 450_000n);
assert("đọc số nguyên", parseRateToMicro("1"), 1_000_000n);
// CoinGecko trả JSON number chứ không phải chuỗi — không được mất chữ số nào.
assert("đọc JSON number của CoinGecko", parseRateToMicro(0.17304511), 173_045n);
// CẮT chứ không làm tròn: tỷ giá thấp đi một chút => người trả trả nhiều ADA hơn
// một chút, tức lệch về phía an toàn cho merchant.
assert(
  "cắt phần lẻ thừa, không làm tròn lên",
  parseRateToMicro("0.1234569"),
  123_456n,
);

assert("từ chối chuỗi rỗng", parseRateToMicro(""), null);
assert("từ chối chữ", parseRateToMicro("abc"), null);
assert("từ chối số âm", parseRateToMicro("-1"), null);
assert("từ chối ký hiệu mũ", parseRateToMicro("1e-7"), null);
assert("từ chối NaN", parseRateToMicro(NaN), null);
assert("từ chối null", parseRateToMicro(null), null);
assert("từ chối object", parseRateToMicro({ usd: 1 }), null);

section("price-sources.ts — parser từng sàn");

// Dữ liệu mẫu chép nguyên văn từ response thật, ngày 2026-08-18.
const FIXTURES = {
  coingecko: { cardano: { usd: 0.17304511 } },
  kraken: {
    error: [],
    result: {
      ADAUSD: {
        a: ["0.172914", "5784", "5784.000"],
        b: ["0.172911", "3470", "3470.000"],
        c: ["0.172912", "1445.82215200"],
        o: "0.173869",
      },
    },
  },
  coinbase: { data: { amount: "0.17293", base: "ADA", currency: "USD" } },
};

const sourceByName = Object.fromEntries(
  ADA_USD_SOURCES.map((s) => [s.name, s]),
);
assert("có đúng 3 nguồn giá", ADA_USD_SOURCES.length, 3);

assert(
  "parse CoinGecko",
  sourceByName.coingecko.parse(FIXTURES.coingecko),
  173_045n,
);
assert(
  "parse Kraken (giá khớp gần nhất)",
  sourceByName.kraken.parse(FIXTURES.kraken),
  172_912n,
);
assert(
  "parse Coinbase",
  sourceByName.coinbase.parse(FIXTURES.coinbase),
  172_930n,
);

// Đây mới là phần dễ hỏng âm thầm: API đổi hình dạng response. Phải ra null chứ
// tuyệt đối không được ra một con số vô nghĩa.
assert(
  "CoinGecko đổi hình dạng => null",
  sourceByName.coingecko.parse({ ada: { usd: 1 } }),
  null,
);
assert("CoinGecko trả rỗng => null", sourceByName.coingecko.parse({}), null);
assert(
  "Kraken báo lỗi => null",
  sourceByName.kraken.parse({ error: ["EQuery:Unknown asset pair"] }),
  null,
);
assert(
  "Kraken thiếu trường c => null",
  sourceByName.kraken.parse({ error: [], result: { ADAUSD: {} } }),
  null,
);
assert(
  "Coinbase sai loại tiền => null",
  sourceByName.coinbase.parse({ data: { amount: "1", currency: "EUR" } }),
  null,
);
assert(
  "Coinbase trả HTML/rác => null",
  sourceByName.coinbase.parse("<html>"),
  null,
);

section("price-sources.ts — gộp nguồn & fail-closed");

assert("trung vị 3 giá trị", median([100n, 300n, 200n]), 200n);
assert("trung vị 2 giá trị là trung bình", median([100n, 300n]), 200n);
assert("trung vị 1 giá trị", median([173_000n]), 173_000n);
assert("độ lệch tính theo bps của trung vị", spreadBps([99n, 100n, 101n]), 200);
assert("một giá trị thì lệch bằng 0", spreadBps([100n]), 0);

const threeGood = [
  { name: "coingecko", rate: 173_045n },
  { name: "kraken", rate: 172_912n },
  { name: "coinbase", rate: 172_930n },
];
const agg = aggregateRates(threeGood);
assertTrue("3 nguồn sát nhau => chấp nhận", agg.ok);
assert("lấy đúng trung vị", agg.rate, 172_930n);
assert(
  "ghi lại đủ tên nguồn",
  agg.sources.join(","),
  "coingecko,kraken,coinbase",
);

// Fail-closed #1: không đủ nguồn.
const oneGood = aggregateRates([
  { name: "coingecko", rate: 173_045n },
  { name: "kraken", rate: null, error: "HTTP 503" },
  { name: "coinbase", rate: null, error: "quá 4000ms" },
]);
assertTrue("chỉ 1 nguồn sống => TỪ CHỐI báo giá", !oneGood.ok);
assertTrue(
  "nói rõ thiếu bao nhiêu nguồn",
  oneGood.error.includes("tối thiểu 2"),
);
assert("ghi lại các nguồn bị loại", oneGood.rejected.length, 2);

// Fail-closed #2: các nguồn mâu thuẫn nhau => có nguồn hỏng, không được lấy trung vị.
const disagree = aggregateRates([
  { name: "coingecko", rate: 173_000n },
  { name: "kraken", rate: 250_000n },
]);
assertTrue("hai nguồn lệch 44% => TỪ CHỐI", !disagree.ok);
assertTrue("nói rõ vì lệch nhau", disagree.error.includes("lệch nhau"));

// Fail-closed #3: giá vô lý bị loại trước khi vào trung vị. Không có bước này thì
// một nguồn trả 0 sẽ kéo trung vị xuống và làm người trả phải trả ADA gấp bội.
const withGarbage = aggregateRates([
  { name: "coingecko", rate: 173_045n },
  { name: "kraken", rate: 172_912n },
  { name: "coinbase", rate: 0n },
]);
assertTrue("giá 0 bị loại nhưng vẫn đủ 2 nguồn => chấp nhận", withGarbage.ok);
assert("giá 0 không lọt vào trung vị", withGarbage.rate, 172_978n);
assert("giá 0 bị ghi vào danh sách loại", withGarbage.rejected.length, 1);

assertTrue(
  "giá kiểu Bitcoin (100k USD) bị coi là rác",
  !aggregateRates([
    { name: "a", rate: 100_000_000_000n },
    { name: "b", rate: 100_000_000_000n },
  ]).ok,
);

section("price-sources.ts — kiểm tra lệch peg");

assert("đúng 1 USD => lệch 0", evaluatePeg(1_000_000n).deviationBps, 0);
assert("0.99 USD => 100 bps, vẫn đạt", evaluatePeg(990_000n).state, "ok");
assert(
  "0.98 USD => đúng ngưỡng 200 bps, vẫn đạt",
  evaluatePeg(980_000n).state,
  "ok",
);
assert("0.97 USD => vượt ngưỡng", evaluatePeg(970_000n).state, "depegged");
assert(
  "1.05 USD => lệch lên cũng bị bắt",
  evaluatePeg(1_050_000n).state,
  "depegged",
);
// Thiếu dữ liệu KHÔNG phải là đạt peg — phải nói thẳng là chưa kiểm chứng được.
assert(
  "không có giá => unknown, không phải ok",
  evaluatePeg(null).state,
  "unknown",
);
assert("giá 0 => unknown", evaluatePeg(0n).state, "unknown");

assert("ngưỡng nới rộng thì chấp nhận", evaluatePeg(970_000n, 500).state, "ok");

section("stablecoins.ts — id CoinGecko đã đối chiếu");

// Tra bằng CONTRACT ADDRESS chứ không bằng ticker. Tra theo ticker "USDA" trên
// CoinGecko ra một token Binance Smart Chain, còn iUSD của Indigo thì không hiện ra.
const cgIds = Object.fromEntries(
  getStablecoins("mainnet").map((t) => [t.symbol, t.coingeckoId]),
);
assert("USDM -> usdm-2", cgIds.USDM, "usdm-2");
assert("iUSD -> iusd", cgIds.iUSD, "iusd");
assert("DJED -> djed", cgIds.DJED, "djed");
assert(
  "USDA -> anzens-usda (KHÔNG phải usda-2/usda-3 của BSC)",
  cgIds.USDA,
  "anzens-usda",
);

/* ================================================================== */
/* 5. ref.ts — mã đơn hàng                                             */
/* ================================================================== */

section("ref.ts — sinh mã đơn");

assert("bảng chữ cái có 59 ký tự", REF_ALPHABET.length, 59);
// Bỏ ký tự dễ nhìn nhầm, giữ chữ số: mã đơn bị đọc to và chép tay từ hoá đơn.
for (const ch of ["I", "O", "l"]) {
  assertTrue(`bảng chữ cái không chứa "${ch}"`, !REF_ALPHABET.includes(ch));
}
for (const ch of ["1", "0"]) {
  assertTrue(`bảng chữ cái vẫn giữ "${ch}"`, REF_ALPHABET.includes(ch));
}
assert("không có ký tự lặp", new Set(REF_ALPHABET).size, REF_ALPHABET.length);

const refs = Array.from({ length: 500 }, () => generateRef());
assertTrue(
  "mọi mã đều dài 8",
  refs.every((r) => r.length === 8),
);
assertTrue(
  "mọi mã đều chỉ dùng ký tự trong bảng",
  refs.every((r) => [...r].every((c) => REF_ALPHABET.includes(c))),
);
// Nếu bảng chữ cái và ràng buộc CHECK của Postgres lệch nhau thì mã sinh ra sẽ bị
// DB từ chối — cả hai dùng chung một biểu thức, test này khoá điều đó lại.
assertTrue(
  "mọi mã đều qua được isValidRef (cùng regex với CHECK ở DB)",
  refs.every(isValidRef),
);
assertTrue("500 mã không trùng nhau", new Set(refs).size === 500);

assertTrue("từ chối mã quá ngắn", !isValidRef("abc"));
assertTrue("từ chối mã quá dài", !isValidRef("a".repeat(33)));
assertTrue("từ chối ký tự dễ nhầm", !isValidRef("ZZTESTI1"));
assertTrue("từ chối khoảng trắng", !isValidRef("ZZ TEST1"));
assertTrue("từ chối chuỗi rỗng", !isValidRef(""));
assertTrue("từ chối không phải chuỗi", !isValidRef(12345678));

/* ================================================================== */
/* 6. payment-verify.ts — đối chiếu on-chain                           */
/* ================================================================== */

section("payment-verify.ts — đọc metadata");

assert("nhãn CIP-20 là 674", PAYMENT_METADATA_LABEL, 674);
assert("nội dung nhúng vào giao dịch", paymentMemo("ABC12345"), "pay:ABC12345");

const meta = (json, label = "674") => [{ label, json_metadata: json }];

assert(
  "dạng chuẩn { msg: [...] }",
  extractPaymentRefs(meta({ msg: ["pay:ABC12345"] })).join(","),
  "ABC12345",
);
// Ví và thư viện ngoài kia ghi metadata mỗi nơi một kiểu. Nới ở khâu ĐỌC thì an toàn:
// nó chỉ giúp nhận ra khoản trả hợp lệ, phần siết chặt nằm ở địa chỉ và số lượng.
assert("chuỗi trần", extractPaymentRefs(meta("pay:ABC12345")).join(","), "ABC12345");
assert("msg là chuỗi, không phải mảng", extractPaymentRefs(meta({ msg: "pay:ABC12345" })).join(","), "ABC12345");
assert("nhãn dạng số cũng nhận", extractPaymentRefs(meta({ msg: ["pay:ABC12345"] }, 674)).join(","), "ABC12345");
assert(
  "nhiều dòng msg, lấy đúng dòng có mã",
  extractPaymentRefs(meta({ msg: ["Xin chao", "pay:ABC12345", "cam on"] })).join(","),
  "ABC12345",
);

assert("nhãn khác 674 bị bỏ qua", extractPaymentRefs(meta({ msg: ["pay:ABC12345"] }, "721")).length, 0);
assert("không có metadata", extractPaymentRefs(null).length, 0);
assert("metadata rỗng", extractPaymentRefs([]).length, 0);
assert("thiếu tiền tố pay:", extractPaymentRefs(meta({ msg: ["ABC12345"] })).length, 0);
assert("mã có ký tự dễ nhầm bị loại", extractPaymentRefs(meta({ msg: ["pay:ABCI2345"] })).length, 0);
assert("msg không phải chuỗi", extractPaymentRefs(meta({ msg: [{ a: 1 }] })).length, 0);
assert("json_metadata là số", extractPaymentRefs(meta(12345)).length, 0);

section("payment-verify.ts — cộng output");

const MERCHANT = "addr_test1qmerchant";
const OTHER = "addr_test1qkhac";
const TOKEN = "765a4861965da09328f6e94092a0392f83313d1227247420fc290eea745553444d";

const out = (address, amounts, extra = {}) => ({
  address,
  amount: amounts.map(([unit, quantity]) => ({ unit, quantity: String(quantity) })),
  ...extra,
});

assert(
  "cộng đúng một output",
  sumToAddress([out(MERCHANT, [["lovelace", 5_000_000]])], MERCHANT, "lovelace"),
  5_000_000n,
);
// Chia tiền thành nhiều output là hợp lệ. Chỉ nhìn output đầu là kết luận nhầm trả thiếu.
assert(
  "cộng nhiều output cùng địa chỉ",
  sumToAddress(
    [out(MERCHANT, [["lovelace", 3_000_000]]), out(MERCHANT, [["lovelace", 2_000_000]])],
    MERCHANT,
    "lovelace",
  ),
  5_000_000n,
);
assert(
  "bỏ qua output tới địa chỉ khác",
  sumToAddress(
    [out(MERCHANT, [["lovelace", 3_000_000]]), out(OTHER, [["lovelace", 99_000_000]])],
    MERCHANT,
    "lovelace",
  ),
  3_000_000n,
);
// Output collateral của giao dịch Plutus thất bại không phải tiền thanh toán.
assert(
  "bỏ qua output collateral",
  sumToAddress(
    [out(MERCHANT, [["lovelace", 9_000_000]], { collateral: true })],
    MERCHANT,
    "lovelace",
  ),
  0n,
);
// Output mang token luôn kèm min-ADA — không được tính nhầm phần ADA đó là tiền trả.
assert(
  "chỉ cộng đúng token cần, bỏ qua min-ADA đi kèm",
  sumToAddress([out(MERCHANT, [["lovelace", 1_200_000], [TOKEN, 12_340_000]])], MERCHANT, TOKEN),
  12_340_000n,
);
assert("không có output nào", sumToAddress(null, MERCHANT, "lovelace"), 0n);
assert(
  "số lượng hỏng bị bỏ qua, không đoán",
  sumToAddress([out(MERCHANT, [["lovelace", "khong-phai-so"]])], MERCHANT, "lovelace"),
  0n,
);

assert("trong block mới nhất = 1 xác nhận", confirmationsFor(100, 100), 1);
assert("cách 2 block = 3 xác nhận", confirmationsFor(98, 100), 3);
assert("chưa vào block = 0", confirmationsFor(null, 100), 0);

section("payment-verify.ts — bốn điều kiện");

const REF = "ABC12345";
const REQUIRED = 12_340_000n;
const MIN = 12_216_600n; // sai số 1%

// Mốc thời gian dùng chung cho các case liên quan tới hạn báo giá.
const NOW_MS = Date.UTC(2026, 0, 1, 12, 0, 0);
const BLOCK_TIME = Math.floor(NOW_MS / 1_000) - 60; // tiền về cách đây 1 phút

const base = {
  ref: REF,
  merchantAddress: MERCHANT,
  payUnit: "lovelace",
  requiredQuantity: REQUIRED,
  minQuantity: MIN,
  requiredConfirmations: 3,
  quoteExpiresAtMs: null, // stablecoin: không có tỷ giá nào để hết hạn
  nowMs: NOW_MS,
  tx: { block_height: 98, block_time: BLOCK_TIME, valid_contract: true },
  outputs: [out(MERCHANT, [["lovelace", REQUIRED]])],
  metadata: meta({ msg: [`pay:${REF}`] }),
  latestBlockHeight: 100,
};

assert("đủ 4 điều kiện => confirmed", verifyPayment(base).state, "confirmed");
assert("ghi lại số nhận được", verifyPayment(base).received, REQUIRED);

assert("chưa lên chain => not_found", verifyPayment({ ...base, tx: null }).state, "not_found");

// Script thất bại: chain chỉ tiêu collateral, không có khoản trả nào.
assert(
  "giao dịch script thất bại => rejected",
  verifyPayment({ ...base, tx: { block_height: 98, valid_contract: false } }).state,
  "rejected",
);

// ĐÂY LÀ CHỐT CHẶN QUAN TRỌNG NHẤT: không có nó, kẻ tấn công chỉ cần khai lại txHash
// của một khoản trả cho đơn khác là chiếm được đơn này.
const noMeta = verifyPayment({ ...base, metadata: null });
assert("không có metadata => rejected", noMeta.state, "rejected");
assertTrue("nói rõ thiếu metadata nào", noMeta.reason.includes(`pay:${REF}`));

const wrongRef = verifyPayment({ ...base, metadata: meta({ msg: ["pay:ZZZZ9999"] }) });
assert("metadata mang mã đơn KHÁC => rejected", wrongRef.state, "rejected");
assertTrue("chỉ rõ mã đơn lạ là gì", wrongRef.reason.includes("ZZZZ9999"));

// Trả đúng số tiền nhưng vào ví người khác.
const wrongAddr = verifyPayment({ ...base, outputs: [out(OTHER, [["lovelace", REQUIRED]])] });
assert("trả về địa chỉ khác => rejected", wrongAddr.state, "rejected");

// Trả đúng số nhưng bằng token khác.
assert(
  "trả sai token => rejected",
  verifyPayment({ ...base, outputs: [out(MERCHANT, [[TOKEN, REQUIRED]])] }).state,
  "rejected",
);

const under = verifyPayment({
  ...base,
  outputs: [out(MERCHANT, [["lovelace", 11_000_000]])],
});
assert("trả thiếu quá sai số => underpaid", under.state, "underpaid");
assert("tính đúng phần còn thiếu", under.shortfall, REQUIRED - 11_000_000n);
assertTrue("underpaid KHÔNG phải confirmed", under.state !== "confirmed");

// Sai số 1% tồn tại để không đánh trượt người trả vì chênh lệch làm tròn.
assert(
  "thiếu trong phạm vi sai số 1% => vẫn chấp nhận",
  verifyPayment({ ...base, outputs: [out(MERCHANT, [["lovelace", MIN]])] }).state,
  "confirmed",
);
assert(
  "thiếu 1 đơn vị dưới ngưỡng => underpaid",
  verifyPayment({ ...base, outputs: [out(MERCHANT, [["lovelace", MIN - 1n]])] }).state,
  "underpaid",
);
assert(
  "trả dư => vẫn chấp nhận",
  verifyPayment({ ...base, outputs: [out(MERCHANT, [["lovelace", REQUIRED * 2n]])] }).state,
  "confirmed",
);

// Chưa đủ xác nhận thì mới chỉ là `seen` — reorg vẫn xoá được giao dịch.
assert(
  "mới vào block, 1 xác nhận => seen",
  verifyPayment({ ...base, latestBlockHeight: 98 }).state,
  "seen",
);
assert(
  "2 xác nhận, ngưỡng 3 => vẫn seen",
  verifyPayment({ ...base, latestBlockHeight: 99 }).state,
  "seen",
);
assert(
  "không biết block mới nhất => seen chứ không confirmed",
  verifyPayment({ ...base, latestBlockHeight: null }).state,
  "seen",
);

// Gộp nhiều output lại mới đủ tiền.
assert(
  "trả tách làm hai output => cộng lại vẫn đủ",
  verifyPayment({
    ...base,
    outputs: [
      out(MERCHANT, [["lovelace", 6_000_000]]),
      out(MERCHANT, [["lovelace", 6_340_000]]),
    ],
  }).state,
  "confirmed",
);

// Thanh toán bằng stablecoin: output kèm min-ADA, chỉ đếm phần token.
assert(
  "trả bằng token => chỉ đếm token, bỏ qua min-ADA",
  verifyPayment({
    ...base,
    payUnit: TOKEN,
    outputs: [out(MERCHANT, [["lovelace", 1_200_000], [TOKEN, REQUIRED]])],
  }).state,
  "confirmed",
);

section("client-ip.ts — đọc x-forwarded-for");

/*
 * VÌ SAO PHẢI CÓ: `x-forwarded-for` là header CLIENT gửi được. Lấy phần tử đầu (cách
 * viết phổ biến nhất) chỉ đúng khi có đúng một proxy và client không gửi sẵn header —
 * ngoài ra thì client chỉ cần gửi một giá trị ngẫu nhiên mỗi request là mỗi request rơi
 * vào một bucket khác nhau, và hạn mức biến mất hoàn toàn.
 */

// Một proxy (nginx). Client không gửi gì -> nginx ghi đúng IP thật.
assert("1 hop, client sạch", clientIpFromForwarded("203.0.113.7", 1), "203.0.113.7");

// Client bịa sẵn một IP; nginx nối IP thật vào CUỐI. Phần tử đầu là thứ client bịa.
assert(
  "1 hop, client giả header => vẫn ra IP thật",
  clientIpFromForwarded("1.2.3.4, 203.0.113.7", 1),
  "203.0.113.7",
);

// Cloudflare rồi nginx: [client bịa, IP thật, IP của Cloudflare].
assert(
  "2 hop, client giả header => vẫn ra IP thật",
  clientIpFromForwarded("1.2.3.4, 203.0.113.7, 198.51.100.1", 2),
  "203.0.113.7",
);

// Kẻ tấn công rải nhiều phần tử để đẩy IP thật ra khỏi vị trí — vị trí tính từ CUỐI
// nên số phần tử họ nhồi vào bao nhiêu cũng không đổi được kết quả.
assert(
  "nhồi thêm phần tử không đổi được kết quả",
  clientIpFromForwarded("a, b, c, d, e, 203.0.113.7", 1),
  "203.0.113.7",
);

assert("khoảng trắng thừa bị cắt", clientIpFromForwarded("  1.2.3.4 ,  203.0.113.7  ", 1), "203.0.113.7");
assert("phần tử rỗng bị bỏ qua", clientIpFromForwarded("1.2.3.4, , 203.0.113.7", 1), "203.0.113.7");

// Chuỗi ngắn hơn số hop đã khai: cấu hình sai hoặc có người cắt header. Đoán bừa một
// phần tử ở đây là tự nhận một giá trị do client kiểm soát.
assert("chuỗi ngắn hơn số hop => null", clientIpFromForwarded("203.0.113.7", 2), null);
assert("không có header => null", clientIpFromForwarded(null, 1), null);
assert("header rỗng => null", clientIpFromForwarded("", 1), null);

// Chưa khai proxy nào thì header hoàn toàn không đáng tin.
assert("0 hop => null dù có header", clientIpFromForwarded("203.0.113.7", 0), null);
assert("hop âm => null", clientIpFromForwarded("203.0.113.7", -1), null);

assert("bỏ trống => 0 hop", parseProxyHops(undefined), 0);
assert("chuỗi rỗng => 0 hop", parseProxyHops("   "), 0);
assert("số hợp lệ", parseProxyHops("2"), 2);
assert("số thập phân => null", parseProxyHops("1.5"), null);
assert("không phải số => null", parseProxyHops("nginx"), null);
assert("vượt ngưỡng => null", parseProxyHops("99"), null);

section("payment-verify.ts — hạn của tỷ giá đã khoá");

/*
 * VÌ SAO PHẢI CÓ: `pay_quantity` được khoá theo tỷ giá tại lúc chọn token, hạn 15 phút.
 * Nhưng hạn của cả ĐƠN mặc định là 24 giờ. Nếu khâu xác minh không đọc quote_expires_at
 * thì người trả khoá 1.000 ADA lúc ADA = 1 USD, ngồi đợi ADA rơi xuống 0,70 USD, rồi trả
 * đúng 1.000 ADA — và đơn 1.000 USD vẫn thành `confirmed` với 700 USD thật sự nhận được.
 * Đó là một quyền chọn ADA kỳ hạn 24 giờ, miễn phí, mà người bán vô tình phát hành.
 */

const QUOTE_EXPIRES = NOW_MS - 10 * 60_000; // tỷ giá hết hạn 10 phút trước
const inQuote = { ...base, quoteExpiresAtMs: NOW_MS + 10 * 60_000 };

assert(
  "trả trong hạn báo giá => confirmed",
  verifyPayment(inQuote).state,
  "confirmed",
);

const stale = verifyPayment({ ...base, quoteExpiresAtMs: QUOTE_EXPIRES });
assert("trả sau khi báo giá hết hạn => stale_quote", stale.state, "stale_quote");
assertTrue("stale_quote KHÔNG phải confirmed", stale.state !== "confirmed");
assert("vẫn ghi lại số đã nhận được", stale.received, REQUIRED);
assert("ghi lại tiền về lúc nào", stale.paidAtMs, BLOCK_TIME * 1_000);

// Mốc so sánh phải là block_time chứ không phải lúc server chạy: watcher có thể quét
// muộn hàng giờ sau khi giao dịch vào block, lấy now() sẽ đánh trượt oan người trả đúng hạn.
assert(
  "quét muộn nhưng tiền về đúng hạn => vẫn confirmed",
  verifyPayment({
    ...base,
    quoteExpiresAtMs: BLOCK_TIME * 1_000 + 1_000,
    nowMs: NOW_MS + 6 * 3_600_000,
  }).state,
  "confirmed",
);

// Đúng khoảnh khắc hết hạn vẫn được tính là trong hạn — chỉ VƯỢT qua mới bị chặn.
assert(
  "tiền về đúng giây hết hạn => vẫn confirmed",
  verifyPayment({ ...base, quoteExpiresAtMs: BLOCK_TIME * 1_000 }).state,
  "confirmed",
);

// Thiếu block_time thì phải nghiêng về phía nghi ngờ. Bỏ qua ở đây là mở lại đúng
// lỗ hổng mà nhánh này sinh ra để bịt.
assert(
  "vào block nhưng thiếu block_time => lấy now(), vẫn bắt được",
  verifyPayment({
    ...base,
    tx: { block_height: 98, valid_contract: true },
    quoteExpiresAtMs: QUOTE_EXPIRES,
  }).state,
  "stale_quote",
);

// Stablecoin quy ước 1:1 nên không có tỷ giá nào để hết hạn — không được vạ lây.
assert(
  "stablecoin (quoteExpiresAtMs = null) => không bao giờ stale",
  verifyPayment({
    ...base,
    payUnit: TOKEN,
    outputs: [out(MERCHANT, [["lovelace", 1_200_000], [TOKEN, REQUIRED]])],
    quoteExpiresAtMs: null,
  }).state,
  "confirmed",
);

// Trả thiếu VÀ quá hạn: `underpaid` là sự thật cụ thể hơn nên nó thắng.
assert(
  "vừa thiếu vừa quá hạn => underpaid",
  verifyPayment({
    ...base,
    outputs: [out(MERCHANT, [["lovelace", 11_000_000]])],
    quoteExpiresAtMs: QUOTE_EXPIRES,
  }).state,
  "underpaid",
);

// Chưa vào block thì chưa có block_time — chưa kết luận được gì về hạn.
assert(
  "chưa vào block => not_found, không phải stale_quote",
  verifyPayment({ ...base, tx: null, quoteExpiresAtMs: QUOTE_EXPIRES }).state,
  "not_found",
);

/* ================================================================== */
/* 7. Hạ tầng (chỉ khi --infra)                                        */
/* ================================================================== */

if (withInfra) {
  section(`hạ tầng qua ${BASE}/api/payments/health`);

  let health = null;
  try {
    const response = await fetch(`${BASE}/api/payments/health`, { headers: healthHeaders() });
    health = await response.json();
    assertTrue(
      `health trả JSON (HTTP ${response.status})`,
      health && typeof health === "object",
    );
  } catch (error) {
    failures++;
    console.log(
      `FAIL  không gọi được ${BASE}/api/payments/health\n      ${error.message}\n` +
        "      Server chưa chạy? Mở terminal khác: npm run dev",
    );
  }

  // Không có `database` nghĩa là server trả bản rút gọn: đang chạy production mà
  // thiếu PAYMENT_HEALTH_TOKEN. Nói rõ ra thay vì đổ một tràng lỗi vô nghĩa.
  if (health && health.database === undefined) {
    console.log(
      `SKIP  /health trả bản rút gọn (ok=${health.ok}, ready=${health.ready}).\n` +
        "      Đặt PAYMENT_HEALTH_TOKEN ở cả server lẫn môi trường chạy script để xem chi tiết.",
    );
    assertTrue(`hạ tầng báo ok=${health.ok}`, health.ok);
    assertTrue(`sẵn sàng nhận thanh toán: ready=${health.ready}`, health.ready);
    health = null;
  }

  if (health) {
    assertTrue(
      `Postgres kết nối được — ${health.database?.detail ?? "?"}`,
      health.database?.ok,
    );
    assertTrue(
      `Redis kết nối được — ${health.redis?.detail ?? "?"}`,
      health.redis?.ok,
    );

    const migrations = health.database?.migrations ?? [];
    assertTrue(
      `migration 001 đã áp dụng (${migrations.length} file)`,
      migrations.includes("001_payment_orders.sql"),
    );

    assert(
      "hạn khoá giá mặc định 15 phút",
      health.params?.quoteTtlSeconds,
      900,
    );
    assert("sai số mặc định 100 bps", health.params?.toleranceBps, 100);
    assert(
      "số xác nhận mặc định 3 block",
      health.params?.requiredConfirmations,
      3,
    );

    console.log("\n      Trạng thái từng mạng:");
    for (const entry of health.networks ?? []) {
      const mark = entry.enabled ? "BẬT " : "tắt ";
      const tokens = (entry.tokens ?? []).map((t) => t.symbol).join(", ");
      console.log(
        `      ${mark} ${entry.network.padEnd(8)} ${entry.blockfrost?.detail ?? ""}`,
      );
      console.log(`             token: ${tokens || "—"}`);
      for (const problem of entry.problems ?? [])
        console.log(`             · ${problem}`);
      for (const issue of entry.registryIssues ?? [])
        console.log(`             ! ${issue}`);
    }

    /* --- Tỷ giá thật --- */
    const rate = health.adaRate ?? {};
    assertTrue(
      `lấy được tỷ giá ADA/USD — ${rate.usdPerAda ?? rate.error ?? "?"}`,
      rate.ok,
    );

    if (rate.ok) {
      const micro = BigInt(rate.microUsdPerAda);
      assertTrue(
        `tỷ giá nằm trong khoảng hợp lý (${rate.usdPerAda} USD/ADA)`,
        micro >= 100n && micro <= 1_000_000_000n,
      );
      assertTrue(
        `đủ tối thiểu 2 nguồn — dùng ${rate.sources?.length}: ${(rate.sources ?? []).join(", ")}`,
        (rate.sources ?? []).length >= 2,
      );
      assertTrue(
        `các nguồn lệch nhau ${rate.spreadBps} bps, dưới ngưỡng 300`,
        rate.spreadBps <= 300,
      );

      // Gọi lần hai phải trúng cache Redis, không được hỏi lại sàn.
      const again = await fetch(`${BASE}/api/payments/health`, {
        headers: healthHeaders(),
      }).then((r) => r.json());
      assert(
        "gọi lại trúng cache (cùng fetchedAt)",
        again.adaRate?.fetchedAt,
        rate.fetchedAt,
      );
      assert("gọi lại được đánh dấu cached", again.adaRate?.cached, true);
    }

    /* --- Peg --- */
    const mainnetPeg =
      (health.networks ?? []).find((e) => e.network === "mainnet")?.peg ?? [];
    assert("kiểm peg cho cả 4 stablecoin mainnet", mainnetPeg.length, 4);
    assertTrue(
      "mỗi token có trạng thái peg xác định",
      mainnetPeg.every((p) => ["ok", "depegged", "unknown"].includes(p.state)),
    );
    // Thiếu dữ liệu không được ngầm hiểu là đạt peg.
    assertTrue(
      "token 'unknown' luôn kèm lý do",
      mainnetPeg.every((p) => p.state !== "unknown" || Boolean(p.reason)),
    );
    assertTrue(
      "chỉ token 'depegged' mới bị loại khỏi checkout",
      mainnetPeg.every((p) => p.acceptable === (p.state !== "depegged")),
    );

    console.log("\n      Peg mainnet:");
    for (const p of mainnetPeg) {
      const detail =
        p.state === "unknown"
          ? p.reason
          : `lệch ${(p.deviationBps / 100).toFixed(2)}%`;
      console.log(
        `      ${p.acceptable ? "nhận " : "TẮT  "} ${p.symbol.padEnd(5)} ${p.state.padEnd(9)} ${detail}`,
      );
    }

    const mainnetTokensLive =
      (health.networks ?? []).find((e) => e.network === "mainnet")?.tokens ??
      [];
    assert(
      "health liệt kê ADA + 4 stablecoin trên mainnet",
      mainnetTokensLive.map((t) => t.symbol).join(","),
      "ADA,USDM,iUSD,DJED,USDA",
    );
    assertTrue(
      "không mạng nào có cảnh báo registry",
      (health.networks ?? []).every(
        (e) => (e.registryIssues ?? []).length === 0,
      ),
    );
    assertTrue(
      "không mạng nào đang ghi đè token dựng sẵn",
      (health.networks ?? []).every((e) => !e.registryOverridesBuiltin),
    );

    // Mạng bị tắt phải nói ĐỦ mọi lý do. Dừng ở lý do đầu tiên từng che mất lỗi
    // "Blockfrost key trỏ nhầm mạng" đằng sau một lỗi vặt như thiếu địa chỉ merchant
    // — mà lỗi bị che mới là lỗi làm mất tiền.
    const problemsReported = (health.networks ?? []).every((entry) =>
      entry.enabled
        ? (entry.problems ?? []).length === 0
        : Array.isArray(entry.problems) && entry.problems.length > 0,
    );
    assertTrue(
      "mạng bị tắt liệt kê đủ mọi lý do, không dừng ở lỗi đầu tiên",
      problemsReported,
    );

    // Key Blockfrost sai mạng phải hiện ra kể cả khi mạng đó còn thiếu thứ khác.
    const hiddenKeyError = (health.networks ?? []).some(
      (entry) =>
        entry.blockfrost &&
        entry.blockfrost.ok === false &&
        !entry.blockfrost.detail,
    );
    assertTrue(
      "lỗi Blockfrost luôn kèm mô tả, không bao giờ im lặng",
      !hiddenKeyError,
    );

    // Mainnet bật ngoài ý muốn là rủi ro tiền thật — kiểm tra rõ ràng.
    const mainnet = (health.networks ?? []).find(
      (entry) => entry.network === "mainnet",
    );
    if (mainnet?.enabled) {
      assert(
        "mainnet chỉ bật khi PAYMENT_ENABLED_MAINNET=true",
        process.env.PAYMENT_ENABLED_MAINNET,
        "true",
      );
    } else {
      console.log("PASS  mainnet đang tắt (mặc định an toàn)");
      passes++;
    }

    // Mạng nào đã bật thì key Blockfrost phải nói chuyện đúng chain đó.
    //
    // `enabled` chỉ xét cấu hình (không gọi mạng, vì nó chạy trên mọi request tạo
    // đơn); `ready` mới là đã kiểm chứng thật. Bật một mạng bằng key hỏng thì vẫn
    // tạo được đơn nhưng không bao giờ xác minh được — nên nó phải kéo `ready`
    // xuống false và hiện thành lỗi ở đây.
    const enabledEntries = (health.networks ?? []).filter(
      (item) => item.enabled,
    );
    for (const entry of enabledEntries) {
      assertTrue(
        `${entry.network}: networkMagic khớp chain — ${entry.blockfrost?.detail ?? ""}`,
        entry.blockfrost?.ok,
      );
    }

    const allEnabledHealthy = enabledEntries.every(
      (entry) => entry.blockfrost?.ok,
    );
    assert(
      "cờ `ready` phản ánh đúng tình trạng các mạng đang bật",
      health.ready,
      Boolean(
        health.database?.ok &&
        health.redis?.ok &&
        enabledEntries.length > 0 &&
        allEnabledHealthy,
      ),
    );
  }

  /* --- Luồng đơn hàng --- */
  section("API đơn hàng");

  const enabledNetworks = (health?.networks ?? [])
    .filter((e) => e.enabled)
    .map((e) => e.network);
  const testNetwork = enabledNetworks[0];

  const api = async (method, path, body) => {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* để null — route trả HTML nghĩa là 404, và status đã nói lên điều đó */
    }
    return { status: response.status, json };
  };

  if (!testNetwork) {
    console.log(
      "SKIP  không có mạng nào đang bật — bỏ qua phần đơn hàng.\n" +
        "      Bật preprod bằng cách đặt MERCHANT_ADDRESS_PREPROD và BLOCKFROST_API_KEY_PREPROD.",
    );
  } else {
    try {
      console.log(`      Dùng mạng: ${testNetwork}\n`);

      // Route phải TỒN TẠI. Typecheck xanh không chứng minh điều này: manifest route
      // của Turbopack nằm trong .next và có thể cũ hơn cây thư mục, khiến một route
      // mới thêm trả 404 trong khi mã nguồn và kiểu đều hoàn toàn hợp lệ.
      //
      // Probe phải dùng mã SAI ĐỊNH DẠNG, không phải mã không tồn tại: route hợp lệ
      // trả 400 ngay khi kiểm định dạng, còn "không tìm thấy đơn" cũng trả 404 —
      // trùng đúng mã lỗi của route chưa đăng ký, nên không phân biệt được.
      const probe = await api(
        "POST",
        "/api/payments/orders/co-dau-gach/quote",
        { unit: "lovelace" },
      );
      assert(
        "route quote đã đăng ký (mã sai định dạng phải ra 400, không phải 404)",
        probe.status,
        400,
      );

      /* Tạo đơn — làm TRƯỚC để phát hiện sớm việc bị giới hạn tần suất.
         Bộ lọc tần suất chạy trước cả khâu đọc body (đúng: không nên parse body của
         kẻ spam), nên khi đã chạm hạn mức thì MỌI request tạo đơn đều trả 429 — kể
         cả các phép thử "đầu vào sai phải ra 400". Chạy chúng trước sẽ đổ ra một
         tràng lỗi che mất nguyên nhân thật. */
      const created = await api("POST", "/api/payments/orders", {
        network: testNetwork,
        amountUsd: "12.34",
        description: "Đơn kiểm thử — có dấu gạch nối",
      });
      assert("tạo đơn hợp lệ => 201", created.status, 201);

      if (created.status !== 201) {
        console.log(
          created.status === 429
            ? `      Bị giới hạn tần suất (hạn mức hiện tại: ${health?.params?.orderRateLimit ?? "?"}/giờ).\n` +
                "      Nâng bằng PAYMENT_ORDER_RATE_LIMIT rồi khởi động lại server."
            : `      ${created.json?.error ?? "(không có nội dung lỗi)"}`,
        );
        console.log("SKIP  bỏ qua phần còn lại của luồng đơn hàng");
        throw new SkipRest("không tạo được đơn");
      }

      /* Kiểm tra đầu vào */
      assert(
        "body không phải JSON => 400",
        (await api("POST", "/api/payments/orders", undefined)).status,
        400,
      );
      assert(
        "thiếu network => 400",
        (await api("POST", "/api/payments/orders", { amountUsd: "1" })).status,
        400,
      );
      assert(
        "network không hợp lệ => 400",
        (
          await api("POST", "/api/payments/orders", {
            network: "bitcoin",
            amountUsd: "1",
          })
        ).status,
        400,
      );
      assert(
        "số tiền âm => 400",
        (
          await api("POST", "/api/payments/orders", {
            network: testNetwork,
            amountUsd: "-5",
          })
        ).status,
        400,
      );
      assert(
        "số tiền quá nhiều chữ số thập phân => 400",
        (
          await api("POST", "/api/payments/orders", {
            network: testNetwork,
            amountUsd: "1.1234567",
          })
        ).status,
        400,
      );
      assert(
        "số 0 => 400",
        (
          await api("POST", "/api/payments/orders", {
            network: testNetwork,
            amountUsd: "0",
          })
        ).status,
        400,
      );

      const disabled = ["mainnet", "preprod", "preview"].find(
        (n) => !enabledNetworks.includes(n),
      );
      if (disabled) {
        const res = await api("POST", "/api/payments/orders", {
          network: disabled,
          amountUsd: "1",
        });
        assert(`mạng đang tắt (${disabled}) => 409`, res.status, 409);
        assertTrue(
          "báo lỗi có kèm danh sách mạng đang bật",
          Array.isArray(res.json?.enabledNetworks),
        );
      }

      const order = created.json?.order ?? {};
      assertTrue(`mã đơn hợp lệ (${order.ref})`, isValidRef(order.ref));
      assert("trạng thái ban đầu là pending", order.status, "pending");
      assert("số tiền giữ nguyên", order.amountUsd, "12.34");
      assert("số tiền dạng micro-USD", order.amountUsdMicro, "12340000");
      assert("chưa chọn token thì payment là null", order.payment, null);
      assert("chưa có giao dịch", order.tx, null);
      // Dấu gạch nối phải còn nguyên — bộ lọc chỉ được bỏ ký tự điều khiển.
      assertTrue(
        "mô tả giữ nguyên dấu gạch nối",
        order.description?.includes("gạch nối"),
      );

      const merchantFromHealth = (health?.networks ?? []).find(
        (e) => e.network === testNetwork,
      )?.merchantAddress;
      assert(
        "địa chỉ nhận lấy từ cấu hình server, không từ request",
        order.merchantAddress,
        merchantFromHealth,
      );

      /* Đọc đơn */
      const fetched = await api("GET", `/api/payments/orders/${order.ref}`);
      assert("đọc lại đơn => 200", fetched.status, 200);
      assert("đúng đơn vừa tạo", fetched.json?.order?.ref, order.ref);
      assertTrue(
        "có danh sách token trả được",
        Array.isArray(fetched.json?.tokens),
      );
      assert("ADA luôn đứng đầu", fetched.json?.tokens?.[0]?.symbol, "ADA");

      assert(
        "mã đơn không tồn tại => 404",
        (await api("GET", "/api/payments/orders/ZZnotfnd")).status,
        404,
      );
      assert(
        "mã đơn sai định dạng => 400",
        (await api("GET", "/api/payments/orders/co-dau-gach")).status,
        400,
      );

      /* Khoá giá bằng ADA */
      const adaQuote = await api(
        "POST",
        `/api/payments/orders/${order.ref}/quote`,
        { unit: "lovelace" },
      );
      assert("khoá giá bằng ADA => 200", adaQuote.status, 200);

      const adaPayment = adaQuote.json?.order?.payment ?? {};
      assert("unit là lovelace", adaPayment.unit, "lovelace");
      assert("ký hiệu là ADA", adaPayment.symbol, "ADA");
      assertTrue(
        `có tỷ giá đã khoá (${adaPayment.adaRateUsd} USD/ADA)`,
        Boolean(adaPayment.adaRate),
      );
      assertTrue(
        "ghi lại nguồn giá đã dùng",
        (adaPayment.rateSources ?? []).length >= 2,
      );
      assertTrue("báo giá ADA có hạn", Boolean(adaPayment.quoteExpiresAt));
      assertTrue(
        "báo giá chưa hết hạn ngay",
        adaPayment.quoteExpired === false,
      );

      // Số phải trả tính lại độc lập từ số tiền và tỷ giá đã lưu — nếu server làm tròn
      // sai chiều thì lệch ở đây.
      const expectedLovelace = ceilDivForQuote(
        BigInt(order.amountUsdMicro) * 1_000_000n,
        BigInt(adaPayment.adaRate),
      );
      assert(
        "số ADA phải trả khớp phép tính (làm tròn LÊN)",
        adaPayment.quantity,
        expectedLovelace.toString(),
      );

      const ttl =
        (new Date(adaPayment.quoteExpiresAt).getTime() - Date.now()) / 1000;
      assertTrue(
        `hạn khoá giá ~15 phút (còn ${Math.round(ttl)}s)`,
        ttl > 840 && ttl <= 900,
      );

      /* Đổi sang stablecoin */
      const stable = (fetched.json?.tokens ?? []).find(
        (t) => t.pegged && t.available,
      );
      if (stable) {
        const stableQuote = await api(
          "POST",
          `/api/payments/orders/${order.ref}/quote`,
          { unit: stable.unit },
        );
        assert(`đổi sang ${stable.symbol} => 200`, stableQuote.status, 200);

        const p = stableQuote.json?.order?.payment ?? {};
        assert(
          "đổi được token sau khi đã khoá giá ADA",
          p.symbol,
          stable.symbol,
        );
        // 1 token = 1 USD, và cả hai đều 6 chữ số thập phân nên số phải trả bằng đúng
        // số micro-USD của đơn.
        assert("stablecoin quy đổi 1:1", p.quantity, order.amountUsdMicro);
        assert(
          "stablecoin không có hạn báo giá (không có tỷ giá để khoá)",
          p.quoteExpiresAt,
          null,
        );
        assert("stablecoin không lưu tỷ giá ADA", p.adaRate, null);
      } else {
        console.log(
          "SKIP  mạng này chưa khai báo stablecoin nào — bỏ qua phần quy đổi 1:1",
        );
      }

      assert(
        "token không có trong danh mục => 400",
        (
          await api("POST", `/api/payments/orders/${order.ref}/quote`, {
            unit: "f".repeat(60),
          })
        ).status,
        400,
      );
      assert(
        "buyerAddress rác => 400",
        (
          await api("POST", `/api/payments/orders/${order.ref}/quote`, {
            unit: "lovelace",
            buyerAddress: "khong-phai-dia-chi",
          })
        ).status,
        400,
      );

      /* Đơn quá nhỏ để trả bằng ADA */
      const tiny = await api("POST", "/api/payments/orders", {
        network: testNetwork,
        amountUsd: "0.01",
      });
      const tinyQuote = await api(
        "POST",
        `/api/payments/orders/${tiny.json?.order?.ref}/quote`,
        {
          unit: "lovelace",
        },
      );
      // Bắt ở đây, lúc còn nói được câu rõ ràng — thay vì để ví báo lỗi khó hiểu lúc ký.
      assert(
        "đơn 0.01 USD trả bằng ADA => 400 (dưới min-ADA)",
        tinyQuote.status,
        400,
      );
      assertTrue(
        "giải thích rõ là do min-ADA",
        (tinyQuote.json?.error ?? "").includes("tối thiểu"),
      );

      /* Mã đơn không trùng nhau */
      const many = await Promise.all(
        Array.from({ length: 5 }, () =>
          api("POST", "/api/payments/orders", {
            network: testNetwork,
            amountUsd: "1",
          }),
        ),
      );
      const manyRefs = many.map((r) => r.json?.order?.ref);
      assert(
        "5 đơn tạo song song có 5 mã khác nhau",
        new Set(manyRefs).size,
        5,
      );

      /* Báo giao dịch */
      const probeSubmit = await api(
        "POST",
        "/api/payments/orders/co-dau-gach/submit",
        { txHash: "a".repeat(64) },
      );
      assert("route submit đã đăng ký (mã sai định dạng => 400)", probeSubmit.status, 400);

      assert(
        "txHash sai định dạng => 400",
        (
          await api("POST", `/api/payments/orders/${order.ref}/submit`, {
            txHash: "khong-phai-hash",
          })
        ).status,
        400,
      );
      assert(
        "txHash viết hoa (không phải hex thường) => 400",
        (
          await api("POST", `/api/payments/orders/${order.ref}/submit`, {
            txHash: "A".repeat(64),
          })
        ).status,
        400,
      );

      // Hash đúng định dạng nhưng không có trên chain: KHÔNG phải lỗi — giao dịch vừa
      // gửi còn nằm trong mempool suốt 20–60 giây đầu.
      const ghost = await api("POST", `/api/payments/orders/${order.ref}/submit`, {
        txHash: "b".repeat(64),
      });
      assert(
        "txHash không tồn tại trên chain => 202 (chưa thấy, không phải lỗi)",
        ghost.status,
        202,
      );
      assert("phán quyết là not_found", ghost.json?.verdict, "not_found");
      // Gợi ý sai tuyệt đối không được gắn vào đơn — gắn vào là chiếm mất
      // UNIQUE(tx_hash) và chặn luôn khoản trả thật đến sau.
      assert("đơn không bị gắn tx ma", ghost.json?.order?.tx, null);
      assert("đơn vẫn pending", ghost.json?.order?.status, "pending");

      const noQuote = await api("POST", "/api/payments/orders", {
        network: testNetwork,
        amountUsd: "5",
      });
      assert(
        "báo giao dịch khi chưa chọn token => 409",
        (
          await api("POST", `/api/payments/orders/${noQuote.json?.order?.ref}/submit`, {
            txHash: "c".repeat(64),
          })
        ).status,
        409,
      );

      /* Watcher */
      const sweepRes = await fetch(`${BASE}/api/payments/watcher?network=${testNetwork}`, {
        method: "POST",
        headers: watcherHeaders(),
      });
      const sweep = { status: sweepRes.status, json: await sweepRes.json().catch(() => null) };

      // 401 khi không có secret là ĐÚNG, không phải hỏng: endpoint này đổi trạng thái
      // thanh toán nên ở production phải khoá. Khẳng định nó khoá thật, rồi bỏ qua
      // phần chức năng vì không có cách nào gọi hợp lệ.
      if (sweep.status === 401 && !WATCHER_SECRET) {
        console.log(
          "PASS  watcher bị khoá đúng cách khi chưa có PAYMENT_WATCHER_SECRET (401)",
        );
        passes++;
        console.log("SKIP  bỏ qua phần chức năng của watcher — đặt PAYMENT_WATCHER_SECRET để kiểm");
      } else {
        assert("watcher chạy được => 200", sweep.status, 200);
        assertTrue("watcher trả báo cáo từng mạng", Array.isArray(sweep.json?.reports));
        assert("báo cáo đúng mạng được yêu cầu", sweep.json?.reports?.[0]?.network, testNetwork);
        assertTrue(
          "báo cáo có đủ các chỉ số",
          ["expired", "checked", "confirmed", "seen", "underpaid", "scannedTxs"].every(
            (k) => typeof sweep.json?.reports?.[0]?.[k] === "number",
          ),
        );
        assert(
          "watcher với network không hợp lệ => 400",
          (
            await fetch(`${BASE}/api/payments/watcher?network=bitcoin`, {
              method: "POST",
              headers: watcherHeaders(),
            })
          ).status,
          400,
        );
      }

      /* Danh sách đơn */
      const list = await api(
        "GET",
        `/api/payments/orders?network=${testNetwork}&limit=5`,
      );
      assert("liệt kê đơn => 200", list.status, 200);
      assert("tôn trọng tham số limit", list.json?.orders?.length, 5);

      globalThis.__orderRefForDbChecks = order.ref;
    } catch (error) {
      if (!(error instanceof SkipRest)) throw error;
    }
  }

  /* --- Ràng buộc chống double-credit: kiểm tra bằng hành vi thật --- */
  section("Postgres — ràng buộc chống ghi nhận trùng");

  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    console.log("SKIP  không có DATABASE_URL, bỏ qua phần kiểm tra ràng buộc");
  } else {
    const { default: pg } = await import("pg");
    const client = new pg.Client({
      connectionString,
      ssl: /[?&]sslmode=require/.test(connectionString)
        ? { rejectUnauthorized: false }
        : undefined,
    });

    try {
      await client.connect();

      /* --- Hết hạn & nhật ký sự kiện (cần ghi thật để API nhìn thấy) --- */
      const liveRef = globalThis.__orderRefForDbChecks;
      if (liveRef) {
        section("Đơn hàng — hết hạn & nhật ký");

        const events = await client.query(
          `SELECT e.from_status, e.to_status, e.detail
             FROM payment_order_events e
             JOIN payment_orders o ON o.id = e.order_id
            WHERE o.ref = $1
            ORDER BY e.at`,
          [liveRef],
        );
        // Trạng thái cuối không kể được câu chuyện. Khi cần trả lời "vì sao đơn này
        // bị đánh dấu đã trả", nhật ký là thứ duy nhất còn giữ lại quá trình.
        assertTrue(
          `ghi nhật ký cho cả tạo đơn lẫn khoá giá (${events.rowCount} dòng)`,
          events.rowCount >= 2,
        );
        assert(
          "sự kiện đầu tiên là tạo đơn",
          events.rows[0]?.to_status,
          "pending",
        );
        assertTrue(
          "sự kiện khoá giá lưu lại số tiền đã chốt",
          events.rows.some(
            (r) => r.detail?.action === "quote" && r.detail?.quantity,
          ),
        );

        // Đẩy hạn về quá khứ rồi đọc lại qua API: đơn phải tự chuyển sang expired.
        await client.query(
          "UPDATE payment_orders SET expires_at = now() - interval '1 minute' WHERE ref = $1",
          [liveRef],
        );

        const expired = await api("GET", `/api/payments/orders/${liveRef}`);
        assert(
          "đơn quá hạn tự chuyển sang expired khi đọc",
          expired.json?.order?.status,
          "expired",
        );

        const afterExpiry = await api(
          "POST",
          `/api/payments/orders/${liveRef}/quote`,
          { unit: "lovelace" },
        );
        assert(
          "không khoá giá được cho đơn đã hết hạn => 409",
          afterExpiry.status,
          409,
        );
        assertTrue(
          "báo rõ là đã hết hạn",
          (afterExpiry.json?.error ?? "").includes("hết hạn"),
        );

        const expiryEvent = await client.query(
          `SELECT e.to_status FROM payment_order_events e
             JOIN payment_orders o ON o.id = e.order_id
            WHERE o.ref = $1 AND e.to_status = 'expired'`,
          [liveRef],
        );
        assert("việc hết hạn cũng được ghi nhật ký", expiryEvent.rowCount, 1);

        // Đơn 'seen' nghĩa là tiền đang trên đường — hết hạn lúc đó mà đổi trạng
        // thái là xoá mất một khoản thanh toán có thật.
        await client.query(
          `UPDATE payment_orders
              SET status = 'seen', expires_at = now() - interval '1 hour'
            WHERE ref = $1`,
          [liveRef],
        );
        const seenOrder = await api("GET", `/api/payments/orders/${liveRef}`);
        assert(
          "đơn 'seen' quá hạn KHÔNG bị chuyển thành expired",
          seenOrder.json?.order?.status,
          "seen",
        );

        await client.query("DELETE FROM payment_orders WHERE ref = $1", [
          liveRef,
        ]);
        const gone = await client.query(
          "SELECT count(*)::int AS n FROM payment_order_events e JOIN payment_orders o ON o.id = e.order_id WHERE o.ref = $1",
          [liveRef],
        );
        assert(
          "xoá đơn thì nhật ký cũng bị xoá theo (ON DELETE CASCADE)",
          gone.rows[0].n,
          0,
        );
      }

      // Toàn bộ phần còn lại chạy trong một transaction rồi ROLLBACK — không để lại
      // một dòng rác nào trong bảng đơn hàng.
      await client.query("BEGIN");

      const insert = (ref, txHash, extra = {}) =>
        client.query(
          `INSERT INTO payment_orders
             (ref, network, amount_usd, merchant_address, expires_at, tx_hash, pay_unit,
              pay_quantity, pay_decimals, ada_rate)
           VALUES ($1, 'preprod', $2, $3, now() + interval '1 day', $4, $5, $6, $7, $8)`,
          [
            ref,
            extra.amountUsd ?? 10_000_000,
            extra.merchant ?? TESTNET_ADDR,
            txHash,
            extra.payUnit ?? null,
            extra.payQuantity ?? null,
            extra.payDecimals ?? null,
            extra.adaRate ?? null,
          ],
        );

      const TX = "a".repeat(64);

      await insert("ZZTEST01", TX);
      console.log("PASS  chèn đơn hợp lệ");
      passes++;

      // Chốt chặn cuối: một giao dịch không được thanh toán cho hai đơn.
      let duplicateBlocked = false;
      let duplicateCode = "";
      try {
        await client.query("SAVEPOINT dup");
        await insert("ZZTEST02", TX);
        await client.query("RELEASE SAVEPOINT dup");
      } catch (error) {
        duplicateBlocked = true;
        duplicateCode = error.code;
        await client.query("ROLLBACK TO SAVEPOINT dup");
      }
      assert(
        `UNIQUE(tx_hash) chặn double-credit (SQLSTATE ${duplicateCode})`,
        duplicateBlocked,
        true,
      );

      const expectReject = async (label, run) => {
        let rejected = false;
        try {
          await client.query("SAVEPOINT chk");
          await run();
          await client.query("RELEASE SAVEPOINT chk");
        } catch {
          rejected = true;
          await client.query("ROLLBACK TO SAVEPOINT chk");
        }
        assert(label, rejected, true);
      };

      await expectReject("CHECK chặn số tiền âm", () =>
        insert("ZZTEST03", "b".repeat(64), { amountUsd: -1 }),
      );
      await expectReject("CHECK chặn ref có ký tự lạ", () =>
        insert("bad ref!", "c".repeat(64)),
      );

      // ref bị đọc to, chép tay từ hoá đơn và gõ lại từ QR, nên bảng chữ cái cố ý
      // bỏ các ký tự dễ nhìn nhầm: I/O/l (giữ lại 1 và 0).
      await expectReject("CHECK chặn ký tự dễ nhầm trong ref (I)", () =>
        insert("ZZTESTI1", "c1".repeat(32)),
      );
      await expectReject("CHECK chặn ký tự dễ nhầm trong ref (O)", () =>
        insert("ZZTESTO1", "c2".repeat(32)),
      );

      await expectReject("CHECK chặn tx_hash sai định dạng", () =>
        insert("ZZTEST04", "khong-phai-hash"),
      );
      await expectReject(
        "CHECK chặn tỷ giá ADA gắn vào đơn trả bằng token",
        () =>
          insert("ZZTEST05", "d".repeat(64), {
            payUnit: "f".repeat(56) + "1234",
            payQuantity: 1_000_000,
            payDecimals: 6,
            adaRate: 450_000,
          }),
      );
      await expectReject("CHECK chặn chọn token mà thiếu số lượng", () =>
        insert("ZZTEST06", "e".repeat(64), { payUnit: "lovelace" }),
      );

      await client.query("ROLLBACK");

      const { rows } = await client.query(
        "SELECT count(*)::int AS n FROM payment_orders WHERE ref LIKE 'ZZTEST%'",
      );
      assert("ROLLBACK dọn sạch, không còn dòng thử nghiệm", rows[0].n, 0);
    } catch (error) {
      failures++;
      console.log(`FAIL  kiểm tra ràng buộc thất bại\n      ${error.message}`);
    } finally {
      await client.end().catch(() => {});
    }
  }
} else {
  console.log(
    "\n(bỏ qua phần hạ tầng — thêm --infra để kiểm tra Postgres/Redis/Blockfrost)",
  );
}

/* ================================================================== */

console.log(`\n${"═".repeat(66)}`);
console.log(
  failures === 0
    ? `Tất cả ${passes} kiểm tra đều đạt.`
    : `${failures} thất bại / ${passes + failures} kiểm tra.`,
);
process.exit(failures === 0 ? 0 : 1);
