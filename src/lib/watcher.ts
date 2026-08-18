import "server-only";

import {
  getAddressTransactions,
  getLatestBlockHeight,
  getTx,
  getTxMetadata,
  getTxOutputs,
} from "@/lib/blockfrost";
import { withTransaction } from "@/lib/db";
import { minAcceptable } from "@/lib/money";
import type { CardanoNetwork } from "@/lib/network";
import {
  expireStaleOrders,
  getOrderByRef,
  mapOrderRow,
  type Order,
  queueOrderWebhook,
} from "@/lib/orders";
import { getPaymentParams } from "@/lib/payment-config";
import { extractPaymentRefs, verifyPayment, type VerifyVerdict } from "@/lib/payment-verify";
import { query } from "@/lib/db";
import { cacheGetJson, cacheSetJson, isRedisConfigured, withLock } from "@/lib/redis";

/**
 * Đưa trạng thái đơn hàng khớp với thực tế trên chain.
 *
 * HAI ĐƯỜNG, CÙNG MỘT HÀM XÁC MINH:
 *
 *   nhanh  — người trả báo txHash về, ta kiểm ngay hash đó (3 lời gọi Blockfrost)
 *   chắc   — quét giao dịch tới địa chỉ merchant và đọc metadata để tự tìm ra
 *
 * Đường "chắc" tồn tại vì rất nhiều khoản trả không bao giờ báo lại được: người ta
 * đóng tab ngay sau khi ký, hoặc quét QR trả từ máy khác. Bỏ hẳn đường "nhanh" đi
 * thì hệ thống vẫn đúng, chỉ chậm hơn vài giây.
 */

/**
 * Ngân sách quét cho MỖI địa chỉ merchant trong một lượt sweep.
 *
 * Thứ tốn kém không phải danh sách giao dịch (1 lời gọi cho 100 dòng) mà là metadata
 * của từng giao dịch CHƯA từng soi (1 lời gọi mỗi cái). Cache `scanned` khiến chi phí
 * thật chỉ tỉ lệ với lượng giao dịch mới, nên phân trang tới khi bắt kịp lịch sử là
 * rẻ — miễn là vẫn có trần để một lượt quét không kéo dài vô hạn.
 *
 * Chạm trần thì đặt cờ `truncated` chứ KHÔNG im lặng bỏ qua: một khoảng mù không ai
 * biết còn tệ hơn một khoảng mù có báo.
 */
const SCAN_PAGE_SIZE = 100;
const SCAN_METADATA_BUDGET = 60;
const SCAN_MAX_PAGES = 10;

/**
 * Không có Redis thì không có cache `scanned`, nên mọi giao dịch đều "mới" ở mọi lượt
 * quét và phân trang sẽ đốt đúng ngân sách mỗi lần. Giữ nguyên hành vi một trang nhỏ.
 */
const SCAN_LIMIT_NO_CACHE = 25;

/** Số đơn `pending`/`seen` kiểm tối đa mỗi mạng mỗi lượt. */
const PENDING_LIMIT = 200;

/** Khoá mỗi đơn khi xử lý, tránh hai instance cùng ghi. */
const LOCK_TTL_MS = 30_000;

/**
 * Verdict đã gắn được giao dịch vào đơn — không cần đi tìm hash nào khác nữa.
 * `rejected`/`not_found` thì ngược lại: gợi ý sai, để đường quét địa chỉ lo tiếp.
 */
const SETTLED = new Set<VerifyVerdict["state"]>(["confirmed", "seen", "underpaid", "stale_quote"]);

/** Gợi ý txHash do client gửi lên. Chỉ là gợi ý — mất cũng không sao, watcher tự tìm ra. */
const candidateKey = (ref: string) => `pay:candidate:${ref}`;
const scannedKey = (network: CardanoNetwork, txHash: string) => `pay:scanned:${network}:${txHash}`;

const CANDIDATE_TTL_SECONDS = 3 * 3_600;
const SCANNED_TTL_SECONDS = 7 * 86_400;

