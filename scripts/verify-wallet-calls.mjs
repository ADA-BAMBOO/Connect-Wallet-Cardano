/**
 * Đếm số lời gọi CIP-30 mà trang bắn vào ví, bằng trình duyệt thật.
 *
 *   npm run verify:wallet-calls
 *   npm run verify:wallet-calls -- http://localhost:3100
 *
 * Vì sao cần bài này: extension ví tự đặt rate limit cho API của nó. Trang chủ có
 * 5 thẻ cùng cần networkId, và `useNetwork()` của Mesh gọi `getNetworkId()` một lần
 * cho MỖI component — 5 lời gọi giống hệt nhau trong một khoảnh khắc, đủ để Eternl
 * trả về "too many requests". Lỗi đó chỉ hiện ra trên máy có ví thật, nên phải có
 * một bài đo tự động canh chừng, nếu không nó sẽ lặng lẽ quay lại.
 *
 * Ví ở đây là ví CIP-30 GIẢ cắm vào `window.cardano`, nên không cần extension.
 *
 * Yêu cầu dev server đang chạy.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import nextEnv from "@next/env";
import { MeshWallet } from "@meshsdk/core";
import { Address } from "@meshsdk/core-cst";
import { chromium } from "playwright";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
nextEnv.loadEnvConfig(projectDir, false, { info: () => {}, error: console.error });

const BASE = process.argv.find((a) => a.startsWith("http")) ?? "http://localhost:3000";
const STORAGE_KEY = "kolo-pay:last-wallet";
const WALLET_NAME = "mockwallet";

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

/* ------------------------------------------------------------------ */
/* Địa chỉ thật để Mesh giải mã được (Mesh parse hex address thật sự)  */
/* ------------------------------------------------------------------ */

const words = MeshWallet.brew();
const mesh = new MeshWallet({
  networkId: 0,
  key: { type: "mnemonic", words: Array.isArray(words) ? words : words.split(" ") },
});
const { baseAddressBech32, rewardAddressBech32 } = mesh._wallet.getAccount(0, 0);
const toHex = (bech32) => Address.fromBech32(bech32).toBytes().toString();

const ADDRESSES = {
  base: toHex(baseAddressBech32),
  reward: toHex(rewardAddressBech32),
};

/**
 * Kịch bản ví chạy TRONG trang. Mọi lời gọi đều được đếm; `failFirst` cho phép
 * mô phỏng đúng lỗi rate limit mà Eternl ném ra.
 */
function installMockWallet({ addresses, walletName, failFirst }) {
  const calls = {};
  const unhandled = [];

  window.__walletCalls = calls;
  window.__unhandled = unhandled;

  window.addEventListener("unhandledrejection", (e) => {
    unhandled.push(String(e.reason?.info ?? e.reason?.message ?? e.reason));
  });

  let networkIdFailures = 0;

  const count = (name, fn) => async (...args) => {
    calls[name] = (calls[name] ?? 0) + 1;
    return fn(...args);
  };

  const api = {
    getNetworkId: count("getNetworkId", async () => {
      if (networkIdFailures < failFirst) {
        networkIdFailures++;
        // Đúng hình dạng lỗi CIP-30 của ví thật: object thuần, không phải Error.
        throw { code: -2, info: "too many requests" };
      }
      return 0;
    }),
    getUtxos: count("getUtxos", async () => []),
    getCollateral: count("getCollateral", async () => []),
    getBalance: count("getBalance", async () => "00"),
    getUsedAddresses: count("getUsedAddresses", async () => [addresses.base]),
    getUnusedAddresses: count("getUnusedAddresses", async () => []),
    getChangeAddress: count("getChangeAddress", async () => addresses.base),
    getRewardAddresses: count("getRewardAddresses", async () => [addresses.reward]),
    getExtensions: count("getExtensions", async () => []),
    signTx: count("signTx", async () => ""),
    signData: count("signData", async () => ({ signature: "", key: "" })),
    submitTx: count("submitTx", async () => "00".repeat(32)),
  };

  window.cardano = {
    ...(window.cardano ?? {}),
    [walletName]: {
      name: walletName,
      icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>",
      version: "1.0.0",
      apiVersion: "0.1.0",
      supportedExtensions: [],
      enable: count("enable", async () => api),
      isEnabled: async () => true,
    },
  };
}

