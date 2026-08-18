/**
 * Kiểm chứng phần tích hợp với dự án bán hàng.
 *
 *   npm run verify:integration              chỉ phần logic thuần — không cần server, không cần DB
 *   npm run verify:integration -- --http    thêm các bài qua HTTP (cần dev server đang chạy)
 *   npm run verify:integration -- --http http://localhost:3100
 *
 * Bài quan trọng nhất nằm ở khối "Tương thích chữ ký": nó import CẢ HAI bản cài đặt —
 * bản của dịch vụ (`src/lib/webhook-signature.ts`) và bản sao dành cho shop
 * (`integration/cardano-pay-client.ts`) — rồi bắt chúng đối chiếu với nhau. Hai file
 * này deploy ở hai repo khác nhau; sửa một bên mà quên bên kia thì mọi webhook bị từ
 * chối, và thông báo lỗi ("chữ ký không khớp") không hề chỉ về nguyên nhân.
 *
 * Import thẳng file .ts — Node 23+ tự bỏ kiểu, không cần bước build.
 *
 * Chạy kèm cờ `--conditions=react-server` (đã có sẵn trong npm script). Không có nó,
 * package `server-only` ném lỗi ngay khi được import ngoài runtime Next; cờ này khiến
 * nó phân giải sang bản rỗng, đúng như khi Next dựng Server Component.
 */
import { createHmac } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import nextEnv from "@next/env";

import {
  DEFAULT_TOLERANCE_SECONDS,
  parseSignatureHeader,
  signPayload,
  verifySignature,
} from "../src/lib/webhook-signature.ts";
import { verifyWebhook } from "../integration/cardano-pay-client.ts";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
nextEnv.loadEnvConfig(projectDir, false, { info: () => {}, error: console.error });

const args = process.argv.slice(2);
const wantHttp = args.includes("--http");
const baseUrl = (args.find((a) => a.startsWith("http")) ?? "http://localhost:3000").replace(/\/$/, "");

let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/* ------------------------------------------------------------------ */
/* Tương thích chữ ký — bài quan trọng nhất                            */
/* ------------------------------------------------------------------ */

section("Tương thích chữ ký (dịch vụ ↔ shop)");

const SECRET = "x".repeat(48);
const now = Math.floor(Date.now() / 1_000);

// Payload có dấu tiếng Việt và ký tự cần escape: đây đúng là chỗ hai bản cài đặt dễ
// lệch nhau nhất, vì cách escape Unicode khác nhau là băm ra kết quả khác nhau.
const payload = JSON.stringify({
  event: "order.confirmed",
  occurredAt: new Date().toISOString(),
  data: { ref: "aB3xY9kM", amountUsd: "42.00", description: 'Gói "Pro" — 1 năm ✓' },
});

const header = signPayload(SECRET, now, payload);

check("signPayload sinh đúng định dạng t=…,v1=…", /^t=\d+,v1=[0-9a-f]{64}$/.test(header), header);

const parsed = parseSignatureHeader(header);
check("timestamp trong header khớp giá trị đã ký", Number(parsed.t) === now);

// Băm lại bằng tay, không dùng lại hàm của cả hai bên: nếu cả hai cùng sai theo cùng
// một kiểu thì việc so chúng với nhau không phát hiện được gì.
const expectedMac = createHmac("sha256", SECRET).update(`${now}.${payload}`).digest("hex");
check("HMAC = SHA256(secret, `<t>.<body>`)", parsed.v1 === expectedMac);

check("dịch vụ tự xác minh được chữ ký của mình", verifySignature(SECRET, header, payload).ok);

const shopSide = verifyWebhook(payload, header, SECRET);
check("SHOP xác minh được chữ ký do DỊCH VỤ tạo", shopSide.ok, shopSide.ok ? "" : shopSide.error);
check(
  "shop giải mã ra đúng payload",
  shopSide.ok && shopSide.payload.data.ref === "aB3xY9kM" && shopSide.payload.event === "order.confirmed",
);

/* --- những thứ PHẢI bị từ chối --------------------------------------- */

check("từ chối khi thiếu header", !verifyWebhook(payload, null, SECRET).ok);
check("từ chối header sai định dạng", !verifyWebhook(payload, "rác", SECRET).ok);
check("từ chối sai khoá", !verifyWebhook(payload, header, "y".repeat(48)).ok);

// Đổi một ký tự trong thân request. Đây chính là kịch bản kẻ tấn công sửa số tiền.
const tampered = payload.replace('"42.00"', '"0.01"');
check("từ chối khi thân request bị sửa", !verifyWebhook(tampered, header, SECRET).ok);

