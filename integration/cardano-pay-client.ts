/**
 * Client dành cho DỰ ÁN BÁN HÀNG — copy file này vào repo shop.
 *
 * Không phụ thuộc package nào ngoài `node:crypto`. Chạy được trên Node 18+, Next.js
 * App Router, Express, Fastify.
 *
 * File này được giữ song song với `src/lib/webhook.ts` bên dịch vụ thanh toán. Thuật
 * toán ký nằm ở cả hai nơi vì hai nơi deploy độc lập; sửa một bên mà quên bên kia thì
 * chữ ký ngừng khớp, và triệu chứng (webhook trả 401 hàng loạt) không hề chỉ về nguyên
 * nhân. Có sửa thì sửa cả hai.
 *
 *   ┌──────────── shop.com ────────────┐        ┌──── pay.shop.com ────┐
 *   │ createPayment()  ────────────────┼───────►│ POST /api/v1/orders  │
 *   │ redirect(payUrl) ────────────────┼──khách►│ /pay/<ref>           │
 *   │ POST /api/webhooks/cardano-pay ◄─┼────────│ webhook đã ký HMAC   │
 *   └──────────────────────────────────┘        └──────────────────────┘
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/* ------------------------------------------------------------------ */
/* Kiểu dữ liệu                                                        */
/* ------------------------------------------------------------------ */

export type CardanoNetwork = "mainnet" | "preprod" | "preview";

export type OrderStatus =
  /** Đã tạo, chưa nhận được tiền. */
  | "pending"
  /** Giao dịch đã lên chain nhưng CHƯA đủ xác nhận. KHÔNG giao hàng ở trạng thái này. */
  | "seen"
  /** Đã đủ xác nhận. Đây là trạng thái duy nhất được phép giao hàng. */
  | "confirmed"
  /** Tiền đã về nhưng thiếu, hoặc về sau khi tỷ giá đã hết hạn. Cần người xử lý. */
  | "underpaid"
  /** Hết hạn mà không ai trả. Nhả hàng đang giữ trong kho. */
  | "expired"
  | "failed";

export type PaymentOrder = {
  ref: string;
  network: CardanoNetwork;
  status: OrderStatus;
  paymentMode: "direct" | "escrow";

  /** Chuỗi thập phân, ví dụ "42.00". KHÔNG parse thành float để so sánh tiền. */
  amountUsd: string;
  /** Cùng số tiền, đơn vị micro-USD (10^-6), dạng chuỗi. Dùng cái này để so sánh. */
  amountUsdMicro: string;
  description: string | null;
  externalOrderId: string | null;
  returnUrl: string | null;

  merchantAddress: string;
  buyerAddress: string | null;

  payment: {
    unit: string;
    symbol: string | null;
    decimals: number;
    quantity: string;
    quantityFormatted: string;
    adaRate: string | null;
    adaRateUsd: string | null;
    rateSources: string[] | null;
    quoteExpiresAt: string | null;
    quoteExpired: boolean;
  } | null;

  tx: {
    hash: string;
    blockHeight: string | null;
    confirmations: number;
    receivedQuantity: string | null;
    metadataOk: boolean | null;
  } | null;

  createdAt: string;
  expiresAt: string;
  confirmedAt: string | null;
};

export type WebhookEvent =
  | "order.seen"
  | "order.confirmed"
  | "order.underpaid"
  | "order.expired"
  | "order.failed";

export type WebhookPayload = {
  event: WebhookEvent;
  occurredAt: string;
  data: PaymentOrder;
};

export class CardanoPayError extends Error {
  // Gán tường minh chứ không dùng parameter property (`constructor(readonly status)`):
  // cú pháp đó cần trình biên dịch sinh thêm mã, nên nó không chạy được ở chế độ chỉ
  // bóc kiểu của Node — mà đó chính là cách `verify:integration` nạp file này.
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "CardanoPayError";
    this.status = status;
    this.body = body;
  }
}

/* ------------------------------------------------------------------ */
/* Client                                                              */
/* ------------------------------------------------------------------ */

export type ClientOptions = {
  /** Ví dụ "https://pay.shop.com". */
  baseUrl: string;
  /** Giá trị nằm trong MERCHANT_API_KEYS của cổng thanh toán. CHỈ dùng ở server. */
  apiKey: string;
  /** Mạng mặc định cho mọi lời gọi. */
  network: CardanoNetwork;
  timeoutMs?: number;
};

export type CreatePaymentInput = {
  /** Mã đơn phía shop. NÊN LUÔN có: đây là thứ làm cho lời gọi này idempotent. */
  externalOrderId: string;
  /** Chuỗi thập phân, tối đa 6 chữ số sau dấu chấm. Truyền "42.00", đừng truyền 42.0. */
  amountUsd: string;
  description?: string;
  /** Origin phải nằm trong MERCHANT_RETURN_URL_ORIGINS của cổng thanh toán. */
  returnUrl?: string;
  network?: CardanoNetwork;
};

export type CreatePaymentResult = {
  order: PaymentOrder;
  /** Redirect khách sang đây. */
  payUrl: string;
  /** true = đơn này đã tồn tại từ trước, không có đơn mới nào được tạo. */
  reused: boolean;
};

