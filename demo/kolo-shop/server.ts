/**
 * KOLO GIẢ LẬP — dùng để DEMO, không phải mã production.
 *
 * Đây là "dự án bán hàng" trong sơ đồ ở docs/INTEGRATION.md: một service riêng, chạy
 * ở cổng riêng, gọi sang cổng thanh toán qua HTTP y như Kolo thật sẽ làm.
 *
 *   localhost:4100 (Kolo giả lập)            localhost:3000 (Kolo Pay)
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
import {
  isLocale,
  LOCALES,
  LOCALE_SHORT,
  STRINGS,
  type Locale,
  type ShopDict,
} from "./strings.ts";

/* ------------------------------------------------------------------ */
/* Cấu hình                                                            */
/* ------------------------------------------------------------------ */

const here = path.dirname(fileURLToPath(import.meta.url));
const gatewayRoot = path.resolve(here, "../..");
nextEnv.loadEnvConfig(gatewayRoot, true);

const PORT = Number(process.env.KOLO_SHOP_PORT ?? 4100);
const SHOP_URL = process.env.KOLO_SHOP_URL ?? `http://localhost:${PORT}`;
const PAY_URL =
  process.env.KOLO_PAY_URL ?? process.env.PAYMENT_PUBLIC_URL ?? "http://localhost:3000";

/* Shop chỉ được cầm MỘT khoá, dù cổng thanh toán chấp nhận nhiều khoá để xoay vòng. */
const API_KEY = (process.env.MERCHANT_API_KEYS ?? "").split(",")[0]?.trim() ?? "";
const WEBHOOK_SECRET = process.env.MERCHANT_WEBHOOK_SECRET ?? "";
const NETWORK = (process.env.KOLO_SHOP_NETWORK ?? "preprod") as "mainnet" | "preprod" | "preview";

/*
 * Ngôn ngữ mặc định lấy từ CÙNG biến mà cổng thanh toán đọc, nên đặt DEFAULT_LOCALE=en
 * một lần là cả hai bên cùng mở ra tiếng Anh — không có màn shop tiếng Việt bàn giao
 * sang trang thanh toán tiếng Anh giữa buổi demo.
 */
const DEFAULT_LOCALE: Locale = isLocale(process.env.DEFAULT_LOCALE?.trim())
  ? (process.env.DEFAULT_LOCALE!.trim() as Locale)
  : "vi";

/*
 * Cookie trùng tên với cookie của cổng thanh toán. Cookie phân định theo HOST chứ
 * không theo cổng, nên khi cả hai cùng chạy trên localhost, bấm đổi ngôn ngữ ở bên
 * nào thì bên kia cũng đi theo — tiện đúng cho demo.
 *
 * ĐỪNG dựa vào chuyện này khi ghép Kolo thật: hai domain khác nhau thì không dùng
 * chung cookie, lúc đó shop phải truyền ngôn ngữ sang cổng một cách tường minh.
 */
const LOCALE_COOKIE = "cardano_locale";

/** Nhật ký terminal đi theo ngôn ngữ mặc định — nó là một dòng chảy, không theo request. */
const logDict = STRINGS[DEFAULT_LOCALE];
const L = logDict.log;

if (!API_KEY) {
  console.error(L.noApiKey);
  process.exit(1);
}

const koloPay = createCardanoPayClient({ baseUrl: PAY_URL, apiKey: API_KEY, network: NETWORK });

/* ------------------------------------------------------------------ */
/* "Kho hàng" và "database" của shop                                   */
/* ------------------------------------------------------------------ */

type Sku = {
  id: string;
  amountUsd: string;
  name: Record<Locale, string>;
  blurb: Record<Locale, string>;
};

/**
 * Giá LUÔN đến từ đây, không bao giờ từ request. Nhận giá do trình duyệt gửi lên là
 * để khách tự ra giá cho hàng của mình.
 */