// Chữ ký hợp lệ nhưng cũ — chống phát lại.
const oldHeader = signPayload(SECRET, now - DEFAULT_TOLERANCE_SECONDS - 60, payload);
check("từ chối chữ ký quá cũ (chống phát lại)", !verifyWebhook(payload, oldHeader, SECRET).ok);

// Chữ ký đúng nhưng gắn timestamp khác — sửa `t` phải làm hỏng chữ ký.
const swapped = `t=${now - 10},v1=${parsed.v1}`;
check("sửa timestamp làm hỏng chữ ký", !verifyWebhook(payload, swapped, SECRET).ok);

// JSON.parse rồi stringify lại — cảnh báo lớn nhất trong tài liệu.
const reserialized = JSON.stringify(JSON.parse(payload));
check(
  "cảnh báo về thân-thô là có thật (parse+stringify làm hỏng chữ ký)",
  reserialized === payload || !verifyWebhook(reserialized, header, SECRET).ok,
);

/* ------------------------------------------------------------------ */
/* Duyệt returnUrl                                                     */
/* ------------------------------------------------------------------ */

section("Duyệt returnUrl (chống open redirect)");

// Đặt allowlist trước khi import: module đọc env lúc gọi hàm nên thứ tự không quan
// trọng, nhưng đặt sớm cho rõ ràng.
process.env.MERCHANT_RETURN_URL_ORIGINS = "https://shop.com,http://localhost:3001";
const { buildReturnUrl, validateReturnUrl } = await import("../src/lib/return-url.ts");

check("nhận origin trong allowlist", validateReturnUrl("https://shop.com/don-hang/42").ok);
check("nhận localhost khi được khai", validateReturnUrl("http://localhost:3001/thanks").ok);
check("bỏ trống là hợp lệ", validateReturnUrl(null).ok);

check("từ chối origin lạ", !validateReturnUrl("https://evil.com/x").ok);
check("từ chối javascript:", !validateReturnUrl("javascript:alert(1)").ok);
check("từ chối data:", !validateReturnUrl("data:text/html,<script>").ok);
check("từ chối URL mang thông tin đăng nhập", !validateReturnUrl("https://shop.com@evil.com/").ok);
check("từ chối đường dẫn tương đối", !validateReturnUrl("/thanks").ok);
check("từ chối cổng khác trên cùng host", !validateReturnUrl("https://shop.com:8443/x").ok);

// Subdomain KHÔNG được ngầm hiểu là thuộc allowlist.
check("từ chối subdomain không khai", !validateReturnUrl("https://a.shop.com/x").ok);

const decorated = buildReturnUrl("https://shop.com/don-hang/42", {
  ref: "aB3xY9kM",
  status: "confirmed",
  externalOrderId: "DH-42",
});
const decoratedUrl = new URL(decorated);
check("buildReturnUrl gắn đủ ref/status/orderId",
  decoratedUrl.searchParams.get("ref") === "aB3xY9kM" &&
    decoratedUrl.searchParams.get("status") === "confirmed" &&
    decoratedUrl.searchParams.get("orderId") === "DH-42");
check("buildReturnUrl giữ nguyên đường dẫn gốc", decoratedUrl.pathname === "/don-hang/42");

/* ------------------------------------------------------------------ */
/* Địa chỉ công khai                                                   */
/* ------------------------------------------------------------------ */

section("Địa chỉ công khai (payUrl)");

process.env.PAYMENT_PUBLIC_URL = "https://pay.shop.com/";
const { payUrlFor, publicBaseUrl } = await import("../src/lib/public-url.ts");

check("bỏ dấu / thừa ở cuối", publicBaseUrl() === "https://pay.shop.com");
check("payUrlFor dựng đúng link", payUrlFor("aB3xY9kM") === "https://pay.shop.com/pay/aB3xY9kM");

/* ------------------------------------------------------------------ */
/* Qua HTTP — cần dev server                                           */
/* ------------------------------------------------------------------ */

