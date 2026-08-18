import "server-only";

import type { PoolClient } from "pg";

import { query, withTransaction } from "@/lib/db";
import {
  ATTEMPT_HEADER,
  DELIVERY_HEADER,
  EVENT_HEADER,
  signPayload,
  SIGNATURE_HEADER,
} from "@/lib/webhook-signature";

/**
 * Báo ngược về dự án bán hàng khi trạng thái đơn đổi.
 *
 * MÔ HÌNH HỘP THƯ ĐI (outbox), không phải gọi HTTP thẳng.
 *
 * Lý do: lời gọi HTTP thất bại được, còn transaction đổi trạng thái thì ĐÃ commit.
 * Nếu gọi thẳng ngay sau khi commit rồi mạng hỏng, đơn ở trạng thái `confirmed` mà
 * shop không bao giờ biết — tiền đã về ví nhưng hàng không được giao, và không có gì
 * trong hệ thống ghi lại rằng đã có một thông báo bị mất.
 *
 * Ghi sự kiện vào CÙNG transaction với việc đổi trạng thái thì hai chuyện đó không
 * bao giờ lệch nhau. Việc gửi đi trở thành một vòng lặp riêng, thử lại được, và trả
 * lời được câu "đơn này đã báo về shop chưa".
 *
 * ĐẢM BẢO: ít nhất một lần (at-least-once). Shop PHẢI xử lý idempotent theo `ref` —
 * xem docs/INTEGRATION.md.
 */

const URL_ENV = "MERCHANT_WEBHOOK_URL";
const SECRET_ENV = "MERCHANT_WEBHOOK_SECRET";

/** Khoá ký ngắn hơn mức này thì brute-force được, và chữ ký chỉ còn là trang trí. */
const MIN_SECRET_LENGTH = 32;

/** Bỏ cuộc sau ngần này lần. ~10 tiếng theo lịch backoff bên dưới. */
const MAX_ATTEMPTS = 8;

/**
 * Backoff luỹ thừa có trần, tính bằng giây, theo số lần đã thử.
 *
 * Dày ở đầu (shop vừa deploy lại, hoặc nấc một nhịp) rồi giãn nhanh ra: hỏng thật thì
 * thử lại mỗi 10 giây suốt nhiều tiếng chỉ tổ đốt tài nguyên hai bên và làm ngập log.
 */
const BACKOFF_SECONDS = [10, 30, 120, 300, 900, 3_600, 10_800, 21_600];

/** Endpoint chậm thì coi như hỏng. Giữ ngắn để một shop treo không chặn cả hàng đợi. */
const REQUEST_TIMEOUT_MS = 10_000;

/** Mỗi lượt gửi bao nhiêu sự kiện. */
const DISPATCH_BATCH = 20;

/* ------------------------------------------------------------------ */
/* Cấu hình                                                            */
/* ------------------------------------------------------------------ */

export type WebhookConfig = { ok: true; url: string; secret: string } | { ok: false; error: string };

export function resolveWebhookConfig(): WebhookConfig {
  const url = process.env[URL_ENV]?.trim();
  const secret = process.env[SECRET_ENV]?.trim();

  if (!url && !secret) return { ok: false, error: `Chưa cấu hình ${URL_ENV}/${SECRET_ENV}.` };
  if (!url) return { ok: false, error: `Thiếu ${URL_ENV}.` };
  if (!secret) return { ok: false, error: `Thiếu ${SECRET_ENV}.` };

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: `${URL_ENV} không phải URL hợp lệ.` };
  }

  if (parsed.protocol !== "https:" && process.env.NODE_ENV === "production") {
    // Thân webhook chứa số tiền, txHash và mã đơn của shop. http ở production là gửi
    // sổ sách kinh doanh đi dưới dạng thô.
    return { ok: false, error: `${URL_ENV} phải dùng https ở production.` };
  }

  if (secret.length < MIN_SECRET_LENGTH) {
    return {
      ok: false,
      error: `${SECRET_ENV} phải dài ít nhất ${MIN_SECRET_LENGTH} ký tự. Sinh: openssl rand -hex 32`,
    };
  }

  return { ok: true, url: parsed.toString(), secret };
}

export function isWebhookConfigured(): boolean {
  return resolveWebhookConfig().ok;
}

/* ------------------------------------------------------------------ */
/* Chữ ký                                                              */
/* ------------------------------------------------------------------ */

/**
 * Thuật toán ký nằm ở `webhook-signature.ts` — module thuần, không kéo theo Postgres,
 * nên `verify:integration` import được nó cạnh bản sao dành cho shop và chứng minh hai
 * bên đồng ý với nhau. Re-export ở đây để nơi gọi không phải biết chuyện đó.
 */
export {
  ATTEMPT_HEADER,
  DELIVERY_HEADER,
  EVENT_HEADER,
  signPayload,
  SIGNATURE_HEADER,
  verifySignature,
} from "@/lib/webhook-signature";

/* ------------------------------------------------------------------ */
/* Xếp hàng                                                            */
/* ------------------------------------------------------------------ */

