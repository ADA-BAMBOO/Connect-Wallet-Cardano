import "server-only";

import type { PoolClient } from "pg";

import { query, queryOne, withTransaction } from "@/lib/db";
import { formatAmount, toBigInt, usdToLovelace, usdToStablecoin, USD_DECIMALS } from "@/lib/money";
import type { CardanoNetwork } from "@/lib/network";
import { getPaymentParams, requireMerchantAddress } from "@/lib/payment-config";
import { getAdaUsdRate, getPegStatuses } from "@/lib/price";
import { generateRef } from "@/lib/ref";
import { buildReturnUrl } from "@/lib/return-url";
import { findPayToken, isAda, type PayToken } from "@/lib/stablecoins";
import { enqueueWebhook, eventForStatus } from "@/lib/webhook";

/**
 * Vòng đời đơn hàng.
 *
 *   pending ──chọn token──► pending (đã khoá giá)
 *      │                        │
 *      │                        ├──người trả gửi tx──► seen ──đủ xác nhận──► confirmed
 *      │                        └──nhận thiếu────────► underpaid
 *      └──quá hạn──► expired
 *
 * Giai đoạn 4 dựng tới bước khoá giá. `seen`/`confirmed`/`underpaid` do bộ xác minh
 * on-chain ở giai đoạn 5 ghi.
 */

/** Cardano bắt mỗi output phải chứa tối thiểu ~1 ADA (min-ADA). */
const MIN_LOVELACE = 1_000_000n;

/** Chặn trên cho một đơn: 1 triệu USD. Đủ rộng cho mọi nhu cầu thật, đủ chặt để chặn rác. */
const MAX_ORDER_USD_MICRO = 1_000_000n * 10n ** BigInt(USD_DECIMALS);

export type OrderStatus = "pending" | "seen" | "confirmed" | "underpaid" | "expired" | "failed";

export type Order = {
  id: string;
  ref: string;
  network: CardanoNetwork;
  paymentMode: "direct" | "escrow";
  status: OrderStatus;
  amountUsd: bigint;
  description: string | null;
  merchantAddress: string;
  buyerAddress: string | null;
  /** Mã đơn phía dự án bán hàng. null khi đơn được tạo thẳng từ trang demo. */
  externalOrderId: string | null;
  /** URL đưa khách quay lại shop — ĐÃ qua allowlist lúc tạo đơn. */
  returnUrl: string | null;
  webhooksDelivered: number;
  payUnit: string | null;
  paySymbol: string | null;
  payDecimals: number | null;
  payQuantity: bigint | null;
  adaRate: bigint | null;
  rateSources: string[] | null;
  quoteExpiresAt: Date | null;
  txHash: string | null;
  txBlockHeight: bigint | null;
  txMetadataOk: boolean | null;
  receivedQuantity: bigint | null;
  confirmations: number;
  inlineDatum: string | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  confirmedAt: Date | null;
};

export type OrderRow = Record<string, unknown>;

/** pg trả int8 dạng CHUỖI (cố ý — int8 vượt Number.MAX_SAFE_INTEGER). Không Number() ở đây. */
const bigintOrNull = (value: unknown): bigint | null =>
  value === null || value === undefined ? null : toBigInt(value);

export function mapOrderRow(row: OrderRow): Order {
  return mapRow(row);
}

function mapRow(row: OrderRow): Order {
  return {
    id: row.id as string,
    ref: row.ref as string,
    network: row.network as CardanoNetwork,
    paymentMode: row.payment_mode as "direct" | "escrow",
    status: row.status as OrderStatus,
    amountUsd: toBigInt(row.amount_usd),
    description: (row.description as string | null) ?? null,
    merchantAddress: row.merchant_address as string,
    buyerAddress: (row.buyer_address as string | null) ?? null,
    externalOrderId: (row.external_order_id as string | null) ?? null,
    returnUrl: (row.return_url as string | null) ?? null,
    webhooksDelivered: (row.webhooks_delivered as number) ?? 0,
    payUnit: (row.pay_unit as string | null) ?? null,
    paySymbol: (row.pay_symbol as string | null) ?? null,
    payDecimals: (row.pay_decimals as number | null) ?? null,
    payQuantity: bigintOrNull(row.pay_quantity),
    adaRate: bigintOrNull(row.ada_rate),
    rateSources: (row.rate_sources as string[] | null) ?? null,
    quoteExpiresAt: (row.quote_expires_at as Date | null) ?? null,
    txHash: (row.tx_hash as string | null) ?? null,
    txBlockHeight: bigintOrNull(row.tx_block_height),
    txMetadataOk: (row.tx_metadata_ok as boolean | null) ?? null,
    receivedQuantity: bigintOrNull(row.received_quantity),
    confirmations: (row.confirmations as number) ?? 0,
    inlineDatum: (row.inline_datum as string | null) ?? null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
    expiresAt: row.expires_at as Date,
    confirmedAt: (row.confirmed_at as Date | null) ?? null,
  };
}

