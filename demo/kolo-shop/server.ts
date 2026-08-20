/**
 * KOLO GIẢ LẬP — dùng để DEMO, không phải mã production.
 *
 * Đây là "dự án bán hàng" trong sơ đồ ở docs/INTEGRATION.md: một service riêng, chạy
 * ở cổng riêng, gọi sang cổng thanh toán qua HTTP y như Kolo thật sẽ làm.
 *
 *   localhost:3100 (Kolo giả lập)            localhost:3000 (Kolo Pay)
 *   ─────────────────────────────            ─────────────────────────────
 *     ① POST /mua ──────────────────────────►  POST /api/v1/orders
 *     ② redirect khách ─────────────────────►  /pay/<ref>  → khách ký bằng ví
 *     ③ ◄──── webhook đã ký HMAC ────────────  order.confirmed
 *     ④ ◄──── khách quay về /don-hang/<id> ──  returnUrl
 *
 * Vì sao viết bằng .ts mà không cần bước build: Node 23+ tự bóc kiểu. Nhờ vậy file này
 * import THẲNG integration/cardano-pay-client.ts — đúng file mà một shop thật sẽ copy
 * về — nên demo chạy qua chính đoạn mã được giao cho khách hàng, không phải bản chép tay.
 *
 * KHÁC BIỆT DUY NHẤT SO VỚI SHOP THẬT (cố ý, và chỉ hợp lệ trong demo):
 *
 *   • Đọc khoá API và khoá webhook từ .env.local của CỔNG THANH TOÁN.
 *     Shop thật có file cấu hình riêng, hai bên không bao giờ đọc chung một file —
 *     xem docs/INTEGRATION.md mục 2. Ở đây làm vậy để demo chạy được bằng một lệnh
 *     mà không phải chép khoá qua lại.
 *   • Đơn hàng nằm trong RAM, tắt server là mất. Shop thật lưu vào database của nó.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import nextEnv from "@next/env";

import {
  createCardanoPayClient,
  verifyWebhook,
  SIGNATURE_HEADER,
  CardanoPayError,
  type OrderStatus,
} from "../../integration/cardano-pay-client.ts";

/* ------------------------------------------------------------------ */
/* Cấu hình                                                            */
/* ------------------------------------------------------------------ */

const here = path.dirname(fileURLToPath(import.meta.url));
const gatewayRoot = path.resolve(here, "../..");
nextEnv.loadEnvConfig(gatewayRoot, true);

const PORT = Number(process.env.KOLO_SHOP_PORT ?? 3100);
const SHOP_URL = process.env.KOLO_SHOP_URL ?? `http://localhost:${PORT}`;
const PAY_URL =
  process.env.KOLO_PAY_URL ?? process.env.PAYMENT_PUBLIC_URL ?? "http://localhost:3000";

/* Shop chỉ được cầm MỘT khoá, dù cổng thanh toán chấp nhận nhiều khoá để xoay vòng. */
const API_KEY = (process.env.MERCHANT_API_KEYS ?? "").split(",")[0]?.trim() ?? "";
const WEBHOOK_SECRET = process.env.MERCHANT_WEBHOOK_SECRET ?? "";
const NETWORK = (process.env.KOLO_SHOP_NETWORK ?? "preprod") as "mainnet" | "preprod" | "preview";

if (!API_KEY) {
  console.error("Thiếu MERCHANT_API_KEYS trong .env.local của cổng thanh toán.");
  process.exit(1);
}

const koloPay = createCardanoPayClient({ baseUrl: PAY_URL, apiKey: API_KEY, network: NETWORK });

/* ------------------------------------------------------------------ */
/* "Kho hàng" và "database" của shop                                   */
/* ------------------------------------------------------------------ */

type Sku = { id: string; name: string; blurb: string; amountUsd: string };

/**
 * Giá LUÔN đến từ đây, không bao giờ từ request. Nhận giá do trình duyệt gửi lên là
 * để khách tự ra giá cho hàng của mình.
 */
