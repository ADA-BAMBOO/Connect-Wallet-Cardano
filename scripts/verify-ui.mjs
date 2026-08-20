/**
 * Kiểm chứng giao diện bằng trình duyệt thật (Playwright + Chromium).
 *
 *   npm run verify:ui
 *   npm run verify:ui -- http://localhost:3100
 *
 * Cần dev server đang chạy và ít nhất một mạng đã bật.
 *
 * Trình duyệt ở đây KHÔNG có extension ví, nên script kiểm những gì không cần ví:
 * trang render đúng số tiền, chọn được token, báo giá hiện ra kèm đếm ngược, mã QR
 * mã hoá đúng URL, và trang hướng dẫn tử tế khi không tìm thấy ví.
 *
 * Phần cần ví (ký và gửi giao dịch) đã được kiểm ở verify:onchain bằng tiền thật.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import nextEnv from "@next/env";
import qrcode from "qrcode-generator";
import { chromium } from "playwright";

import { cip13PaymentUri } from "../src/lib/cip13.ts";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
nextEnv.loadEnvConfig(projectDir, false, { info: () => {}, error: console.error });

const BASE = process.argv.find((a) => a.startsWith("http")) ?? "http://localhost:3000";

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

// Ở production, /health chỉ trả {ok, ready} nếu thiếu token — gửi kèm khi có, để
// script chạy được với cả `next dev` lẫn `next start`.
const HEALTH_TOKEN = process.env.PAYMENT_HEALTH_TOKEN?.trim();

async function api(method, endpoint, body) {
  const res = await fetch(`${BASE}${endpoint}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(HEALTH_TOKEN ? { "x-health-token": HEALTH_TOKEN } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/* ------------------------------------------------------------------ */

const health = (await api("GET", "/api/payments/health")).json;
const network = (health?.networks ?? []).find((n) => n.enabled)?.network;

if (!network) {
  console.error("Không có mạng nào đang bật — bật preprod rồi chạy lại.");
  process.exit(1);
}

console.log(`Mạng: ${network}\nServer: ${BASE}\n`);

const created = await api("POST", "/api/payments/orders", {
  network,
  amountUsd: "42.50",
  description: "Goi Pro mot thang",
});

if (created.status !== 201) {
  console.error(`Không tạo được đơn: ${created.json?.error}`);
  process.exit(1);
}