/**
 * Ghi một dòng vào nhật ký chuyển trạng thái.
 *
 * Lịch sử không tái tạo được: khi cần trả lời "vì sao đơn này bị đánh dấu đã trả",
 * bảng orders chỉ còn trạng thái CUỐI.
 */
async function recordEvent(
  client: PoolClient,
  orderId: string,
  fromStatus: string | null,
  toStatus: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await client.query(
    `INSERT INTO payment_order_events (order_id, from_status, to_status, detail)
     VALUES ($1, $2, $3, $4)`,
    [orderId, fromStatus, toStatus, JSON.stringify(detail)],
  );
}

/* ------------------------------------------------------------------ */
/* Tạo đơn                                                             */
/* ------------------------------------------------------------------ */

export type CreateOrderInput = {
  network: CardanoNetwork;
  /** micro-USD. */
  amountUsd: bigint;
  description?: string | null;
  /** Mã đơn phía shop. Có mặt thì lời gọi trở thành idempotent — xem bên dưới. */
  externalOrderId?: string | null;
  /** URL quay lại shop. PHẢI đã qua `validateReturnUrl` trước khi tới đây. */
  returnUrl?: string | null;
};

export type CreateOrderResult =
  /** `reused: true` = đã có đơn với đúng `externalOrderId` này, không tạo thêm. */
  | { ok: true; order: Order; reused: boolean }
  | { ok: false; error: string; code?: number };