const CATALOG: Sku[] = [
  {
    id: "pro-thang",
    name: "Kolo Pro — 1 tháng",
    blurb: "Lưu bộ sưu tập công cụ, bỏ giới hạn lượt tính, xuất kết quả ra Excel.",
    amountUsd: "4.90",
  },
  {
    id: "pro-nam",
    name: "Kolo Pro — 1 năm",
    blurb: "Như gói tháng, trả trước 12 tháng và tiết kiệm hai tháng.",
    amountUsd: "49.00",
  },
  {
    id: "bo-ban-hang",
    name: "Bộ công cụ Bán hàng",
    blurb: "15 công cụ tính giá vốn, chiết khấu, hoa hồng và điểm hoà vốn. Mua một lần.",
    amountUsd: "9.90",
  },
];

type ShopOrder = {
  id: string;
  sku: Sku;
  ref: string | null;
  status: OrderStatus | "created";
  txHash: string | null;
  paidWith: string | null;
  delivered: boolean;
  updatedAt: string;
};

const orders = new Map<string, ShopOrder>();
let counter = 0;

/* ------------------------------------------------------------------ */
/* Giao diện — dùng đúng design token đọc từ bboapp.xyz                */
/* ------------------------------------------------------------------ */

const CSS = `
:root{
  --green:#1f8f3a; --green-hover:#197832; --green-active:#146329;
  --lime:#a3c644; --bg-green-soft:#eef7e8;
  --bg:#fff; --bg-2:#f6faf3;
  --text:#0d1f2d; --text-2:#40505b; --text-off:#a5afb5;
  --border:#dce6d8; --border-soft:#e8eee5;
  --r-btn:8px; --r-card:12px;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);
  font:16px/1.6 Inter,system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--green);text-underline-offset:3px}
header{border-bottom:1px solid var(--border-soft);background:var(--bg)}
.bar,.wrap{max-width:960px;margin:0 auto;padding:0 24px}
.bar{display:flex;align-items:center;justify-content:space-between;height:64px}
.brand{font-size:22px;font-weight:700;color:var(--text);text-decoration:none;letter-spacing:-.01em}
.chip{display:inline-block;background:var(--bg-green-soft);color:var(--green);
  border-radius:999px;padding:4px 12px;font-size:13px;font-weight:600}
h1{font-size:38px;line-height:1.2;letter-spacing:-.02em;margin:24px 0 8px}
h2{font-size:20px;margin:0 0 4px}
.lead{color:var(--text-2);margin:0 0 8px;max-width:62ch}
.grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));margin:32px 0 48px}
.card{border:1px solid var(--border);border-radius:var(--r-card);padding:20px;background:var(--bg);
  display:flex;flex-direction:column;gap:8px}
.card p{color:var(--text-2);font-size:14px;margin:0;flex:1}
.price{font-size:28px;font-weight:700;letter-spacing:-.02em}
.price span{font-size:14px;font-weight:500;color:var(--text-off)}
button{font:inherit;font-weight:600;cursor:pointer;border:0;border-radius:var(--r-btn);
  background:var(--green);color:#fff;padding:11px 18px;width:100%}
button:hover{background:var(--green-hover)} button:active{background:var(--green-active)}
.panel{border:1px solid var(--border);border-radius:var(--r-card);background:var(--bg-2);
  padding:24px;margin:24px 0}
.row{display:flex;justify-content:space-between;gap:16px;padding:10px 0;
  border-bottom:1px solid var(--border-soft);font-size:14px}
.row:last-child{border-bottom:0}
.row dt{color:var(--text-2)} .row dd{margin:0;font-weight:600;text-align:right;word-break:break-all}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
.state{display:inline-flex;align-items:center;gap:8px;font-weight:700}
.dot{width:9px;height:9px;border-radius:50%;background:var(--text-off)}
.ok .dot{background:var(--green)} .wait .dot{background:var(--lime)} .bad .dot{background:#d23b43}
.ok{color:var(--green)} .bad{color:#d23b43}
.note{font-size:14px;color:var(--text-2)}
footer{border-top:1px solid var(--border-soft);margin-top:64px;padding:24px 0;
  color:var(--text-off);font-size:14px}
`;

const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => ENTITIES[c] as string);

function page(title: string, body: string, refreshSeconds?: number) {
  const refresh = refreshSeconds
    ? `<meta http-equiv="refresh" content="${refreshSeconds}">`
    : "";

  return `<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title>${refresh}
<style>${CSS}</style></head><body>
<header><div class="bar"><a class="brand" href="/">Kolo</a>
<span class="chip">Bản demo · ${escape(NETWORK)}</span></div></header>
<main class="wrap">${body}</main>
<footer class="wrap">Kolo giả lập — dựng để demo cổng thanh toán Kolo Pay đang chạy ở
<span class="mono">${escape(PAY_URL)}</span>.</footer></body></html>`;
}

