/**
 * Chuỗi hiển thị của Kolo giả lập.
 *
 * Cùng cách làm với `src/lib/i18n/dictionaries`: bản tiếng Việt là nguồn sự thật của
 * kiểu, bản tiếng Anh phải khớp — thiếu khoá là lỗi biên dịch chứ không phải một ô
 * trống lặng lẽ hiện ra giữa buổi demo.
 *
 * Nhỏ hơn từ điển của app thật rất nhiều, và cố ý tách khỏi nó: shop là một service
 * riêng, nó không được phép import vào trong `src/` của cổng thanh toán.
 */

export const LOCALES = ["vi", "en"] as const;

export type Locale = (typeof LOCALES)[number];

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** Nhãn trên nút đổi ngôn ngữ — luôn viết bằng chính ngôn ngữ đó. */
export const LOCALE_SHORT: Record<Locale, string> = { vi: "VI", en: "EN" };

const vi = {
  htmlLang: "vi",
  /** Cho toLocaleTimeString ở dòng nhật ký. */
  dateLocale: "vi-VN",
  demoBadge: (network: string) => `Bản demo · ${network}`,
  switchLanguage: "Đổi ngôn ngữ",

  shopTitle: "Kolo — nâng cấp tài khoản",
  shopHeading: "Nâng cấp tài khoản Kolo",
  shopLead:
    "Trả bằng ADA hoặc stablecoin trên Cardano. Không cần thẻ, không qua trung gian — bấm nút là chuyển sang cổng thanh toán của Kolo.",
  buy: "Thanh toán bằng Cardano",

  footer: (payUrl: string) =>
    `Kolo giả lập — dựng để demo cổng thanh toán Kolo Pay đang chạy ở ${payUrl}.`,

  orderTitle: "Đơn hàng — Kolo",
  thanksTitle: "Cảm ơn bạn — Kolo",
  orderHeading: "Đơn hàng của bạn",
  thanksHeading: "Cảm ơn bạn!",
  /*
   * Cắt đôi vì giữa câu có thẻ <strong> bọc tên sản phẩm. Cùng lý do với các khoá
   * body1/body2 trong từ điển của app: ghép lại thành một chuỗi có sẵn HTML là mở
   * đường cho việc nhét thẻ vào chỗ đáng lẽ phải escape. Bản dịch tự do đổi trật tự,
   * kể cả để trống vế đầu như tiếng Anh bên dưới.
   */
  thanksLead1: "Đã kích hoạt",
  thanksLead2: "cho tài khoản Kolo của bạn.",
  orderLead:
    "Trang này tự làm mới. Trạng thái được hỏi thẳng từ cổng thanh toán, không lấy từ tham số trên URL.",

  rowStatus: "Trạng thái",
  rowOrderId: "Mã đơn Kolo",
  rowProduct: "Sản phẩm",
  rowAmount: "Số tiền",
  rowRef: "Mã ở cổng thanh toán",
  rowPaidWith: "Trả bằng",
  rowTx: "Giao dịch",
  rowDelivered: "Đã giao hàng",
  yes: "rồi",
  no: "chưa",

  backHome: "← Về trang chủ Kolo",
  notFinished: "Chưa trả xong?",
  reopenPayPage: "Mở lại trang thanh toán",

  status: {
    created: "Chưa thanh toán",
    pending: "Đang chờ thanh toán",
    seen: "Đã thấy giao dịch, đang chờ đủ xác nhận",
    confirmed: "Đã thanh toán",
    underpaid: "Trả thiếu — cần xử lý tay",
    expired: "Đơn đã hết hạn",
    failed: "Thất bại",
  } as Record<string, string>,

  noSuchProduct: "Không có sản phẩm này",
  notFoundTitle: "Không thấy đơn",
  notFoundHeading: "Không thấy đơn này",
  backToHome: "← Trang chủ",
  noPageTitle: "Không có trang này",
  errorTitle: "Lỗi",

  createFailedTitle: "Không tạo được đơn",
  createFailedHeading: "Không tạo được đơn thanh toán",
  createFailedLead: (detail: string) => `Cổng thanh toán trả về: ${detail}`,
  createFailedHint: (payUrl: string) =>
    `Kiểm tra ${payUrl} đang chạy, và MERCHANT_API_KEYS khớp với khoá shop đang dùng.`,
  back: "← Quay lại",

  /*
   * Nhật ký terminal. Cũng phải dịch: ở bước cuối của kịch bản demo, người trình bày
   * chỉ thẳng vào cửa sổ này để cho thấy webhook đã tới và hàng đã được giao.
   */
  log: {
    labelShop: "Kolo giả lập",
    labelGateway: "Cổng thanh toán",
    labelWebhook: "Webhook nhận ở",
    labelLanguage: "Ngôn ngữ mặc định",
    languageHint: "đổi bằng DEFAULT_LOCALE trong .env.local",
    noWebhookSecret: "⚠ Chưa có MERCHANT_WEBHOOK_SECRET — mọi webhook sẽ bị từ chối.",
    watching: "Nhật ký luồng thanh toán hiện bên dưới.",
    noApiKey: "Thiếu MERCHANT_API_KEYS trong .env.local của cổng thanh toán.",

    orderCreated: (id: string, ref: string, reused: boolean) =>
      `tạo đơn ${id} → ref ${ref}${reused ? " (dùng lại)" : ""}`,
    createFailed: (detail: string) => `tạo đơn hỏng: ${detail}`,
    webhookRejected: (error: string) => `webhook bị từ chối: ${error}`,
    refMismatch: (incoming: string, id: string, held: string) =>
      `webhook nói về ref ${incoming}, đơn ${id} đang giữ ref ${held} — bỏ qua`,
    noRefYet: "(chưa có)",
    delivered: (id: string, product: string, token: string) =>
      `GIAO HÀNG: ${id} — ${product} (${token})`,
    deliveredByPoll: (id: string, product: string) => `GIAO HÀNG (qua poll): ${id} — ${product}`,
    deliveredButUnpaid: (id: string, status: string) =>
      `${id} đã giao nhưng cổng thanh toán báo "${status}" — webhook diễn tập?`,
    webhookReceived: (event: string, id: string, status: string) =>
      `webhook ${event} → ${id} = ${status}`,
  },
};