export function createCardanoPayClient(options: ClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? 15_000;

  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${options.apiKey}`,
        ...init.headers,
      },
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });

    const body: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      const message =
        body && typeof body === "object" && "error" in body
          ? String((body as { error: unknown }).error)
          : `HTTP ${response.status}`;
      throw new CardanoPayError(message, response.status, body);
    }

    return body as T;
  }

  return {
    /**
     * Tạo (hoặc lấy lại) đơn thanh toán.
     *
     * IDEMPOTENT theo `externalOrderId`: gọi lại với cùng mã đơn trả về đúng đơn cũ
     * kèm `reused: true`. Nhờ vậy bạn KHÔNG cần tự chống trùng — cứ gọi thẳng mỗi lần
     * khách bấm "Thanh toán", kể cả sau khi request trước timeout.
     *
     * Cùng mã đơn nhưng khác số tiền thì bị từ chối bằng 409, vì đó là lỗi thật ở phía
     * shop chứ không phải một lần thử lại.
     */
    async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
      return call<CreatePaymentResult>("/api/v1/orders", {
        method: "POST",
        body: JSON.stringify({
          network: input.network ?? options.network,
          amountUsd: input.amountUsd,
          externalOrderId: input.externalOrderId,
          description: input.description,
          returnUrl: input.returnUrl,
        }),
      });
    },

    /**
     * Đọc trạng thái theo `ref`.
     *
     * ĐÂY LÀ NGUỒN SỰ THẬT. Tham số trên URL quay về thì khách sửa được trong thanh
     * địa chỉ; gọi hàm này trước khi giao thứ gì đáng tiền.
     */
    async getPayment(ref: string): Promise<{ order: PaymentOrder; payUrl: string }> {
      return call(`/api/v1/orders/${encodeURIComponent(ref)}`);
    },

    /** Tra ngược từ mã đơn của shop — dùng khi mất `ref`. */
    async getPaymentByOrderId(
      externalOrderId: string,
      network?: CardanoNetwork,
    ): Promise<{ order: PaymentOrder; payUrl: string }> {
      const params = new URLSearchParams({
        network: network ?? options.network,
        externalOrderId,
      });
      return call(`/api/v1/orders?${params}`);
    },

    /** Xếp lại hàng đợi webhook cho một đơn. Dùng sau khi sửa cấu hình webhook. */
    async replayWebhooks(ref: string): Promise<{ ref: string; requeued: number }> {
      return call(`/api/v1/orders/${encodeURIComponent(ref)}/replay`, { method: "POST" });
    },
  };
}

export type CardanoPayClient = ReturnType<typeof createCardanoPayClient>;

/* ------------------------------------------------------------------ */
/* Xác minh webhook                                                    */
/* ------------------------------------------------------------------ */

export const SIGNATURE_HEADER = "x-cardano-pay-signature";

export type VerifyResult = { ok: true; payload: WebhookPayload } | { ok: false; error: string };

/**
 * Xác minh và giải mã một webhook.
 *
 * PHẢI truyền THÂN REQUEST THÔ, chưa qua JSON.parse.
 *
 * Chữ ký được tính trên đúng chuỗi byte đã gửi. `JSON.parse` rồi `JSON.stringify` lại
 * sẽ đổi thứ tự khoá, khoảng trắng và cách escape ký tự Unicode — chuỗi kết quả nhìn
 * "tương đương" với mắt người nhưng băm ra một giá trị khác, và mọi webhook đều trượt.
 *
 * Trong Next.js App Router:
 *
 *   const raw = await request.text();
 *   const result = verifyWebhook(raw, request.headers.get(SIGNATURE_HEADER), secret);
 *
 * KHÔNG dùng `await request.json()` ở route này.
 */
export function verifyWebhook(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
  toleranceSeconds = 300,
): VerifyResult {
  if (!signatureHeader) return { ok: false, error: "Thiếu header chữ ký." };
  if (!secret) return { ok: false, error: "Thiếu khoá ký ở phía shop." };

  const parts: Record<string, string> = {};
  for (const part of signatureHeader.split(",")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    parts[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }

  const timestamp = Number(parts.t);
  const presented = parts.v1;
  if (!Number.isInteger(timestamp) || !presented) {
    return { ok: false, error: "Header chữ ký sai định dạng." };
  }

  // Cửa sổ thời gian là thứ chặn tấn công phát lại: không có nó, một gói tin
  // "order.confirmed" bắt được hôm nay vẫn dùng được vào năm sau.
  const age = Math.abs(Math.floor(Date.now() / 1_000) - timestamp);
  if (age > toleranceSeconds) return { ok: false, error: `Chữ ký quá cũ (${age}s).` };

  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest();

  let actual: Buffer;
  try {
    actual = Buffer.from(presented, "hex");
  } catch {
    return { ok: false, error: "Chữ ký không phải hex." };
  }

  // `timingSafeEqual` ném lỗi khi độ dài lệch, nên phải chặn trước — và so sánh phải
  // không thoát sớm, để thời gian phản hồi không tiết lộ mình khớp được bao nhiêu byte.
  if (expected.length !== actual.length) return { ok: false, error: "Chữ ký không khớp." };
  if (!timingSafeEqual(expected, actual)) return { ok: false, error: "Chữ ký không khớp." };

  try {
    return { ok: true, payload: JSON.parse(rawBody) as WebhookPayload };
  } catch {
    return { ok: false, error: "Thân request không phải JSON hợp lệ." };
  }
}