/* ------------------------------------------------------------------ */
/* Trang chủ shop                                                      */
/* ------------------------------------------------------------------ */

function shopPage() {
  const cards = CATALOG.map(
    (sku) => `<div class="card">
      <h2>${escape(sku.name)}</h2>
      <p>${escape(sku.blurb)}</p>
      <div class="price">$${escape(sku.amountUsd)} <span>USD</span></div>
      <form method="post" action="/mua"><input type="hidden" name="sku" value="${escape(sku.id)}">
      <button type="submit">Thanh toán bằng Cardano</button></form>
    </div>`,
  ).join("");

  return page(
    "Kolo — nâng cấp tài khoản",
    `<h1>Nâng cấp tài khoản Kolo</h1>
     <p class="lead">Trả bằng ADA hoặc stablecoin trên Cardano. Không cần thẻ, không qua
     trung gian — bấm nút là chuyển sang cổng thanh toán của Kolo.</p>
     <div class="grid">${cards}</div>`,
  );
}

/* ------------------------------------------------------------------ */
/* ① Khách bấm mua → tạo đơn ở cổng thanh toán → redirect              */
/* ------------------------------------------------------------------ */

async function handleBuy(res: ServerResponse, form: URLSearchParams) {
  const sku = CATALOG.find((item) => item.id === form.get("sku"));
  if (!sku) return send(res, 400, page("Lỗi", "<h1>Không có sản phẩm này</h1>"));

  // Hậu tố ngẫu nhiên chứ không phải số đếm thuần: "database" nằm trong RAM nên số đếm
  // quay về 0 sau mỗi lần khởi động lại, và mã đơn trùng với lần chạy trước sẽ bị cổng
  // thanh toán từ chối bằng 409 khi giá khác — đúng luật idempotency, nhưng làm hỏng demo.
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  const shopOrderId = `KOLO-${today}-${String(++counter).padStart(3, "0")}${suffix}`;

  const record: ShopOrder = {
    id: shopOrderId,
    sku,
    ref: null,
    status: "created",
    txHash: null,
    paidWith: null,
    delivered: false,
    updatedAt: new Date().toISOString(),
  };
  orders.set(shopOrderId, record);

  try {
    // Gọi lại bao nhiêu lần cũng an toàn: cổng thanh toán idempotent theo externalOrderId.
    const { payUrl, order, reused } = await koloPay.createPayment({
      externalOrderId: shopOrderId,
      amountUsd: sku.amountUsd,
      description: sku.name,
      returnUrl: `${SHOP_URL}/don-hang/${shopOrderId}`,
    });

    record.ref = order.ref;
    record.status = order.status;
    record.updatedAt = new Date().toISOString();

    log("①", `tạo đơn ${shopOrderId} → ref ${order.ref}${reused ? " (dùng lại)" : ""}`);
    res.writeHead(302, { location: payUrl }).end();
  } catch (error) {
    const detail =
      error instanceof CardanoPayError ? `${error.message} (HTTP ${error.status})` : String(error);
    log("✗", `tạo đơn hỏng: ${detail}`);

    send(
      res,
      502,
      page(
        "Không tạo được đơn",
        `<h1>Không tạo được đơn thanh toán</h1>
         <p class="lead">Cổng thanh toán trả về: <span class="mono">${escape(detail)}</span></p>
         <div class="panel note">Kiểm tra <span class="mono">${escape(PAY_URL)}</span> đang chạy,
         và <span class="mono">MERCHANT_API_KEYS</span> khớp với khoá shop đang dùng.</div>
         <p><a href="/">← Quay lại</a></p>`,
      ),
    );
  }
}

/* ------------------------------------------------------------------ */
/* ③ Webhook — nguồn tin cậy để giao hàng                              */
/* ------------------------------------------------------------------ */

