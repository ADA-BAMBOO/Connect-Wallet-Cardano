import { after, NextResponse } from "next/server";

import { getOrderView } from "@/lib/order-view";
import { isValidRef } from "@/lib/ref";
import { dispatchDueWebhooks } from "@/lib/webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/payments/orders/[ref]
 *
 * Trạng thái đơn kèm danh sách token trả được. Trang thanh toán poll endpoint này
 * sau lần nạp đầu tiên (lần đầu do server component tự lấy, xem app/pay/[ref]).
 *
 * Trong Next 16 `params` là một Promise — phải await. Đây là breaking change so với
 * các bản trước, quên await thì nhận về `[object Promise]` chứ không phải lỗi.
 */
export async function GET(_request: Request, ctx: RouteContext<"/api/payments/orders/[ref]">) {
  const { ref } = await ctx.params;

  // Kiểm định dạng trước khi hỏi DB: chặn rác trước khi tốn một vòng tới Postgres.
  if (!isValidRef(ref)) {
    return NextResponse.json({ error: "Mã đơn không hợp lệ." }, { status: 400 });
  }

  const view = await getOrderView(ref);
  if (!view) return NextResponse.json({ error: "Không tìm thấy đơn hàng." }, { status: 404 });

  // Đây là nơi đơn THỰC SỰ được chốt trong đa số trường hợp: `getOrderView` đối chiếu
  // lại on-chain (có tiết chế), và người trả đang mở trang thanh toán poll vào đây mỗi
  // vài giây. Đẩy hàng đợi ngay sau đó thì shop biết tin gần như tức thì thay vì chờ
  // lượt cron kế tiếp.
  //
  // Đây chỉ là đường ĐI TẮT, không phải đường bảo đảm — khách đóng tab thì không còn
  // ai poll nữa. Bảo đảm nằm ở cron watcher.
  after(async () => {
    try {
      await dispatchDueWebhooks();
    } catch (error) {
      console.error("[webhook] Gửi cơ hội thất bại:", error);
    }
  });

  return NextResponse.json(view);
}