/**
 * Sự kiện gửi về shop.
 *
 * `order.seen` là tin trung gian ("tiền đang trên đường") — hữu ích để hiện trạng thái
 * cho khách, nhưng KHÔNG được dùng để giao hàng: giao dịch chưa đủ xác nhận vẫn có thể
 * biến mất khỏi chain.
 */
export type WebhookEvent =
  | "order.seen"
  | "order.confirmed"
  | "order.underpaid"
  | "order.expired"
  | "order.failed";

const STATUS_TO_EVENT: Record<string, WebhookEvent | undefined> = {
  // Tạo đơn không phải sự kiện — shop vừa gọi API xong, nó đã biết.
  pending: undefined,
  seen: "order.seen",
  confirmed: "order.confirmed",
  underpaid: "order.underpaid",
  expired: "order.expired",
  failed: "order.failed",
};

export function eventForStatus(status: string): WebhookEvent | null {
  return STATUS_TO_EVENT[status] ?? null;
}

/**
 * Xếp một sự kiện vào hộp thư đi. PHẢI gọi trong cùng transaction với lệnh đổi trạng thái.
 *
 * Chưa cấu hình webhook thì lặng lẽ bỏ qua: rất nhiều lúc chạy dự án này một mình
 * (demo, kiểm thử, chưa ghép shop), và khi đó dồn một hàng đợi không ai gửi là vô nghĩa.
 *
 * `ON CONFLICT DO NOTHING` dựa trên UNIQUE(order_id, event): watcher quét lặp và có
 * thể thấy cùng một chuyển trạng thái nhiều lượt.
 */
export async function enqueueWebhook(
  client: PoolClient,
  input: { orderId: string; event: WebhookEvent; payload: unknown },
): Promise<void> {
  const config = resolveWebhookConfig();
  if (!config.ok) return;

  await client.query(
    `INSERT INTO payment_webhook_deliveries (order_id, event, target_url, payload)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (order_id, event) DO NOTHING`,
    [input.orderId, input.event, config.url, JSON.stringify(input.payload)],
  );
}

/* ------------------------------------------------------------------ */
/* Gửi đi                                                              */
/* ------------------------------------------------------------------ */

type DeliveryRow = {
  id: string;
  order_id: string;
  event: string;
  target_url: string;
  payload: unknown;
  attempts: number;
};

export type DispatchSummary = {
  claimed: number;
  delivered: number;
  retrying: number;
  failed: number;
  skipped?: string;
};

const backoffFor = (attempts: number): number =>
  BACKOFF_SECONDS[Math.min(Math.max(attempts, 1), BACKOFF_SECONDS.length) - 1]!;

/**
 * Gửi các sự kiện tới hạn.
 *
 * Gọi từ endpoint watcher (đã có cron sẵn) và gọi thêm ngay sau khi đổi trạng thái để
 * shop nhận tin trong vòng một giây thay vì chờ lượt cron kế tiếp.
 *
 * `FOR UPDATE SKIP LOCKED` cho phép nhiều instance cùng chạy vòng lặp này mà không
 * gửi trùng: instance nào lấy được dòng thì instance kia bỏ qua dòng đó.
 */
export async function dispatchDueWebhooks(limit = DISPATCH_BATCH): Promise<DispatchSummary> {
  const config = resolveWebhookConfig();
  if (!config.ok) return { claimed: 0, delivered: 0, retrying: 0, failed: 0, skipped: config.error };

  // Tăng `attempts` và đẩy `next_attempt_at` ra NGAY lúc nhận việc, trước khi gửi.
  // Tiến trình chết giữa lúc gửi thì dòng vẫn ở `pending` và sẽ được thử lại sau —
  // chứ không bị một tiến trình khác bốc lên gửi song song ngay lập tức.
  const claimed = await withTransaction(async (client) => {
    const { rows } = await client.query<DeliveryRow>(
      `UPDATE payment_webhook_deliveries AS d
          SET attempts = d.attempts + 1,
              next_attempt_at = now() + make_interval(secs => $2)
         FROM (
           SELECT id FROM payment_webhook_deliveries
            WHERE status = 'pending' AND next_attempt_at <= now()
            ORDER BY next_attempt_at
            LIMIT $1
            FOR UPDATE SKIP LOCKED
         ) AS due
        WHERE d.id = due.id
        RETURNING d.id, d.order_id, d.event, d.target_url, d.payload, d.attempts`,
      [limit, BACKOFF_SECONDS[0]],
    );
    return rows;
  });

  let delivered = 0;
  let retrying = 0;
  let failed = 0;

  for (const row of claimed) {
    const result = await deliverOne(config.secret, row);

    if (result.ok) {
      delivered++;
      await query(
        `UPDATE payment_webhook_deliveries
            SET status = 'delivered', delivered_at = now(), response_status = $2, last_error = NULL
          WHERE id = $1`,
        [row.id, result.status],
      );
      await query("UPDATE payment_orders SET webhooks_delivered = webhooks_delivered + 1 WHERE id = $1", [
        row.order_id,
      ]);
      continue;
    }

    const exhausted = row.attempts >= MAX_ATTEMPTS;
    if (exhausted) failed++;
    else retrying++;

    await query(
      `UPDATE payment_webhook_deliveries
          SET status = $2,
              next_attempt_at = now() + make_interval(secs => $3),
              response_status = $4,
              last_error = $5
        WHERE id = $1`,
      [
        row.id,
        exhausted ? "failed" : "pending",
        exhausted ? 0 : backoffFor(row.attempts + 1),
        result.status,
        result.error.slice(0, 500),
      ],
    );

    if (exhausted) {
      // Bỏ cuộc là chuyện phải hét lên. Đến đây nghĩa là shop KHÔNG biết về một đơn đã
      // thanh toán, và không còn cơ chế tự động nào sửa được nữa — chỉ còn người.
      console.error(
        `[webhook] Bỏ cuộc sau ${row.attempts} lần: ${row.event} cho đơn ${row.order_id} → ${row.target_url}. ` +
          `Lỗi cuối: ${result.error}. Gửi lại thủ công: POST /api/v1/orders/<ref>/replay`,
      );
    }
  }

  return { claimed: claimed.length, delivered, retrying, failed };
}