async function handleWebhook(req: IncomingMessage, res: ServerResponse) {
  // THÂN THÔ, chưa JSON.parse: chữ ký tính trên đúng chuỗi byte đã gửi.
  const raw = await readBody(req);
  const header = req.headers[SIGNATURE_HEADER];
  const result = verifyWebhook(raw, typeof header === "string" ? header : null, WEBHOOK_SECRET);

  if (!result.ok) {
    log("✗", `webhook bị từ chối: ${result.error}`);
    return send(res, 401, JSON.stringify({ error: result.error }), "application/json");
  }

  const { event, data } = result.payload;
  const record = data.externalOrderId ? orders.get(data.externalOrderId) : undefined;

  // Chữ ký hợp lệ mới chứng minh gói tin đến từ cổng thanh toán; nó KHÔNG chứng minh
  // gói tin nói về đúng đơn shop đang giữ. Mã đơn trùng nhau mà `ref` lệch nghĩa là
  // đơn đã bị tạo lại ở cổng — áp vào là giao hàng theo một lần trả không liên quan.
  //
  // `ref` rỗng cũng bị chặn: shop chưa tạo được đơn nào ở cổng thanh toán cho mã này,
  // nên không có gì để đối chiếu, và giao hàng lúc này là giao mù.
  if (record && data.ref !== record.ref) {
    log(
      "✗",
      `webhook nói về ref ${data.ref}, đơn ${record.id} đang giữ ref ${record.ref ?? "(chưa có)"} — bỏ qua`,
    );
    return send(res, 200, JSON.stringify({ ok: true, ignored: "ref mismatch" }), "application/json");
  }

  if (record) {
    record.status = data.status;
    record.txHash = data.tx?.hash ?? null;
    record.paidWith = data.payment?.symbol ?? null;
    record.updatedAt = new Date().toISOString();

    // CHỈ `confirmed` mới được giao hàng. `seen` là đã lên chain nhưng chưa đủ xác nhận.
    if (data.status === "confirmed" && !record.delivered) {
      record.delivered = true;
      log("✓", `GIAO HÀNG: ${record.id} — ${record.sku.name} (${record.paidWith ?? "?"})`);
    }
  }

  log("③", `webhook ${event} → ${data.externalOrderId ?? data.ref} = ${data.status}`);

  // Trả 2xx nhanh; cổng thanh toán thử lại nếu không nhận được.
  send(res, 200, JSON.stringify({ ok: true }), "application/json");
}

/* ------------------------------------------------------------------ */
/* ④ Trang cảm ơn — KHÔNG tin tham số trên URL                         */
/* ------------------------------------------------------------------ */

const STATUS_LABEL: Record<string, string> = {
  created: "Chưa thanh toán",
  pending: "Đang chờ thanh toán",
  seen: "Đã thấy giao dịch, đang chờ đủ xác nhận",
  confirmed: "Đã thanh toán",
  underpaid: "Trả thiếu — cần xử lý tay",
  expired: "Đơn đã hết hạn",
  failed: "Thất bại",
};