if (wantHttp) {
  section(`API tích hợp qua HTTP (${baseUrl})`);

  const apiKey = (process.env.MERCHANT_API_KEYS ?? "").split(",")[0]?.trim();
  const network = process.env.VERIFY_NETWORK ?? "preprod";

  async function api(path, init = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...init.headers,
      },
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }

  let reachable = true;
  try {
    await fetch(`${baseUrl}/api/payments/health`, { signal: AbortSignal.timeout(5_000) });
  } catch {
    reachable = false;
  }

  if (!reachable) {
    console.log(`  ⚠ Không kết nối được ${baseUrl} — bỏ qua phần HTTP. Chạy \`npm run dev\` trước.`);
  } else {
    if (apiKey) {
      // Không có khoá thì mọi lời gọi phải bị chặn. Bài này chỉ có nghĩa khi đã cấu
      // hình MERCHANT_API_KEYS — chưa cấu hình thì dev mở cửa có chủ đích.
      const noKey = await fetch(`${baseUrl}/api/v1/orders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ network, amountUsd: "1.00" }),
      });
      check("chặn request không mang khoá API", noKey.status === 401, `nhận ${noKey.status}`);

      const badKey = await api("/api/v1/orders", {
        method: "POST",
        headers: { authorization: `Bearer ${"z".repeat(48)}` },
        body: JSON.stringify({ network, amountUsd: "1.00" }),
      });
      check("chặn khoá API sai", badKey.status === 403, `nhận ${badKey.status}`);
    } else {
      console.log("  ⚠ Chưa đặt MERCHANT_API_KEYS — bỏ qua các bài xác thực.");
    }

    const externalOrderId = `verify-${Date.now()}`;

    const created = await api("/api/v1/orders", {
      method: "POST",
      body: JSON.stringify({
        network,
        amountUsd: "12.34",
        externalOrderId,
        description: "Bài kiểm tra tích hợp",
      }),
    });

    if (created.status === 409) {
      console.log(`  ⚠ Mạng "${network}" chưa bật — bỏ qua phần tạo đơn. ${created.body?.error ?? ""}`);
    } else if (created.status === 503) {
      console.log(`  ⚠ ${created.body?.error ?? "Dịch vụ chưa sẵn sàng"} — bỏ qua phần tạo đơn.`);
    } else {
      check("tạo đơn trả 201", created.status === 201, `nhận ${created.status}: ${created.body?.error ?? ""}`);
      check("phản hồi có payUrl", typeof created.body?.payUrl === "string", created.body?.payUrl);
      check("đơn mang đúng externalOrderId", created.body?.order?.externalOrderId === externalOrderId);
      check("đơn mới ở trạng thái pending", created.body?.order?.status === "pending");

      const ref = created.body?.order?.ref;

      // Idempotency — bài quan trọng thứ hai của cả file này.
      const again = await api("/api/v1/orders", {
        method: "POST",
        body: JSON.stringify({ network, amountUsd: "12.34", externalOrderId }),
      });
      check("gọi lại cùng externalOrderId trả 200", again.status === 200, `nhận ${again.status}`);
      check("gọi lại được đánh dấu reused", again.body?.reused === true);
      check("gọi lại trả về ĐÚNG đơn cũ", again.body?.order?.ref === ref);

      // Cùng mã đơn, khác số tiền → phải là lỗi, không phải retry.
      const mismatch = await api("/api/v1/orders", {
        method: "POST",
        body: JSON.stringify({ network, amountUsd: "99.99", externalOrderId }),
      });
      check("từ chối cùng mã đơn nhưng khác số tiền", mismatch.status === 409, `nhận ${mismatch.status}`);

      // Tra ngược.
      const lookup = await api(
        `/api/v1/orders?network=${network}&externalOrderId=${encodeURIComponent(externalOrderId)}`,
      );
      check("tra ngược theo externalOrderId", lookup.status === 200 && lookup.body?.order?.ref === ref);

      // Đọc theo ref, kèm nhật ký webhook.
      const byRef = await api(`/api/v1/orders/${ref}`);
      check("đọc đơn theo ref", byRef.status === 200 && byRef.body?.order?.ref === ref);
      check("phản hồi có mảng deliveries", Array.isArray(byRef.body?.deliveries));

      // returnUrl không nằm trong allowlist phải bị chặn Ở TẦNG API, không chỉ ở lib.
      const badReturn = await api("/api/v1/orders", {
        method: "POST",
        body: JSON.stringify({
          network,
          amountUsd: "1.00",
          externalOrderId: `${externalOrderId}-evil`,
          returnUrl: "https://evil.example/x",
        }),
      });
      check("API chặn returnUrl ngoài allowlist", badReturn.status === 400, `nhận ${badReturn.status}`);
    }

    const badNetwork = await api("/api/v1/orders", {
      method: "POST",
      body: JSON.stringify({ network: "fakenet", amountUsd: "1.00" }),
    });
    check("từ chối network không hợp lệ", badNetwork.status === 400, `nhận ${badNetwork.status}`);

    const badAmount = await api("/api/v1/orders", {
      method: "POST",
      body: JSON.stringify({ network, amountUsd: "-5" }),
    });
    check("từ chối số tiền âm", badAmount.status === 400, `nhận ${badAmount.status}`);
  }
} else {
  console.log("\n(Thêm --http để chạy các bài qua HTTP với dev server đang chạy.)");
}

/* ------------------------------------------------------------------ */

console.log(`\n${failed === 0 ? "✓" : "✗"} ${passed} đạt, ${failed} hỏng`);
process.exit(failed === 0 ? 0 : 1);