/** Mô tả đơn hiện trên trang thanh toán — cắt ngắn và bỏ ký tự điều khiển. */
function sanitizeDescription(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;

  // Lọc theo MÃ ký tự thay vì bằng regex có escape hex. Một character class viết
  // bằng escape hex rất dễ bị công cụ chỉnh sửa biến thành byte điều khiển THẬT nằm
  // trong mã nguồn — lúc đó file thành nhị phân với grep/diff, mà nhìn bằng mắt
  // không thấy gì khác lạ. Cách này không có escape nào để hỏng.
  const cleaned = Array.from(value, (ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f ? " " : ch;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned ? cleaned.slice(0, 200) : null;
}

/**
 * Mã đơn phía shop. Mỗi hệ đánh mã một kiểu (uuid, số tăng dần, "DH-2026-0042"), nên
 * không áp định dạng — chỉ chặn ký tự điều khiển và độ dài, đúng như ràng buộc CHECK.
 */
function sanitizeExternalId(value: unknown): string | null | { error: string } {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return { error: '"externalOrderId" phải là chuỗi.' };

  const cleaned = Array.from(value, (ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f ? "" : ch;
  })
    .join("")
    .trim();

  if (!cleaned) return { error: '"externalOrderId" rỗng sau khi lọc.' };
  if (cleaned.length > 128) return { error: '"externalOrderId" dài quá 128 ký tự.' };
  return cleaned;
}

export async function createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
  if (input.amountUsd <= 0n) return { ok: false, error: "Số tiền phải lớn hơn 0." };
  if (input.amountUsd > MAX_ORDER_USD_MICRO) {
    return { ok: false, error: `Số tiền vượt mức tối đa ${formatAmount(MAX_ORDER_USD_MICRO, USD_DECIMALS)} USD.` };
  }

  const externalId = sanitizeExternalId(input.externalOrderId);
  if (externalId !== null && typeof externalId === "object") {
    return { ok: false, error: externalId.error };
  }

  let merchantAddress: string;
  try {
    // Địa chỉ nhận CHỈ đến từ biến môi trường, không bao giờ từ request — và được
    // sao vào đơn ngay tại đây, nên đổi env sau này không làm sai đơn cũ.
    merchantAddress = requireMerchantAddress(input.network);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  const { orderTtlSeconds } = getPaymentParams();
  const description = sanitizeDescription(input.description);

  // `ref` là ngẫu nhiên nên đụng độ gần như không xảy ra (59^8 tổ hợp), nhưng
  // UNIQUE ở tầng DB mới là thứ quyết định — thử lại vài lần cho chắc.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await withTransaction(async (client) => {
        const { rows } = await client.query<OrderRow>(
          `INSERT INTO payment_orders
             (ref, network, amount_usd, description, merchant_address, expires_at,
              external_order_id, return_url)
           VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6), $7, $8)
           RETURNING *`,
          [
            generateRef(),
            input.network,
            input.amountUsd.toString(),
            description,
            merchantAddress,
            orderTtlSeconds,
            externalId,
            input.returnUrl || null,
          ],
        );

        const order = mapRow(rows[0]!);
        await recordEvent(client, order.id, null, "pending", {
          amountUsd: order.amountUsd.toString(),
          network: order.network,
          ...(externalId ? { externalOrderId: externalId } : {}),
        });

        return { ok: true as const, order, reused: false };
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      const constraint = (error as { constraint?: string }).constraint;

      // Trùng `externalOrderId` KHÔNG phải lỗi — đó là idempotency đang làm việc.
      //
      // Shop gọi lại cùng một mã đơn vì rất nhiều lý do bình thường: khách bấm "Thanh
      // toán" hai lần, request trước timeout ở tầng mạng nhưng đã ghi xong ở đây, job
      // nội bộ chạy lại. Tạo đơn thứ hai trong những tình huống đó nghĩa là khách thấy
      // hai hoá đơn cho một món hàng, và một trong hai sẽ được trả rồi bị bỏ quên.
      if (code === "23505" && constraint === "payment_orders_external_idx" && externalId) {
        const existing = await getOrderByExternalId(input.network, externalId);
        if (!existing) continue; // vừa bị xoá giữa chừng — thử lại

        // Cùng mã đơn nhưng khác số tiền là một lỗi thật ở phía shop, không phải retry.
        // Trả lại đơn cũ ở đây sẽ khiến shop tưởng đã tạo đơn với số tiền mới.
        if (existing.amountUsd !== input.amountUsd) {
          return {
            ok: false,
            error:
              `Đơn "${externalId}" đã tồn tại với số tiền ` +
              `${formatAmount(existing.amountUsd, USD_DECIMALS)} USD, không khớp số tiền vừa gửi ` +
              `(${formatAmount(input.amountUsd, USD_DECIMALS)} USD).`,
            code: 409,
          };
        }

        return { ok: true, order: existing, reused: true };
      }

      if (code === "23505" && attempt < 4) continue; // trùng ref — sinh mã khác
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  return { ok: false, error: "Không sinh được mã đơn duy nhất." };
}

/* ------------------------------------------------------------------ */
/* Đọc đơn                                                             */
/* ------------------------------------------------------------------ */

/**
 * Đánh dấu hết hạn cho các đơn `pending` đã quá hạn.
 *
 * Chỉ đụng vào `pending`: đơn đã sang `seen` nghĩa là tiền đang trên đường, hết hạn
 * lúc đó mà đổi trạng thái là xoá mất một khoản thanh toán có thật.
 */
export async function expireStaleOrders(): Promise<number> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<OrderRow>(
      `UPDATE payment_orders
          SET status = 'expired'
        WHERE status = 'pending' AND expires_at <= now()
        RETURNING *`,
    );

    for (const row of rows) {
      const order = mapRow(row);
      await recordEvent(client, order.id, "pending", "expired", { reason: "quá hạn" });
      // Shop cần biết để nhả hàng đã giữ trong kho. Hết hạn là kết cục phổ biến nhất
      // của một đơn crypto — người ta mở trang rồi đổi ý — nên im lặng ở đây đồng
      // nghĩa với hàng bị giữ vĩnh viễn cho những đơn không bao giờ được trả.
      await queueOrderWebhook(client, order);
    }

    return rows.length;
  });
}

export async function getOrderByExternalId(
  network: CardanoNetwork,
  externalOrderId: string,
): Promise<Order | null> {
  const row = await queryOne<OrderRow>(
    "SELECT * FROM payment_orders WHERE network = $1 AND external_order_id = $2",
    [network, externalOrderId],
  );
  return row ? mapRow(row) : null;
}

/**
 * Xếp webhook cho trạng thái HIỆN TẠI của đơn.
 *
 * Payload được chụp ngay tại đây, trong cùng transaction đổi trạng thái, chứ không
 * dựng lại lúc gửi: lúc gửi (có thể là nhiều giờ sau, sau nhiều lần thử) số xác nhận
 * đã khác, đơn có thể đã chuyển tiếp trạng thái, và shop sẽ nhận một sự kiện
 * "order.seen" mang dữ liệu của một đơn đã confirmed.
 */
