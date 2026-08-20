/**
 * Kiểm chứng giao diện song ngữ bằng trình duyệt thật.
 *
 *   npm run verify:i18n
 *   npm run verify:i18n -- http://localhost:3100
 *
 * Bốn thứ phải đúng cùng lúc, và chỉ đo được khi chạy thật:
 *
 *   1. Chưa có cookie thì mặc định tiếng Việt (các bài verify:ui bám vào điều này).
 *   2. Bấm nút đổi ngôn ngữ thì CẢ component client (thẻ ví) lẫn component server
 *      (sổ đơn hàng, <html lang>) cùng đổi trong một lượt.
 *   3. Lựa chọn sống qua reload — nếu không thì nút chỉ là hiệu ứng tức thời.
 *   4. Thông báo lỗi của API cũng đổi theo, vì chúng hiện thẳng lên UI dưới dạng
 *      Alert; để sót nhóm này là giao diện lẫn hai thứ tiếng.
 *
 * Không cần ví: mọi thứ ở đây đều nằm ngoài luồng CIP-30.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import nextEnv from "@next/env";
import { chromium } from "playwright";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
nextEnv.loadEnvConfig(projectDir, false, { info: () => {}, error: console.error });

const BASE = process.argv.find((a) => a.startsWith("http")) ?? "http://localhost:3000";
const LOCALE_COOKIE = "cardano_locale";

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

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();

const pageErrors = [];
page.on("pageerror", (err) => pageErrors.push(err.message));

/* 1. Mặc định: chưa có cookie -> tiếng Việt ------------------------- */

await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.getByText("Kết nối ví Cardano").waitFor({ timeout: 30_000 });

assert("mặc định là tiếng Việt", await page.getByText("Kết nối ví Cardano").isVisible(), "true");
assert('<html lang> mặc định là "vi"', await page.locator("html").getAttribute("lang"), "vi");

/* 2. Bấm EN -> client và server cùng đổi ---------------------------- */

await page.getByRole("button", { name: /English/ }).click();
await page.getByText("Connect a Cardano wallet").waitFor({ timeout: 30_000 });

assert(
  "bấm EN thì component client đổi sang tiếng Anh",
  await page.getByText("Connect a Cardano wallet").isVisible(),
  "true",
);
assert('<html lang> đổi thành "en"', await page.locator("html").getAttribute("lang"), "en");
assert(
  "không còn chuỗi tiếng Việt nào của màn hình chào",
  await page.getByText("Kết nối ví Cardano").isVisible().catch(() => false),
  "false",
);

const cookies = await context.cookies();
assert(
  "lựa chọn được ghi vào cookie",
  cookies.find((c) => c.name === LOCALE_COOKIE)?.value,
  "en",
);

/* 3. Sống qua reload ------------------------------------------------ */

await page.reload({ waitUntil: "domcontentloaded" });
await page.getByText("Connect a Cardano wallet").waitFor({ timeout: 30_000 });
assert(
  "vẫn là tiếng Anh sau khi tải lại trang",
  await page.getByText("Connect a Cardano wallet").isVisible(),
  "true",
);

/* 4. Component server: tiêu đề trang + sổ đơn hàng ------------------ */

assert("thẻ <title> cũng đổi theo", (await page.title()).includes("CIP-30 wallet demo"), "true");

await page.goto(`${BASE}/orders`, { waitUntil: "domcontentloaded" });
const ordersHtml = await page.content();
assert(
  "sổ đơn hàng (server component) hiện tiếng Anh",
  /Order book|order book|locked/.test(ordersHtml),
  "true",
);
assert("sổ đơn hàng không còn tiêu đề tiếng Việt", /Sổ đơn hàng/.test(ordersHtml), "false");

/* 5. Thông báo lỗi của API đi theo cookie --------------------------- */

async function apiError(locale) {
  const res = await context.request.post(`${BASE}/api/auth/verify`, {
    headers: { "content-type": "application/json", cookie: `${LOCALE_COOKIE}=${locale}` },
    data: { address: "khong-phai-dia-chi" },
  });
  return (await res.json()).error;
}

assert("lỗi API bằng tiếng Anh khi cookie = en", await apiError("en"), "Invalid address.");
assert("lỗi API bằng tiếng Việt khi cookie = vi", await apiError("vi"), "Địa chỉ không hợp lệ.");

/* 6. Không có lỗi runtime ------------------------------------------- */

assert("không có lỗi runtime trên trang", pageErrors.length, 0);
if (pageErrors.length) console.log("      pageerror:", pageErrors);

await browser.close();

console.log(
  `\n${failures === 0 ? "Tất cả" : `${passes}/${passes + failures}`} kiểm tra i18n đã pass.`,
);
process.exit(failures === 0 ? 0 : 1);