export async function rememberCandidateTx(ref: string, txHash: string): Promise<void> {
  if (isRedisConfigured()) await cacheSetJson(candidateKey(ref), txHash, CANDIDATE_TTL_SECONDS);
}

async function recallCandidateTx(ref: string): Promise<string | null> {
  return isRedisConfigured() ? await cacheGetJson<string>(candidateKey(ref)) : null;
}

/* ------------------------------------------------------------------ */
/* Xác minh một đơn với một txHash cụ thể                              */
/* ------------------------------------------------------------------ */

export type CheckResult = { verdict: VerifyVerdict; order: Order | null };

/**
 * Tải dữ liệu chain rồi đối chiếu. KHÔNG tin bất cứ điều gì client nói ngoài txHash —
 * và bản thân txHash cũng chỉ dùng để biết đi hỏi chain ở đâu.
 */
export async function checkOrderAgainstTx(order: Order, txHash: string): Promise<CheckResult> {
  if (order.payUnit === null || order.payQuantity === null) {
    return {
      verdict: { state: "rejected", reason: "Đơn chưa chọn token thanh toán." },
      order,
    };
  }

  const { toleranceBps, requiredConfirmations } = getPaymentParams();

  const [tx, outputs, metadata, latestBlockHeight] = await Promise.all([
    getTx(order.network, txHash),
    getTxOutputs(order.network, txHash),
    getTxMetadata(order.network, txHash),
    getLatestBlockHeight(order.network),
  ]);

  const verdict = verifyPayment({
    ref: order.ref,
    merchantAddress: order.merchantAddress,
    payUnit: order.payUnit,
    requiredQuantity: order.payQuantity,
    minQuantity: minAcceptable(order.payQuantity, toleranceBps),
    requiredConfirmations,
    // null với stablecoin (quy ước 1:1, không có tỷ giá nào để hết hạn).
    quoteExpiresAtMs: order.quoteExpiresAt?.getTime() ?? null,
    nowMs: Date.now(),
    tx,
    outputs,
    metadata,
    latestBlockHeight,
  });

  const updated = await applyVerdict(order, txHash, verdict);
  return { verdict, order: updated };
}

/**
 * Ghi kết luận vào database.
 *
 * Giao dịch bị `rejected` KHÔNG bao giờ được gắn vào đơn: gắn vào là vừa chiếm mất
 * ràng buộc UNIQUE(tx_hash), vừa chặn luôn khoản thanh toán thật đến sau. Chỉ ghi
 * một dòng nhật ký để còn lần ra được về sau.
 */