export type ShopDict = typeof vi;

const en: ShopDict = {
  htmlLang: "en",
  dateLocale: "en-US",
  demoBadge: (network: string) => `Demo · ${network}`,
  switchLanguage: "Change language",

  shopTitle: "Kolo — upgrade your account",
  shopHeading: "Upgrade your Kolo account",
  shopLead:
    "Pay with ADA or a stablecoin on Cardano. No card, no middleman — the button hands you over to Kolo's payment gateway.",
  buy: "Pay with Cardano",

  footer: (payUrl: string) =>
    `Stand-in Kolo — built to demo the Kolo Pay gateway running at ${payUrl}.`,

  orderTitle: "Your order — Kolo",
  thanksTitle: "Thank you — Kolo",
  orderHeading: "Your order",
  thanksHeading: "Thank you!",
  thanksLead1: "",
  thanksLead2: "is now active on your Kolo account.",
  orderLead:
    "This page refreshes itself. The status is read straight from the payment gateway, never from the URL.",

  rowStatus: "Status",
  rowOrderId: "Kolo order id",
  rowProduct: "Product",
  rowAmount: "Amount",
  rowRef: "Gateway reference",
  rowPaidWith: "Paid with",
  rowTx: "Transaction",
  rowDelivered: "Delivered",
  yes: "yes",
  no: "not yet",

  backHome: "← Back to Kolo",
  notFinished: "Not finished paying?",
  reopenPayPage: "Reopen the payment page",

  status: {
    created: "Not paid yet",
    pending: "Awaiting payment",
    seen: "Transaction seen, waiting for confirmations",
    confirmed: "Paid",
    underpaid: "Underpaid — needs a human",
    expired: "The order expired",
    failed: "Failed",
  },

  noSuchProduct: "No such product",
  notFoundTitle: "Order not found",
  notFoundHeading: "No such order",
  backToHome: "← Home",
  noPageTitle: "No such page",
  errorTitle: "Error",

  createFailedTitle: "Could not create the order",
  createFailedHeading: "Could not create the payment order",
  createFailedLead: (detail: string) => `The gateway answered: ${detail}`,
  createFailedHint: (payUrl: string) =>
    `Check that ${payUrl} is running, and that MERCHANT_API_KEYS matches the key the shop is using.`,
  back: "← Back",

  log: {
    labelShop: "Stand-in Kolo",
    labelGateway: "Payment gateway",
    labelWebhook: "Webhooks land at",
    labelLanguage: "Default language",
    languageHint: "change with DEFAULT_LOCALE in .env.local",
    noWebhookSecret: "⚠ No MERCHANT_WEBHOOK_SECRET — every webhook will be rejected.",
    watching: "The payment flow is logged below.",
    noApiKey: "MERCHANT_API_KEYS is missing from the gateway's .env.local.",

    orderCreated: (id: string, ref: string, reused: boolean) =>
      `created order ${id} → ref ${ref}${reused ? " (reused)" : ""}`,
    createFailed: (detail: string) => `could not create the order: ${detail}`,
    webhookRejected: (error: string) => `webhook rejected: ${error}`,
    refMismatch: (incoming: string, id: string, held: string) =>
      `webhook is about ref ${incoming}, order ${id} holds ref ${held} — ignored`,
    noRefYet: "(none yet)",
    delivered: (id: string, product: string, token: string) =>
      `DELIVERED: ${id} — ${product} (${token})`,
    deliveredByPoll: (id: string, product: string) => `DELIVERED (via poll): ${id} — ${product}`,
    deliveredButUnpaid: (id: string, status: string) =>
      `${id} was delivered but the gateway says "${status}" — rehearsal webhook?`,
    webhookReceived: (event: string, id: string, status: string) =>
      `webhook ${event} → ${id} = ${status}`,
  },
};

export const STRINGS: Record<Locale, ShopDict> = { vi, en };