async function handleOrderPage(res: ServerResponse, shopOrderId: string) {
  const record = orders.get(shopOrderId);
  if (!record) {
    return send(
      res,
      404,
      page("Không thấy đơn", '<h1>Không thấy đơn này</h1><p><a href="/">← Trang chủ</a></p>'),
    );
  }

  // `?status=` trên URL do khách sửa được trong thanh địa chỉ. Hỏi lại cổng thanh toán
  // trước khi hiện bất cứ điều gì đáng tiền — webhook có thể chưa tới.
  if (record.ref) {
    try {
      const { order } = await koloPay.getPayment(record.ref);
      record.status = order.status;
      record.txHash = order.tx?.hash ?? null;
      record.paidWith = order.payment?.symbol ?? null;

      if (order.status === "confirmed" && !record.delivered) {
        record.delivered = true;
        log("✓", `GIAO HÀNG (qua poll): ${record.id} — ${record.sku.name}`);
      }

      // Chỉ xảy ra khi diễn tập bằng `npm run demo:webhook` trên một đơn chưa trả:
      // shop đã giao vì tin webhook, còn cổng thanh toán thì nói đơn vẫn đang chờ.
      if (order.status !== "confirmed" && record.delivered) {
        log("⚠", `${record.id} đã giao nhưng cổng thanh toán báo "${order.status}" — webhook diễn tập?`);
      }
    } catch {
      /* Không hỏi được thì hiện trạng thái cuối cùng biết được, đừng vỡ trang. */
    }
  }

  const done = record.status === "confirmed";
  const dead =
    record.status === "expired" || record.status === "failed" || record.status === "underpaid";
  const tone = done ? "ok" : dead ? "bad" : "wait";

  const body = `
    <h1>${done ? "Cảm ơn bạn!" : "Đơn hàng của bạn"}</h1>
    <p class="lead">${
      done
        ? `Đã kích hoạt <strong>${escape(record.sku.name)}</strong> cho tài khoản Kolo của bạn.`
        : "Trang này tự làm mới. Trạng thái được hỏi thẳng từ cổng thanh toán, không lấy từ tham số trên URL."
    }</p>
    <div class="panel">
      <dl style="margin:0">
        <div class="row"><dt>Trạng thái</dt><dd><span class="state ${tone}"><span class="dot"></span>${escape(
          STATUS_LABEL[record.status] ?? record.status,
        )}</span></dd></div>
        <div class="row"><dt>Mã đơn Kolo</dt><dd class="mono">${escape(record.id)}</dd></div>
        <div class="row"><dt>Sản phẩm</dt><dd>${escape(record.sku.name)}</dd></div>
        <div class="row"><dt>Số tiền</dt><dd>$${escape(record.sku.amountUsd)} USD</dd></div>
        <div class="row"><dt>Mã ở cổng thanh toán</dt><dd class="mono">${escape(
          record.ref ?? "—",
        )}</dd></div>
        ${
          record.paidWith
            ? `<div class="row"><dt>Trả bằng</dt><dd>${escape(record.paidWith)}</dd></div>`
            : ""
        }
        ${
          record.txHash
            ? `<div class="row"><dt>Giao dịch</dt><dd class="mono">${escape(record.txHash)}</dd></div>`
            : ""
        }
        <div class="row"><dt>Đã giao hàng</dt><dd>${record.delivered ? "rồi" : "chưa"}</dd></div>
      </dl>
    </div>
    ${
      done
        ? '<p><a href="/">← Về trang chủ Kolo</a></p>'
        : `<p class="note">Chưa trả xong? <a href="${escape(PAY_URL)}/pay/${escape(
            record.ref ?? "",
          )}">Mở lại trang thanh toán</a></p>`
    }`;

  send(res, 200, page(done ? "Cảm ơn bạn — Kolo" : "Đơn hàng — Kolo", body, done ? undefined : 4));
}

/* ------------------------------------------------------------------ */
/* Khung server                                                        */
/* ------------------------------------------------------------------ */

function send(res: ServerResponse, status: number, body: string, type = "text/html; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" }).end(body);
}

function readBody(req: IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) reject(new Error("Thân request quá lớn."));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function log(mark: string, message: string) {
  console.log(`  ${mark}  ${new Date().toLocaleTimeString("vi-VN")}  ${message}`);
}

const server = createServer((req, res) => {
  const route = new URL(req.url ?? "/", SHOP_URL).pathname;

  void (async () => {
    try {
      if (req.method === "GET" && route === "/") return send(res, 200, shopPage());

      if (req.method === "POST" && route === "/mua") {
        return handleBuy(res, new URLSearchParams(await readBody(req)));
      }

      if (req.method === "POST" && route === "/api/webhooks/kolo-pay") {
        return handleWebhook(req, res);
      }

      if (req.method === "GET" && route.startsWith("/don-hang/")) {
        return handleOrderPage(res, decodeURIComponent(route.slice("/don-hang/".length)));
      }

      if (req.method === "GET" && route === "/health") {
        return send(res, 200, JSON.stringify({ ok: true, orders: orders.size }), "application/json");
      }

      send(res, 404, page("Không có trang này", '<h1>404</h1><p><a href="/">← Trang chủ</a></p>'));
    } catch (error) {
      console.error(error);
      send(res, 500, page("Lỗi", "<h1>500</h1>"));
    }
  })();
});

server.listen(PORT, () => {
  const warning = WEBHOOK_SECRET
    ? ""
    : "\n  ⚠ Chưa có MERCHANT_WEBHOOK_SECRET — mọi webhook sẽ bị từ chối.\n";

  console.log(`
  Kolo giả lập     →  ${SHOP_URL}
  Cổng thanh toán  →  ${PAY_URL}   (mạng ${NETWORK})
  Webhook nhận ở   →  ${SHOP_URL}/api/webhooks/kolo-pay
${warning}
  Nhật ký luồng thanh toán hiện bên dưới.
`);
});