const CATALOG: Sku[] = [
  {
    id: "pro-thang",
    amountUsd: "4.90",
    name: { vi: "Kolo Pro — 1 tháng", en: "Kolo Pro — 1 month" },
    blurb: {
      vi: "Lưu bộ sưu tập công cụ, bỏ giới hạn lượt tính, xuất kết quả ra Excel.",
      en: "Save tool collections, drop the usage cap, export results to Excel.",
    },
  },
  {
    id: "pro-nam",
    amountUsd: "49.00",
    name: { vi: "Kolo Pro — 1 năm", en: "Kolo Pro — 1 year" },
    blurb: {
      vi: "Như gói tháng, trả trước 12 tháng và tiết kiệm hai tháng.",
      en: "The monthly plan paid twelve months up front — two months free.",
    },
  },
  {
    id: "bo-ban-hang",
    amountUsd: "9.90",
    name: { vi: "Bộ công cụ Bán hàng", en: "Sales toolkit" },
    blurb: {
      vi: "15 công cụ tính giá vốn, chiết khấu, hoa hồng và điểm hoà vốn. Mua một lần.",
      en: "15 calculators for cost, discount, commission and breakeven. One-off purchase.",
    },
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
/* Ngôn ngữ của một request                                            */
/* ------------------------------------------------------------------ */

function readLocale(req: IncomingMessage): Locale {
  const raw = req.headers.cookie ?? "";

  for (const part of raw.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== LOCALE_COOKIE) continue;

    const value = decodeURIComponent(part.slice(index + 1).trim());
    if (isLocale(value)) return value;
  }

  return DEFAULT_LOCALE;
}

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
.bar{display:flex;align-items:center;justify-content:space-between;height:64px;gap:16px}
.brand{font-size:22px;font-weight:700;color:var(--text);text-decoration:none;letter-spacing:-.01em}
.bar-right{display:flex;align-items:center;gap:12px}
.chip{display:inline-block;background:var(--bg-green-soft);color:var(--green);
  border-radius:999px;padding:4px 12px;font-size:13px;font-weight:600}
.lang{display:inline-flex;border:1px solid var(--border);border-radius:var(--r-btn);overflow:hidden}
.lang a{display:block;padding:5px 11px;font-size:13px;font-weight:600;text-decoration:none;
  color:var(--text-2);background:var(--bg)}
.lang a:hover{background:var(--bg-2)}
.lang a[aria-current="true"]{background:var(--bg-green-soft);color:var(--green)}
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

/** Nút đổi ngôn ngữ giữ nguyên đường dẫn hiện tại, chỉ thêm `?lang=`. */
function languageSwitch(t: ShopDict, locale: Locale, route: string) {
  const buttons = LOCALES.map((candidate) => {
    const href = `${route}?lang=${candidate}`;
    const current = candidate === locale ? ' aria-current="true"' : "";
    return `<a href="${escape(href)}"${current}>${LOCALE_SHORT[candidate]}</a>`;
  }).join("");

  return `<nav class="lang" aria-label="${escape(t.switchLanguage)}">${buttons}</nav>`;
}

function page(
  t: ShopDict,
  locale: Locale,
  route: string,
  title: string,
  body: string,
  refreshSeconds?: number,
) {
  const refresh = refreshSeconds
    ? `<meta http-equiv="refresh" content="${refreshSeconds}">`
    : "";

  return `<!doctype html><html lang="${t.htmlLang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title>${refresh}
<style>${CSS}</style></head><body>
<header><div class="bar"><a class="brand" href="/">Kolo</a>
<div class="bar-right"><span class="chip">${escape(t.demoBadge(NETWORK))}</span>
${languageSwitch(t, locale, route)}</div></div></header>
<main class="wrap">${body}</main>
<footer class="wrap">${escape(t.footer(PAY_URL))}</footer></body></html>`;
}

/* ------------------------------------------------------------------ */
/* Trang chủ shop                                                      */
/* ------------------------------------------------------------------ */

function shopPage(t: ShopDict, locale: Locale) {
  const cards = CATALOG.map(
    (sku) => `<div class="card">
      <h2>${escape(sku.name[locale])}</h2>
      <p>${escape(sku.blurb[locale])}</p>
      <div class="price">$${escape(sku.amountUsd)} <span>USD</span></div>
      <form method="post" action="/mua"><input type="hidden" name="sku" value="${escape(sku.id)}">
      <button type="submit">${escape(t.buy)}</button></form>
    </div>`,
  ).join("");

  return page(
    t,
    locale,
    "/",
    t.shopTitle,
    `<h1>${escape(t.shopHeading)}</h1>
     <p class="lead">${escape(t.shopLead)}</p>
     <div class="grid">${cards}</div>`,
  );
}

/* ------------------------------------------------------------------ */
/* ① Khách bấm mua → tạo đơn ở cổng thanh toán → redirect              */
/* ------------------------------------------------------------------ */

async function handleBuy(res: ServerResponse, form: URLSearchParams, t: ShopDict, locale: Locale) {
  const sku = CATALOG.find((item) => item.id === form.get("sku"));
  if (!sku) {
    return send(res, 400, page(t, locale, "/", t.errorTitle, `<h1>${escape(t.noSuchProduct)}</h1>`));
  }

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
      // Mô tả gửi sang cổng theo ngôn ngữ khách đang xem: nó hiện lại trên trang
      // thanh toán, và đổi ngôn ngữ giữa hai trang là điều khách sẽ để ý ngay.
      description: sku.name[locale],
      returnUrl: `${SHOP_URL}/don-hang/${shopOrderId}`,
    });

    record.ref = order.ref;
    record.status = order.status;
    record.updatedAt = new Date().toISOString();

    log("①", L.orderCreated(shopOrderId, order.ref, reused));
    res.writeHead(302, { location: payUrl }).end();
  } catch (error) {
    const detail =
      error instanceof CardanoPayError ? `${error.message} (HTTP ${error.status})` : String(error);
    log("✗", L.createFailed(detail));

    send(
      res,
      502,
      page(
        t,
        locale,
        "/",
        t.createFailedTitle,
        `<h1>${escape(t.createFailedHeading)}</h1>
         <p class="lead">${escape(t.createFailedLead(detail))}</p>
         <div class="panel note">${escape(t.createFailedHint(PAY_URL))}</div>
         <p><a href="/">${escape(t.back)}</a></p>`,
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
    log("✗", L.webhookRejected(result.error));
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
    log("✗", L.refMismatch(data.ref, record.id, record.ref ?? L.noRefYet));
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
      log("✓", L.delivered(record.id, record.sku.name[DEFAULT_LOCALE], record.paidWith ?? "?"));
    }
  }

  log("③", L.webhookReceived(event, data.externalOrderId ?? data.ref, data.status));

  // Trả 2xx nhanh; cổng thanh toán thử lại nếu không nhận được.
  send(res, 200, JSON.stringify({ ok: true }), "application/json");
}