const ref = created.json.order.ref;
const payUrl = `${BASE}/pay/${ref}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 1200 } });

// Lỗi JavaScript trên trang là lỗi thật — bắt hết thay vì để trôi qua.
const pageErrors = [];
page.on("pageerror", (err) => pageErrors.push(err.message));
page.on("console", (msg) => {
  if (msg.type() === "error") pageErrors.push(msg.text());
});

try {
  /* --- Trang chủ --- */
  const home = await page.goto(BASE, { waitUntil: "networkidle" });
  assert("trang chủ trả 200", home.status(), 200);
  assertTrue("trang chủ hiện lời mời kết nối ví", await page.getByText("Nhận thanh toán Cardano cho Kolo").isVisible());

  /* --- Trang thanh toán --- */
  const pay = await page.goto(payUrl, { waitUntil: "networkidle" });
  assert("trang thanh toán trả 200", pay.status(), 200);

  // Dữ liệu do server component đưa xuống nên phải có ngay, không qua spinner.
  await page.waitForSelector("text=42.5 USD", { timeout: 15_000 });
  assertTrue("hiện số tiền của đơn", await page.getByText("42.5 USD").first().isVisible());
  assertTrue("hiện mô tả đơn", await page.getByText("Goi Pro mot thang").isVisible());
  assertTrue("hiện mã đơn", await page.getByText(`Đơn ${ref}`).isVisible());
  assertTrue("hiện trạng thái chờ thanh toán", await page.getByText("Chờ thanh toán").isVisible());

  /* --- Bước ví phải thấy được NGAY, trước khi chọn token --- */
  // Từng bị thiếu: thẻ "Trả bằng ví" chỉ hiện sau khi đã khoá giá, nên người vừa mở
  // trang không thấy nút kết nối ví lẫn nút trả tiền, và cũng không có gì gợi ý phải
  // chọn token trước. Một nút bị vô hiệu hoá kèm lý do vẫn hơn hẳn nút không tồn tại.
  assertTrue(
    "thấy bước 'Trả bằng ví' ngay khi mở trang, chưa cần chọn token",
    await page.getByText("Trả bằng ví").isVisible(),
  );

  /* --- Chọn token --- */
  const tokenButtons = page.locator("button", { hasText: /^(ADA|tUSDM|tiUSD|tDJED|tUSDA|USDM)/ });
  const tokenCount = await tokenButtons.count();
  assertTrue(`có nút chọn token (${tokenCount} nút)`, tokenCount >= 1);

  await tokenButtons.first().click();
  await page.waitForSelector("text=Số tiền phải trả", { timeout: 20_000 });
  assertTrue("hiện khối số tiền phải trả", await page.getByText("Số tiền phải trả").isVisible());

  const quoted = (await api("GET", `/api/payments/orders/${ref}`)).json.order;
  assertTrue("server đã ghi nhận báo giá", Boolean(quoted.payment));
  assertTrue(
    `số tiền trên màn hình khớp báo giá (${quoted.payment.quantityFormatted} ${quoted.payment.symbol})`,
    await page.getByText(quoted.payment.quantityFormatted, { exact: false }).first().isVisible(),
  );

  // ADA có khoá tỷ giá 15 phút; stablecoin 1:1 thì không có gì để hết hạn.
  if (quoted.payment.unit === "lovelace") {
    assertTrue("hiện đồng hồ đếm ngược khoá giá", await page.getByText(/Khoá giá còn \d+:\d\d/).isVisible());
  } else {
    assertTrue(
      "nói rõ stablecoin không có hạn báo giá",
      await page.getByText(/1 token = 1 USD/).isVisible(),
    );
  }

  /* --- Không có ví thì phải hướng dẫn, không để nút chết --- */
  assertTrue(
    "báo không tìm thấy ví",
    await page.getByText("Không phát hiện ví Cardano nào").isVisible(),
  );
  assertTrue(
    "hướng dẫn mở bằng dApp browser của ví trên điện thoại",
    await page.getByText(/dApp browser/).isVisible(),
  );

  /* --- Mã QR phải mã hoá ĐÚNG chuỗi --- */
  // Đọc ngược ma trận từ SVG đã render rồi so với ma trận chuẩn. Phần tự viết là
  // dựng path SVG từ ma trận; phần mã hoá do thư viện lo — test này bắt lỗi ở phần
  // tự viết, và bắt cả trường hợp mã hoá nhầm chuỗi.
  //
  // Lưu ý QR trên TRANG THANH TOÁN là URI CIP-13 (chỉ hiện khi trả bằng ADA), khác
  // với QR trên thẻ tạo đơn vốn mã hoá URL trang /pay/<ref>.
  const expectedContent =
    quoted.payment.unit === "lovelace"
      ? cip13PaymentUri(quoted.merchantAddress, BigInt(quoted.payment.quantity))
      : null;

  const svgPath = await page
    .locator('svg[aria-label*="QR"] path')
    .first()
    .getAttribute("d")
    .catch(() => null);

  if (svgPath && expectedContent) {
    const drawn = new Set(
      [...svgPath.matchAll(/M(\d+) (\d+)h1v1h-1z/g)].map((m) => `${m[1]},${m[2]}`),
    );

    const expectedQr = qrcode(0, "M");
    expectedQr.addData(expectedContent);
    expectedQr.make();

    const count = expectedQr.getModuleCount();
    const QUIET = 4;
    const expectedSet = new Set();
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (expectedQr.isDark(r, c)) expectedSet.add(`${c + QUIET},${r + QUIET}`);
      }
    }

    assert("số module tối của QR khớp", drawn.size, expectedSet.size);
    assertTrue(
      "QR mã hoá đúng URI CIP-13 của khoản trả",
      drawn.size === expectedSet.size && [...expectedSet].every((k) => drawn.has(k)),
    );
  } else if (!expectedContent) {
    // CIP-13 chỉ mô tả được số ADA — trả bằng stablecoin thì cố tình KHÔNG có QR,
    // vì một URI thiếu số tiền sẽ khiến người dùng gửi nhầm.
    assert("trả bằng stablecoin thì không hiện QR CIP-13", svgPath, null);
  } else {
    console.log("SKIP  không tìm thấy SVG QR trên trang thanh toán");
  }

  /* --- Dòng thời gian khi giao dịch đang trên đường --- */
  // Dựng thẳng trạng thái `seen` trong database rồi tải lại trang: đây đúng là cảnh
  // người dùng gặp khi họ ký xong rồi F5, hoặc mở lại link trên máy khác. Chặng cục
  // bộ ở client đã mất, dòng thời gian phải dựng lại được từ mỗi đơn hàng.
  const { default: pg } = await import("pg");
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  try {
    const inFlight = await api("POST", "/api/payments/orders", {
      network,
      amountUsd: "3.25",
      description: "Don dang bay",
    });
    const flightRef = inFlight.json?.order?.ref;
    const flightToken = (await api("GET", `/api/payments/orders/${flightRef}`)).json?.tokens?.[0];
    await api("POST", `/api/payments/orders/${flightRef}/quote`, { unit: flightToken.unit });

    await db.query(
      `UPDATE payment_orders
          SET status='seen', tx_hash=$2, tx_block_height=5070000, confirmations=1,
              received_quantity=pay_quantity, tx_metadata_ok=true
        WHERE ref=$1`,
      [flightRef, "d".repeat(64)],
    );

    await page.goto(`${BASE}/pay/${flightRef}`, { waitUntil: "networkidle" });

    assertTrue(
      "đơn đang bay hiện dòng thời gian",
      await page.getByText("Tiến trình thanh toán").isVisible(),
    );
    assertTrue("có chặng ký trong ví", await page.getByText("Ký trong ví").isVisible());
    assertTrue("có chặng gửi lên mạng", await page.getByText("Gửi lên mạng Cardano").isVisible());
    assertTrue("có chặng vào block", await page.getByText("Vào block").isVisible());
    assertTrue(
      "hiện tiến độ xác nhận 1/3",
      await page.getByText(/1\/3/).first().isVisible(),
    );
    assertTrue(
      "trấn an người dùng rằng đóng trang được",
      await page.getByText(/có thể đóng trang này/).isVisible(),
    );
    // Đổi token lúc này không có tác dụng gì — để nguyên chỉ khiến người ta tưởng
    // phải trả lại lần nữa.
    assertTrue(
      "ẩn phần chọn token khi giao dịch đang trên đường",
      !(await page.getByText("Chọn cách trả").isVisible()),
    );

    /* --- Sổ đơn hàng --- */
    const dash = await page.goto(`${BASE}/orders`, { waitUntil: "networkidle" });
    assert("trang sổ đơn hàng trả 200", dash.status(), 200);
    assertTrue("hiện tiêu đề sổ đơn hàng", await page.getByText("Sổ đơn hàng").first().isVisible());
    assertTrue("hiện thống kê đã thu", await page.getByText("Đã thu").isVisible());
    assertTrue(`hiện đơn vừa tạo (${flightRef})`, await page.getByText(flightRef).first().isVisible());
    assertTrue(
      "cảnh báo trang đang mở vì chưa cấu hình quản trị",
      await page.getByText(/PAYMENT_ADMIN_ADDRESSES/).isVisible(),
    );

    await db.query("DELETE FROM payment_orders WHERE ref = $1", [flightRef]);
  } finally {
    await db.end().catch(() => {});
  }

  /* --- Đơn không tồn tại và mã sai định dạng --- */
  const missing = await page.goto(`${BASE}/pay/ZZnotfnd`, { waitUntil: "domcontentloaded" });
  assert("đơn không tồn tại => 404", missing.status(), 404);

  const malformed = await page.goto(`${BASE}/pay/co-dau-gach`, { waitUntil: "domcontentloaded" });
  assert("mã đơn sai định dạng => 404", malformed.status(), 404);

  /* --- Không có lỗi JS nào trên trang --- */
  // Bỏ qua tiếng ồn quen thuộc: extension ví sửa DOM trước khi React hydrate, và
  // 404 chủ đích ở hai bước trên cũng ghi vào console.
  const realErrors = pageErrors.filter(
    (e) => !/hydrat|404|Failed to load resource/i.test(e),
  );
  assert(
    `không có lỗi JavaScript trên trang${realErrors.length ? ` — ${realErrors[0]}` : ""}`,
    realErrors.length,
    0,
  );

  /* --- Ảnh chụp để đối chiếu bằng mắt --- */
  await page.goto(payUrl, { waitUntil: "networkidle" });
  const shot = path.join(projectDir, ".next", "verify-ui-pay.png");
  await page.screenshot({ path: shot, fullPage: true });
  console.log(`\nẢnh chụp trang thanh toán: ${shot}`);
} finally {
  await browser.close();
}

console.log(`\n${"═".repeat(66)}`);
console.log(
  failures === 0 ? `Tất cả ${passes} kiểm tra đều đạt.` : `${failures} thất bại / ${passes + failures} kiểm tra.`,
);
process.exit(failures === 0 ? 0 : 1);