async function applyVerdict(order: Order, txHash: string, verdict: VerifyVerdict): Promise<Order | null> {
  if (verdict.state === "not_found") return order;

  if (verdict.state === "rejected") {
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO payment_order_events (order_id, from_status, to_status, detail)
         VALUES ($1, $2, $2, $3)`,
        [order.id, order.status, JSON.stringify({ action: "rejected", txHash, reason: verdict.reason })],
      );
    });
    return order;
  }

  // `stale_quote` ghi vào cùng ô với `underpaid`: cả hai đều là "tiền đã về nhưng chưa
  // chốt được, cần người quyết định". Dùng lại trạng thái sẵn có thay vì thêm một giá
  // trị mới vào ràng buộc CHECK — dashboard, thống kê và cảnh báo đã xử lý đúng ô này
  // rồi, còn lý do cụ thể thì nằm trong nhật ký sự kiện.
  const nextStatus =
    verdict.state === "confirmed"
      ? "confirmed"
      : verdict.state === "underpaid" || verdict.state === "stale_quote"
        ? "underpaid"
        : "seen";

  try {
    return await withTransaction(async (client) => {
      // Điều kiện nằm trong WHERE để không bao giờ hạ cấp một đơn đã `confirmed`
      // xuống `seen`, và để hai instance chạy song song không ghi đè lẫn nhau.
      const { rows } = await client.query(
        `UPDATE payment_orders
            SET status            = $3,
                tx_hash           = $2,
                tx_block_height   = $4,
                tx_metadata_ok    = true,
                received_quantity = $5,
                confirmations     = $6,
                confirmed_at      = CASE WHEN $3 = 'confirmed' THEN now() ELSE confirmed_at END
          WHERE id = $1
            AND status IN ('pending', 'seen')
            AND (tx_hash IS NULL OR tx_hash = $2)
          RETURNING *`,
        [
          order.id,
          txHash,
          nextStatus,
          verdict.blockHeight,
          verdict.received.toString(),
          verdict.confirmations,
        ],
      );

      if (rows.length === 0) {
        // Câu UPDATE không khớp dòng nào: đơn đã rời khỏi `pending`/`seen` — gần như
        // luôn là `expired`, khi người trả ký sát giờ và giao dịch vào block sau đó.
        //
        // Tiền ĐÃ nằm trong ví merchant. Lặng lẽ `return` ở đây từng là một lỗ hổng đối
        // soát: bảng orders ghi `expired`, nhật ký trống trơn, và sau này không ai trả
        // lời được vì sao ví có tiền mà đơn thì hết hạn. Ghi lại là việc bắt buộc, kể cả
        // khi không đổi được trạng thái.
        await client.query(
          `INSERT INTO payment_order_events (order_id, from_status, to_status, detail)
           VALUES ($1, $2, $2, $3)`,
          [
            order.id,
            order.status,
            JSON.stringify({
              action: "late-payment",
              reason: `Tiền về khi đơn đang ở trạng thái "${order.status}" — không tự chốt được, cần đối soát.`,
              verdict: verdict.state,
              txHash,
              received: verdict.received.toString(),
              confirmations: verdict.confirmations,
              blockHeight: verdict.blockHeight,
            }),
          ],
        );

        return order;
      }

      await client.query(
        `INSERT INTO payment_order_events (order_id, from_status, to_status, detail)
         VALUES ($1, $2, $3, $4)`,
        [
          order.id,
          order.status,
          nextStatus,
          JSON.stringify({
            txHash,
            received: verdict.received.toString(),
            confirmations: verdict.confirmations,
            blockHeight: verdict.blockHeight,
            ...(verdict.state === "underpaid" ? { shortfall: verdict.shortfall.toString() } : {}),
            ...(verdict.state === "stale_quote"
              ? {
                  reason: "stale-quote",
                  quoteExpiredAt: new Date(verdict.quoteExpiredAtMs).toISOString(),
                  paidAt: new Date(verdict.paidAtMs).toISOString(),
                  lateBySeconds: Math.round((verdict.paidAtMs - verdict.quoteExpiredAtMs) / 1_000),
                }
              : {}),
          }),
        ],
      );

      // Đọc lại từ chính dòng vừa UPDATE, không gọi `getOrderByRef` nữa: hàm đó đi qua
      // pool, tức một KẾT NỐI KHÁC, nên nó không nhìn thấy transaction này trước lúc
      // commit và sẽ trả về đúng bản cũ vừa được thay thế.
      const updated = mapOrderRow(rows[0]!);

      // Báo về shop, trong CÙNG transaction với việc đổi trạng thái. Đây là điểm mấu
      // chốt của toàn bộ phần tích hợp: hai chuyện "đơn đã confirmed" và "shop sẽ được
      // báo" cùng commit hoặc cùng rollback, không bao giờ chỉ có một.
      await queueOrderWebhook(client, updated);

      return updated;
    });
  } catch (error) {
    // 23505 = một đơn KHÁC đã nhận giao dịch này. Ràng buộc UNIQUE(tx_hash) làm đúng
    // việc của nó: một giao dịch không bao giờ thanh toán được cho hai đơn.
    if ((error as { code?: string }).code === "23505") {
      await withTransaction(async (client) => {
        await client.query(
          `INSERT INTO payment_order_events (order_id, from_status, to_status, detail)
           VALUES ($1, $2, $2, $3)`,
          [
            order.id,
            order.status,
            JSON.stringify({ action: "rejected", txHash, reason: "Giao dịch đã thanh toán cho đơn khác." }),
          ],
        );
      });
      return order;
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* Làm mới có tiết chế, dùng cho trang thanh toán                      */
/* ------------------------------------------------------------------ */

/** Một đơn chỉ được đối chiếu lại tối đa một lần trong ngần này giây. */
const REFRESH_THROTTLE_SECONDS = 6;

/**
 * Tiết chế dự phòng trong RAM tiến trình, dùng khi chưa cấu hình Redis.
 *
 * Không thay được khoá phân tán — sau load balancer, mỗi instance có bộ đếm riêng.
 * Nhưng nó chặn đúng kịch bản đáng lo nhất: một trang thanh toán poll liên tục vào một
 * tiến trình, mỗi lần 4 lời gọi Blockfrost. Không có lớp này thì "Redis chưa cấu hình"
 * đồng nghĩa với "GET /api/payments/orders/[ref] không có phanh nào cả".
 */
const lastRefreshAt = new Map<string, number>();

function memoryThrottle(key: string, windowMs: number): boolean {
  const now = Date.now();

  if (lastRefreshAt.size >= 10_000) {
    for (const [entry, at] of lastRefreshAt) {
      if (now - at > windowMs) lastRefreshAt.delete(entry);
    }
  }

  const previous = lastRefreshAt.get(key);
  if (previous !== undefined && now - previous < windowMs) return false;

  lastRefreshAt.set(key, now);
  return true;
}

/**
 * Đối chiếu lại một đơn khi có người đang nhìn nó, nhưng không quá thường xuyên.
 *
 * VÌ SAO CẦN: trang thanh toán poll trạng thái mỗi vài giây. Nếu chỉ có cron watcher
 * làm việc thì lúc dev (chưa cắm cron) đơn sẽ nằm im ở `pending` mãi, và người dùng
 * thật thì phải chờ tới nhịp quét kế tiếp dù giao dịch đã vào block từ lâu.
 *
 * VÌ SAO PHẢI TIẾT CHẾ: mỗi lần đối chiếu tốn 4 lời gọi Blockfrost. Không chặn thì
 * mười người mở cùng một trang là đốt hạn mức trong vài phút. Khoá đặt trong Redis
 * nên giới hạn này áp cho toàn cụm chứ không riêng từng instance.
 *
 * Đây là ghi-trong-lúc-đọc, giống hệt cơ chế hết hạn tính lười ở `getOrderByRef`.
 */
export async function maybeRefreshOrder(order: Order): Promise<Order> {
  if (order.status !== "pending" && order.status !== "seen") return order;

  const txHash = order.txHash ?? (await recallCandidateTx(order.ref));
  if (!txHash) return order;

  if (isRedisConfigured()) {
    const fresh = await withLock(`refresh:${order.id}`, REFRESH_THROTTLE_SECONDS * 1_000, async () => {
      const { order: updated } = await checkOrderAgainstTx(order, txHash);
      return updated ?? order;
    });
    // null nghĩa là vừa có người khác kiểm cách đây chưa tới 6 giây — dùng lại kết
    // quả hiện có thay vì gọi Blockfrost thêm lần nữa.
    return fresh ?? order;
  }

  // Không có Redis: vẫn phải có phanh. Đây là đường chạy của một endpoint công khai mà
  // trang thanh toán poll vài giây một lần, mỗi lần 4 lời gọi Blockfrost.
  if (!memoryThrottle(`refresh:${order.id}`, REFRESH_THROTTLE_SECONDS * 1_000)) return order;

  const { order: updated } = await checkOrderAgainstTx(order, txHash);
  return updated ?? order;
}

/* ------------------------------------------------------------------ */
/* Quét toàn mạng                                                      */
/* ------------------------------------------------------------------ */

export type SweepReport = {
  network: CardanoNetwork;
  expired: number;
  checked: number;
  confirmed: number;
  seen: number;
  underpaid: number;
  scannedTxs: number;
  /**
   * true nghĩa là lượt quét này KHÔNG xem hết: còn đơn chờ chưa kiểm, hoặc còn lịch sử
   * giao dịch chưa đọc tới. Không phải lỗi — nhưng là thứ phải nhìn thấy, vì nó đúng
   * bằng "có khoản trả thật đang không được ghép".
   *
   * Thấy cờ này bật liên tục thì cron đang quét thưa hơn tốc độ đơn đổ về.
   */
  truncated: boolean;
};

async function pendingOrders(
  network: CardanoNetwork,
): Promise<{ orders: Order[]; truncated: boolean }> {
  // Lấy dư một dòng để biết còn sót hay không, thay vì đếm bằng một câu COUNT(*) nữa.
  const rows = await query<Record<string, unknown>>(
    `SELECT ref FROM payment_orders
      WHERE network = $1 AND status IN ('pending', 'seen')
      ORDER BY created_at DESC
      LIMIT $2`,
    [network, PENDING_LIMIT + 1],
  );

  const truncated = rows.length > PENDING_LIMIT;
  const page = truncated ? rows.slice(0, PENDING_LIMIT) : rows;

  const orders = await Promise.all(page.map((row) => getOrderByRef(row.ref as string)));
  return {
    orders: orders.filter((order): order is Order => order !== null && order.status !== "expired"),
    truncated,
  };
}

/**
 * Một lượt quét cho một mạng.
 *
 * Chạy được đồng thời nhiều instance: mỗi đơn được bọc trong một khoá Redis, và
 * ngay cả khi khoá hết hạn giữa chừng thì mệnh đề WHERE cùng ràng buộc UNIQUE ở
 * tầng dữ liệu vẫn giữ cho kết quả đúng.
 */
export async function sweepNetwork(network: CardanoNetwork): Promise<SweepReport> {
  const report: SweepReport = {
    network,
    expired: 0,
    checked: 0,
    confirmed: 0,
    seen: 0,
    underpaid: 0,
    scannedTxs: 0,
    truncated: false,
  };

  report.expired = await expireStaleOrders();

  const { orders, truncated: pendingTruncated } = await pendingOrders(network);
  if (pendingTruncated) {
    report.truncated = true;
    console.warn(
      `[watcher] ${network}: hơn ${PENDING_LIMIT} đơn đang chờ, lượt này bỏ sót phần cũ nhất. ` +
        "Tăng nhịp cron hoặc rút ngắn PAYMENT_ORDER_TTL_SECONDS.",
    );
  }

  if (orders.length === 0) return report;

  /** Cộng kết quả vào báo cáo. `stale_quote` ghi vào ô `underpaid`, đúng như trong DB. */
  const tally = (outcome: VerifyVerdict["state"] | null) => {
    if (outcome === "confirmed") report.confirmed++;
    else if (outcome === "seen") report.seen++;
    else if (outcome === "underpaid" || outcome === "stale_quote") report.underpaid++;
  };

  /* Đường nhanh: đơn đã biết txHash (đã gắn, hoặc client vừa báo). */
  const stillUnknown: Order[] = [];

  for (const order of orders) {
    const txHash = order.txHash ?? (await recallCandidateTx(order.ref));
    if (!txHash) {
      stillUnknown.push(order);
      continue;
    }

    const outcome = await withLock(`lock:order:${order.id}`, LOCK_TTL_MS, async () => {
      report.checked++;
      const { verdict } = await checkOrderAgainstTx(order, txHash);
      return verdict.state;
    });

    tally(outcome);
    // Gợi ý sai (rejected/not_found) thì để nguyên; đường quét bên dưới lo tiếp.
    if (outcome !== null && !SETTLED.has(outcome) && order.txHash === null) {
      stillUnknown.push(order);
    }
  }

  if (stillUnknown.length === 0) return report;

  /* Đường chắc: quét giao dịch tới địa chỉ merchant, đọc metadata để tự ghép. */

  // Gom theo địa chỉ merchant, KHÔNG lấy địa chỉ của đơn đầu tiên rồi áp cho tất cả.
  //
  // `merchant_address` được snapshot vào từng đơn lúc tạo (xem orders.ts) đúng để đổi
  // MERCHANT_ADDRESS_* không làm sai đơn cũ. Quét một địa chỉ duy nhất sẽ phá vỡ chính
  // bất biến đó: sau khi xoay ví, `pendingOrders` sắp xếp created_at DESC nên địa chỉ
  // được chọn luôn là ví MỚI, còn đơn cũ — vốn in ví cũ lên hoá đơn và QR của khách —
  // không bao giờ được ghép. Tiền về ví cũ, đơn nằm im tới lúc hết hạn.
  const byMerchant = new Map<string, Order[]>();
  for (const order of stillUnknown) {
    const group = byMerchant.get(order.merchantAddress);
    if (group) group.push(order);
    else byMerchant.set(order.merchantAddress, [order]);
  }

  for (const [merchantAddress, group] of byMerchant) {
    const byRef = new Map<string, string>();

    // Không có cache `scanned` thì mọi giao dịch đều "mới" ở mọi lượt — phân trang lúc
    // đó chỉ đốt hạn mức mà không tiến thêm được gì. Giữ một trang nhỏ như trước.
    const cached = isRedisConfigured();
    const pageSize = cached ? SCAN_PAGE_SIZE : SCAN_LIMIT_NO_CACHE;
    const maxPages = cached ? SCAN_MAX_PAGES : 1;

    let budget = SCAN_METADATA_BUDGET;
    let exhausted = false;

    for (let page = 1; page <= maxPages && !exhausted; page++) {
      const rows = await getAddressTransactions(network, merchantAddress, pageSize, page);
      if (rows.length === 0) break;

      let fresh = 0;

      for (const item of rows) {
        // Giao dịch đã soi rồi mà không khớp đơn nào thì mãi mãi không khớp — nhớ lại
        // để không phải tải metadata của nó ở mọi lượt quét sau.
        const seenKey = scannedKey(network, item.tx_hash);
        if (cached && (await cacheGetJson<boolean>(seenKey))) continue;

        fresh++;

        if (budget <= 0) {
          exhausted = true;
          break;
        }
        budget--;

        report.scannedTxs++;
        const refs = extractPaymentRefs(await getTxMetadata(network, item.tx_hash));

        if (refs.length === 0) {
          if (cached) await cacheSetJson(seenKey, true, SCANNED_TTL_SECONDS);
          continue;
        }
        for (const ref of refs) byRef.set(ref, item.tx_hash);
      }

      // Cả trang đều đã soi từ lượt trước => đã bắt kịp lịch sử, không cần đi sâu hơn.
      if (fresh === 0) break;
      // Trang chưa đầy => hết lịch sử của địa chỉ này.
      if (rows.length < pageSize) break;

      // Trang cuối vẫn đầy và vẫn còn giao dịch mới: còn lịch sử chưa đọc tới.
      if (page === maxPages) exhausted = true;
    }

    if (exhausted) {
      report.truncated = true;
      console.warn(
        `[watcher] ${network}: còn giao dịch chưa đọc metadata ở địa chỉ ${merchantAddress}. ` +
          (cached
            ? "Tăng nhịp cron nếu cờ này bật liên tục."
            : "Chưa có REDIS_URL nên không cache được giao dịch đã soi — mỗi lượt quét lại " +
              "bắt đầu từ đầu và không bao giờ bắt kịp lịch sử."),
      );
    }

    for (const order of group) {
      const txHash = byRef.get(order.ref);
      if (!txHash) continue;

      const outcome = await withLock(`lock:order:${order.id}`, LOCK_TTL_MS, async () => {
        report.checked++;
        const { verdict } = await checkOrderAgainstTx(order, txHash);
        return verdict.state;
      });

      tally(outcome);
    }
  }

  return report;
}