export async function queueOrderWebhook(client: PoolClient, order: Order): Promise<void> {
  const event = eventForStatus(order.status);
  if (!event) return;

  await enqueueWebhook(client, {
    orderId: order.id,
    event,
    payload: {
      event,
      occurredAt: new Date().toISOString(),
      data: serializeOrder(order),
    },
  });
}

export async function getOrderByRef(ref: string): Promise<Order | null> {
  const row = await queryOne<OrderRow>("SELECT * FROM payment_orders WHERE ref = $1", [ref]);
  if (!row) return null;

  const order = mapRow(row);

  // Hết hạn tính lười: đơn chỉ thật sự chuyển trạng thái khi có người nhìn đến nó,
  // nên không cần một tiến trình quét chạy nền chỉ để làm việc này.
  if (order.status === "pending" && order.expiresAt.getTime() <= Date.now()) {
    return withTransaction(async (client) => {
      const { rows } = await client.query<OrderRow>(
        `UPDATE payment_orders SET status = 'expired'
          WHERE id = $1 AND status = 'pending'
          RETURNING *`,
        [order.id],
      );
      if (rows.length === 0) return order; // instance khác vừa đổi trước

      await recordEvent(client, order.id, "pending", "expired", { reason: "quá hạn" });
      const expired = mapRow(rows[0]!);
      await queueOrderWebhook(client, expired);
      return expired;
    });
  }

  return order;
}

export async function listOrders(options: { network?: CardanoNetwork; limit?: number } = {}): Promise<Order[]> {
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);

  const rows = options.network
    ? await query<OrderRow>(
        "SELECT * FROM payment_orders WHERE network = $1 ORDER BY created_at DESC LIMIT $2",
        [options.network, limit],
      )
    : await query<OrderRow>("SELECT * FROM payment_orders ORDER BY created_at DESC LIMIT $1", [limit]);

  return rows.map(mapRow);
}

export type OrderStats = {
  /** Số đơn theo từng trạng thái. Trạng thái không có đơn nào thì không xuất hiện. */
  byStatus: Record<string, number>;
  /** Tổng đã thu, micro-USD — CHỈ tính đơn `confirmed`. */
  confirmedUsd: bigint;
  /** Đơn đang chờ, để biết còn bao nhiêu tiền chưa về. */
  pendingUsd: bigint;
  total: number;
};

/**
 * Số liệu tổng hợp cho dashboard.
 *
 * Tính bằng SQL chứ không tải hết đơn về rồi cộng trong JS: sổ đơn hàng chỉ có tăng,
 * và một ngày nào đó nó sẽ không vừa bộ nhớ.
 */
export async function getOrderStats(network?: CardanoNetwork): Promise<OrderStats> {
  const rows = network
    ? await query<{ status: string; n: string; total: string }>(
        `SELECT status, count(*)::text AS n, coalesce(sum(amount_usd), 0)::text AS total
           FROM payment_orders WHERE network = $1 GROUP BY status`,
        [network],
      )
    : await query<{ status: string; n: string; total: string }>(
        `SELECT status, count(*)::text AS n, coalesce(sum(amount_usd), 0)::text AS total
           FROM payment_orders GROUP BY status`,
      );

  const byStatus: Record<string, number> = {};
  let confirmedUsd = 0n;
  let pendingUsd = 0n;
  let total = 0;

  for (const row of rows) {
    const count = Number(row.n);
    byStatus[row.status] = count;
    total += count;

    if (row.status === "confirmed") confirmedUsd += toBigInt(row.total);
    // `seen` là tiền đang trên đường — gộp chung với `pending` để biết còn bao nhiêu
    // chưa chốt. `underpaid` KHÔNG tính vào đâu cả: nó cần người quyết định.
    else if (row.status === "pending" || row.status === "seen") pendingUsd += toBigInt(row.total);
  }

  return { byStatus, confirmedUsd, pendingUsd, total };
}

/* ------------------------------------------------------------------ */
/* Khoá giá                                                            */
/* ------------------------------------------------------------------ */

export type QuoteResult = { ok: true; order: Order } | { ok: false; error: string; code: number };

type Priced = {
  quantity: bigint;
  adaRate: bigint | null;
  rateSources: string[] | null;
  quoteTtlSeconds: number | null;
};