type DeliverResult = { ok: true; status: number } | { ok: false; status: number | null; error: string };

async function deliverOne(secret: string, row: DeliveryRow): Promise<DeliverResult> {
  // Ký đúng chuỗi byte SẼ được gửi. Serialize một lần rồi dùng lại cho cả chữ ký và
  // body — ký một object rồi JSON.stringify lại lúc gửi là cách chắc chắn nhất để chữ
  // ký lệch mà không ai hiểu vì sao.
  const body = JSON.stringify(row.payload);
  const timestamp = Math.floor(Date.now() / 1_000);

  try {
    const response = await fetch(row.target_url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SIGNATURE_HEADER]: signPayload(secret, timestamp, body),
        [EVENT_HEADER]: row.event,
        [DELIVERY_HEADER]: String(row.id),
        [ATTEMPT_HEADER]: String(row.attempts),
        "user-agent": "cardano-pay-webhook/1",
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      // Webhook đi tới một server khác; không có gì để cache và cũng không nên có.
      cache: "no-store",
    });

    if (response.ok) return { ok: true, status: response.status };

    // Đọc một ít thân response: khi shop trả 500, dòng đầu của lỗi thường nói đủ.
    const text = await response.text().catch(() => "");
    return {
      ok: false,
      status: response.status,
      error: `HTTP ${response.status} ${response.statusText}${text ? ` — ${text.slice(0, 200)}` : ""}`,
    };
  } catch (error) {
    return { ok: false, status: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/* ------------------------------------------------------------------ */
/* Đọc trạng thái & gửi lại                                            */
/* ------------------------------------------------------------------ */

export type DeliveryView = {
  id: string;
  event: string;
  status: string;
  attempts: number;
  targetUrl: string;
  responseStatus: number | null;
  lastError: string | null;
  createdAt: string;
  deliveredAt: string | null;
  nextAttemptAt: string | null;
};

export async function listDeliveries(orderId: string): Promise<DeliveryView[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT id, event, status, attempts, target_url, response_status, last_error,
            created_at, delivered_at, next_attempt_at
       FROM payment_webhook_deliveries
      WHERE order_id = $1
      ORDER BY created_at`,
    [orderId],
  );

  return rows.map((row) => ({
    id: String(row.id),
    event: row.event as string,
    status: row.status as string,
    attempts: row.attempts as number,
    targetUrl: row.target_url as string,
    responseStatus: (row.response_status as number | null) ?? null,
    lastError: (row.last_error as string | null) ?? null,
    createdAt: (row.created_at as Date).toISOString(),
    deliveredAt: (row.delivered_at as Date | null)?.toISOString() ?? null,
    nextAttemptAt: (row.next_attempt_at as Date | null)?.toISOString() ?? null,
  }));
}

/**
 * Đưa mọi sự kiện chưa gửi được của một đơn về lại hàng đợi.
 *
 * Dành cho lúc shop sập nhiều giờ, hoặc URL webhook khai sai và hàng đợi đã bỏ cuộc.
 * Đặt lại `attempts = 0` nhưng KHÔNG dựng lại payload: payload là ảnh chụp tại thời
 * điểm sự kiện xảy ra, và nó phải giữ nguyên như vậy.
 */
export async function replayWebhooks(orderId: string): Promise<number> {
  const config = resolveWebhookConfig();
  if (!config.ok) return 0;

  const rows = await query<{ id: string }>(
    `UPDATE payment_webhook_deliveries
        SET status = 'pending', attempts = 0, next_attempt_at = now(),
            last_error = NULL, target_url = $2
      WHERE order_id = $1 AND status <> 'delivered'
      RETURNING id`,
    [orderId, config.url],
  );

  return rows.length;
}