/* ------------------------------------------------------------------ */
/* ④ Trang cảm ơn — KHÔNG tin tham số trên URL                         */
/* ------------------------------------------------------------------ */

async function handleOrderPage(
  res: ServerResponse,
  shopOrderId: string,
  t: ShopDict,
  locale: Locale,
) {
  const route = `/don-hang/${encodeURIComponent(shopOrderId)}`;
  const record = orders.get(shopOrderId);

  if (!record) {
    return send(
      res,
      404,
      page(
        t,
        locale,
        route,
        t.notFoundTitle,
        `<h1>${escape(t.notFoundHeading)}</h1><p><a href="/">${escape(t.backToHome)}</a></p>`,
      ),
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
        log("✓", L.deliveredByPoll(record.id, record.sku.name[DEFAULT_LOCALE]));
      }

      // Chỉ xảy ra khi diễn tập bằng `npm run demo:webhook` trên một đơn chưa trả:
      // shop đã giao vì tin webhook, còn cổng thanh toán thì nói đơn vẫn đang chờ.
      if (order.status !== "confirmed" && record.delivered) {
        log("⚠", L.deliveredButUnpaid(record.id, order.status));
      }
    } catch {
      /* Không hỏi được thì hiện trạng thái cuối cùng biết được, đừng vỡ trang. */
    }
  }

  const done = record.status === "confirmed";
  const dead =
    record.status === "expired" || record.status === "failed" || record.status === "underpaid";
  const tone = done ? "ok" : dead ? "bad" : "wait";
  const product = record.sku.name[locale];

  const body = `
    <h1>${escape(done ? t.thanksHeading : t.orderHeading)}</h1>
    <p class="lead">${
      done
        ? `${escape(t.thanksLead1)} <strong>${escape(product)}</strong> ${escape(t.thanksLead2)}`
        : escape(t.orderLead)
    }</p>
    <div class="panel">
      <dl style="margin:0">
        <div class="row"><dt>${escape(t.rowStatus)}</dt><dd><span class="state ${tone}"><span class="dot"></span>${escape(
          t.status[record.status] ?? record.status,
        )}</span></dd></div>
        <div class="row"><dt>${escape(t.rowOrderId)}</dt><dd class="mono">${escape(record.id)}</dd></div>
        <div class="row"><dt>${escape(t.rowProduct)}</dt><dd>${escape(product)}</dd></div>
        <div class="row"><dt>${escape(t.rowAmount)}</dt><dd>$${escape(record.sku.amountUsd)} USD</dd></div>
        <div class="row"><dt>${escape(t.rowRef)}</dt><dd class="mono">${escape(
          record.ref ?? "—",
        )}</dd></div>
        ${
          record.paidWith
            ? `<div class="row"><dt>${escape(t.rowPaidWith)}</dt><dd>${escape(record.paidWith)}</dd></div>`
            : ""
        }
        ${
          record.txHash
            ? `<div class="row"><dt>${escape(t.rowTx)}</dt><dd class="mono">${escape(record.txHash)}</dd></div>`
            : ""
        }
        <div class="row"><dt>${escape(t.rowDelivered)}</dt><dd>${escape(
          record.delivered ? t.yes : t.no,
        )}</dd></div>
      </dl>
    </div>
    ${
      done
        ? `<p><a href="/">${escape(t.backHome)}</a></p>`
        : `<p class="note">${escape(t.notFinished)} <a href="${escape(PAY_URL)}/pay/${escape(
            record.ref ?? "",
          )}">${escape(t.reopenPayPage)}</a></p>`
    }`;

  send(
    res,
    200,
    page(t, locale, route, done ? t.thanksTitle : t.orderTitle, body, done ? undefined : 4),
  );
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
  console.log(`  ${mark}  ${new Date().toLocaleTimeString(logDict.dateLocale)}  ${message}`);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", SHOP_URL);
  const route = url.pathname;

  void (async () => {
    try {
      /*
       * `?lang=` ghi cookie rồi chuyển hướng về chính đường dẫn đó, sạch tham số.
       * Làm ở server thay vì bằng JS để trang vẫn đổi được ngôn ngữ khi tắt script,
       * và để URL sau khi bấm không dính tham số đem đi chia sẻ nhầm.
       */
      const requested = url.searchParams.get("lang");
      if (req.method === "GET" && isLocale(requested)) {
        return res
          .writeHead(302, {
            location: route,
            "set-cookie": `${LOCALE_COOKIE}=${requested}; Path=/; Max-Age=31536000; SameSite=Lax`,
          })
          .end();
      }

      const locale = readLocale(req);
      const t = STRINGS[locale];

      if (req.method === "GET" && route === "/") return send(res, 200, shopPage(t, locale));

      if (req.method === "POST" && route === "/mua") {
        return handleBuy(res, new URLSearchParams(await readBody(req)), t, locale);
      }

      // Webhook đến từ máy chủ, không từ trình duyệt — không có ngôn ngữ nào ở đây.
      if (req.method === "POST" && route === "/api/webhooks/kolo-pay") {
        return handleWebhook(req, res);
      }

      if (req.method === "GET" && route.startsWith("/don-hang/")) {
        return handleOrderPage(
          res,
          decodeURIComponent(route.slice("/don-hang/".length)),
          t,
          locale,
        );
      }

      if (req.method === "GET" && route === "/health") {
        return send(res, 200, JSON.stringify({ ok: true, orders: orders.size }), "application/json");
      }

      send(
        res,
        404,
        page(
          t,
          locale,
          "/",
          t.noPageTitle,
          `<h1>404</h1><p><a href="/">${escape(t.backToHome)}</a></p>`,
        ),
      );
    } catch (error) {
      console.error(error);
      send(res, 500, "<h1>500</h1>");
    }
  })();
});

server.listen(PORT, () => {
  // Nhãn dài ngắn khác nhau giữa hai thứ tiếng, nên căn cột theo nhãn dài nhất thay
  // vì đếm dấu cách bằng tay trong từng bản dịch.
  const rows: [string, string][] = [
    [L.labelShop, SHOP_URL],
    [L.labelGateway, `${PAY_URL}   (${NETWORK})`],
    [L.labelWebhook, `${SHOP_URL}/api/webhooks/kolo-pay`],
    [L.labelLanguage, `${DEFAULT_LOCALE}   (${L.languageHint})`],
  ];

  const width = Math.max(...rows.map(([label]) => label.length));
  const banner = rows.map(([label, value]) => `  ${label.padEnd(width)} →  ${value}`).join("\n");
  const warning = WEBHOOK_SECRET ? "" : `\n  ${L.noWebhookSecret}\n`;

  console.log(`\n${banner}\n${warning}\n  ${L.watching}\n`);
});