/** Tính số phải trả cho một token. Đây là chỗ duy nhất quyết định con số đó. */
async function priceOrder(order: Order, token: PayToken): Promise<Priced | { error: string; code: number }> {
  const { quoteTtlSeconds } = getPaymentParams();

  if (!isAda(token)) {
    // Stablecoin: quy ước 1 token = 1 USD, không có tỷ giá nào để khoá, nên đơn
    // không có hạn báo giá — chỉ có hạn của cả đơn.
    return {
      quantity: usdToStablecoin(order.amountUsd, token.decimals),
      adaRate: null,
      rateSources: null,
      quoteTtlSeconds: null,
    };
  }

  const rate = await getAdaUsdRate();
  if (!rate.ok) {
    // Fail-closed: không có giá tin được thì không tạo báo giá. 503 chứ không 400 —
    // lỗi ở phía chúng ta, và thử lại sau vài giây là được.
    return { error: `Chưa lấy được tỷ giá ADA/USD: ${rate.error}`, code: 503 };
  }

  const quantity = usdToLovelace(order.amountUsd, rate.value.rate);

  // Đơn quá nhỏ thì giao dịch sẽ bị chain từ chối vì dưới min-ADA. Bắt ở đây, lúc
  // còn nói được câu rõ ràng, thay vì để ví báo một lỗi khó hiểu lúc ký.
  if (quantity < MIN_LOVELACE) {
    return {
      error:
        `Đơn quá nhỏ để trả bằng ADA: cần ${formatAmount(quantity, 6)} ADA nhưng Cardano ` +
        `yêu cầu tối thiểu ${formatAmount(MIN_LOVELACE, 6)} ADA mỗi giao dịch. Chọn stablecoin hoặc tăng số tiền.`,
      code: 400,
    };
  }

  return { quantity, adaRate: rate.value.rate, rateSources: rate.value.sources, quoteTtlSeconds };
}

/**
 * Chọn token và khoá số tiền phải trả.
 *
 * Gọi lại được khi người trả đổi ý hoặc báo giá hết hạn — nhưng CHỈ khi đơn còn
 * `pending` và chưa có giao dịch nào gắn vào. Cho đổi số tiền sau khi người ta đã ký
 * là tự tay làm hỏng việc đối chiếu on-chain.
 */
export async function setQuote(ref: string, unit: string, buyerAddress?: string): Promise<QuoteResult> {
  const order = await getOrderByRef(ref);
  if (!order) return { ok: false, error: "Không tìm thấy đơn hàng.", code: 404 };

  if (order.status !== "pending") {
    return {
      ok: false,
      error:
        order.status === "expired"
          ? "Đơn hàng đã hết hạn."
          : `Đơn hàng đang ở trạng thái "${order.status}", không đổi được token thanh toán.`,
      code: 409,
    };
  }

  const token = findPayToken(order.network, unit);
  if (!token) {
    return { ok: false, error: `Token "${unit}" không nằm trong danh mục của mạng ${order.network}.`, code: 400 };
  }

  // Token lệch peg thì không nhận: 1 token không còn bằng 1 USD nữa, mà toàn bộ
  // phép quy đổi của stablecoin dựa trên đúng giả định đó.
  if (token.pegged) {
    const peg = (await getPegStatuses(order.network)).find((entry) => entry.unit === token.unit);
    if (peg && !peg.acceptable) {
      const deviation = peg.status.state === "depegged" ? (peg.status.deviationBps / 100).toFixed(2) : "?";
      return {
        ok: false,
        error: `${token.symbol} đang lệch peg ${deviation}% nên tạm không nhận. Hãy chọn token khác.`,
        code: 409,
      };
    }
  }

  const priced = await priceOrder(order, token);
  if ("error" in priced) return { ok: false, error: priced.error, code: priced.code };

  return withTransaction(async (client) => {
    // Điều kiện nằm trong WHERE chứ không kiểm ở tầng ứng dụng: giữa lúc đọc đơn và
    // lúc ghi, một request khác có thể đã gắn txHash vào. Để DB phân xử.
    const { rows } = await client.query<OrderRow>(
      `UPDATE payment_orders
          SET pay_unit = $2, pay_symbol = $3, pay_decimals = $4, pay_quantity = $5,
              ada_rate = $6, rate_sources = $7,
              quote_expires_at = CASE WHEN $8::int IS NULL THEN NULL
                                      ELSE now() + make_interval(secs => $8::int) END,
              buyer_address = COALESCE($9, buyer_address)
        WHERE id = $1 AND status = 'pending' AND tx_hash IS NULL AND expires_at > now()
        RETURNING *`,
      [
        order.id,
        token.unit,
        token.symbol,
        token.decimals,
        priced.quantity.toString(),
        priced.adaRate?.toString() ?? null,
        priced.rateSources,
        priced.quoteTtlSeconds,
        buyerAddress ?? null,
      ],
    );

    if (rows.length === 0) {
      return { ok: false as const, error: "Đơn hàng vừa đổi trạng thái, hãy tải lại.", code: 409 };
    }

    const updated = mapRow(rows[0]!);
    await recordEvent(client, order.id, "pending", "pending", {
      action: "quote",
      unit: token.unit,
      symbol: token.symbol,
      quantity: priced.quantity.toString(),
      adaRate: priced.adaRate?.toString() ?? null,
      rateSources: priced.rateSources,
    });

    return { ok: true as const, order: updated };
  });
}

