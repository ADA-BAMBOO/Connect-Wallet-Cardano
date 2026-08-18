import "server-only";

import { getOrderByRef, serializeOrder, type SerializedOrder } from "@/lib/orders";
import { getPegStatuses } from "@/lib/price";
import { getPayableTokens } from "@/lib/stablecoins";
import { maybeRefreshOrder } from "@/lib/watcher";

/**
 * Dữ liệu trang thanh toán cần: đơn hàng + danh sách token trả được.
 *
 * Dùng chung giữa `GET /api/payments/orders/[ref]` (client poll) và server component
 * của trang `/pay/[ref]` (lần nạp đầu tiên). Một nguồn duy nhất nên hai đường không
 * bao giờ lệch nhau — và trang không phải nhấp nháy spinner trước khi có dữ liệu.
 */

export type TokenOption = {
  symbol: string;
  label: string;
  unit: string;
  decimals: number;
  pegged: boolean;
  /** false khi token đang lệch peg — trang thanh toán vô hiệu hoá nút chọn. */
  available: boolean;
  pegState: string | null;
};

export type OrderView = { order: SerializedOrder; tokens: TokenOption[] };

export async function getOrderView(ref: string): Promise<OrderView | null> {
  const found = await getOrderByRef(ref);
  if (!found) return null;

  // Đối chiếu lại on-chain nếu đơn đang chờ và đã biết txHash — có tiết chế 6 giây
  // dùng chung toàn cụm. Nhờ vậy trang tự tiến triển mà không cần cron watcher.
  const order = await maybeRefreshOrder(found);

  // Đánh dấu token lệch peg ngay từ đây, để người trả không chọn xong mới bị từ chối
  // ở bước khoá giá.
  const peg = await getPegStatuses(order.network);
  const pegByUnit = new Map(peg.map((entry) => [entry.unit, entry]));

  const tokens: TokenOption[] = getPayableTokens(order.network).map((token) => {
    const status = pegByUnit.get(token.unit);
    return {
      symbol: token.symbol,
      label: token.label,
      unit: token.unit,
      decimals: token.decimals,
      pegged: token.pegged,
      available: status ? status.acceptable : true,
      pegState: status?.status.state ?? null,
    };
  });

  return { order: serializeOrder(order), tokens };
}