async function run({ label, failFirst, budget }) {
  const browser = await chromium.launch();
  const context = await browser.newContext();

  /*
   * Ghim ngôn ngữ về tiếng Việt: bộ này đếm số lần gọi CIP-30, nhưng nó nhận biết
   * "đã kết nối xong" bằng một chuỗi tiếng Việt trên màn hình. Một bản dựng đặt
   * DEFAULT_LOCALE=en — cấu hình hợp lệ — sẽ làm nó treo cho tới lúc hết giờ.
   */
  await context.addCookies([{ name: "cardano_locale", value: "vi", url: BASE }]);

  const page = await context.newPage();

  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.addInitScript(installMockWallet, {
    addresses: ADDRESSES,
    walletName: WALLET_NAME,
    failFirst,
  });
  // Tự kết nối lại khi tải trang — đúng đường mà người dùng thật đi.
  await page.addInitScript((args) => {
    window.localStorage.setItem(args.key, args.name);
  }, { key: STORAGE_KEY, name: WALLET_NAME });

  await page.goto(BASE, { waitUntil: "domcontentloaded" });

  // Chờ tới khi giao diện đã ở trạng thái kết nối — lúc đó mọi thẻ đã mount xong.
  await page.getByText("Đã kết nối").first().waitFor({ timeout: 30_000 });

  // Cho các effect lắng xuống (kể cả nhịp retry của rate limit) rồi mới đếm.
  await page.waitForTimeout(3_000);

  const calls = await page.evaluate(() => window.__walletCalls);
  const unhandled = await page.evaluate(() => window.__unhandled);
  const networkLabel = await page
    .getByText(/Testnet|Mainnet/)
    .first()
    .textContent()
    .catch(() => null);

  console.log(`\n--- ${label} ---`);
  console.log("  lời gọi CIP-30:", JSON.stringify(calls));

  // NGƯỠNG TRẦN, không phải con số chính xác: bản dev chạy StrictMode nên React gọi
  // effect hai lần, bản production thì không. Cái cần canh là "không vượt quá", vì
  // thứ làm ví chặn là số lời gọi dư ra.
  for (const [method, max] of Object.entries(budget)) {
    const actual = calls[method] ?? 0;
    assert(`${label}: ${method} gọi ${actual} lần (trần ${max})`, actual <= max, true);
  }

  assert(`${label}: không có promise rejection lọt ra ngoài`, unhandled.length, 0);
  assert(`${label}: không có lỗi runtime trên trang`, pageErrors.length, 0);
  assert(`${label}: trang vẫn hiện được mạng của ví`, /Testnet/.test(networkLabel ?? ""), "true");

  if (unhandled.length) console.log("      rejection:", unhandled);
  if (pageErrors.length) console.log("      pageerror:", pageErrors);

  await browser.close();
}

console.log(`Base URL: ${BASE}`);

/**
 * Ngưỡng đo được sau khi dồn các hook về `lib/use-wallet-data.ts`.
 * Để so sánh, đây là số của bản dùng hook gốc của Mesh:
 *   getNetworkId 10 · getBalance 6 · getUsedAddresses 2
 */
const BUDGET = {
  getNetworkId: 1, // 5 thẻ cùng cần, ví chỉ được hỏi MỘT lần
  getBalance: 2, // useLovelace + useAssets, mỗi thứ một lần
  getUsedAddresses: 1,
};

// 1. Đường bình thường.
await run({ label: "ví bình thường", failFirst: 0, budget: BUDGET });

// 2. Ví chặn vì gọi quá dày: phải tự thử lại và tự hồi phục, không văng màn hình đỏ.
//    getNetworkId được nới lên 3 = 1 lần đầu + 2 lần thử lại.
await run({
  label: "ví trả 'too many requests' 2 lần đầu",
  failFirst: 2,
  budget: { ...BUDGET, getNetworkId: 3 },
});

console.log(`\n${failures === 0 ? "Tất cả" : `${passes}/${passes + failures}`} kiểm tra đã pass.`);
process.exit(failures === 0 ? 0 : 1);