/* ------------------------------------------------------------------ */
/* Trình bày cho API                                                   */
/* ------------------------------------------------------------------ */

export type SerializedOrder = ReturnType<typeof serializeOrder>;

/**
 * URL quay về shop, đã gắn kết quả.
 *
 * Nuốt lỗi rồi trả `null`: URL này đã qua `validateReturnUrl` lúc tạo đơn nên gần như
 * không thể hỏng ở đây — nhưng nếu có (dữ liệu cũ, sửa tay trong database), mất một
 * cái nút là chuyện nhỏ, còn để cả trang thanh toán ném lỗi thì người trả tiền không
 * thấy đơn của mình đâu nữa.
 */
function decoratedReturnUrl(order: Order): string | null {
  if (!order.returnUrl) return null;
  try {
    return buildReturnUrl(order.returnUrl, {
      ref: order.ref,
      status: order.status,
      externalOrderId: order.externalOrderId,
    });
  } catch {
    return null;
  }
}

/** bigint và Date không JSON hoá được — chuyển sang chuỗi, kèm bản đọc được cho người. */
export function serializeOrder(order: Order) {
  const quoteExpired =
    order.quoteExpiresAt !== null && order.quoteExpiresAt.getTime() <= Date.now();

  return {
    ref: order.ref,
    network: order.network,
    status: order.status,
    paymentMode: order.paymentMode,

    amountUsd: formatAmount(order.amountUsd, USD_DECIMALS, { group: false }),
    amountUsdMicro: order.amountUsd.toString(),
    description: order.description,

    // Mã đơn phía shop — đây là thứ shop dùng để tìm lại đơn của mình khi nhận webhook.
    externalOrderId: order.externalOrderId,
    // Trang thanh toán dựng nút "Quay lại cửa hàng" từ đây. Giá trị này ĐÃ qua
    // allowlist origin lúc tạo đơn (xem lib/return-url.ts), nên hiển thị thẳng được.
    // Tham số ref/status/orderId được gắn ở tầng server để phía client không phải tự
    // ghép URL — và để shop luôn nhận đúng bộ tham số như tài liệu mô tả.
    returnUrl: decoratedReturnUrl(order),

    merchantAddress: order.merchantAddress,
    buyerAddress: order.buyerAddress,

    payment:
      order.payUnit === null || order.payQuantity === null || order.payDecimals === null
        ? null
        : {
            unit: order.payUnit,
            symbol: order.paySymbol,
            decimals: order.payDecimals,
            quantity: order.payQuantity.toString(),
            quantityFormatted: formatAmount(order.payQuantity, order.payDecimals, { group: false }),
            adaRate: order.adaRate?.toString() ?? null,
            adaRateUsd: order.adaRate ? formatAmount(order.adaRate, 6, { group: false }) : null,
            rateSources: order.rateSources,
            quoteExpiresAt: order.quoteExpiresAt?.toISOString() ?? null,
            // Báo giá hết hạn thì phải chọn token lại; số cũ không còn dùng được.
            quoteExpired,
          },

    tx:
      order.txHash === null
        ? null
        : {
            hash: order.txHash,
            blockHeight: order.txBlockHeight?.toString() ?? null,
            confirmations: order.confirmations,
            receivedQuantity: order.receivedQuantity?.toString() ?? null,
            metadataOk: order.txMetadataOk,
          },

    createdAt: order.createdAt.toISOString(),
    expiresAt: order.expiresAt.toISOString(),
    confirmedAt: order.confirmedAt?.toISOString() ?? null,
  };
}
