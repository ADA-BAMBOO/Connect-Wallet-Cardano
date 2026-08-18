import { after, NextResponse } from "next/server";

import { checkApiKey } from "@/lib/api-key";
import { getOrderByRef } from "@/lib/orders";
import { isValidRef } from "@/lib/ref";
import { dispatchDueWebhooks, listDeliveries, replayWebhooks } from "@/lib/webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/orders/[ref]/replay
 *
 * Đưa mọi webhook chưa gửi được của một đơn về lại hàng đợi.
 *
 * Dành cho hai tình huống có thật: shop sập lâu hơn thời gian retry (~10 tiếng) nên
 * hàng đợi đã bỏ cuộc, hoặc `MERCHANT_WEBHOOK_URL` khai sai và mọi lần thử đều tới
 * nhầm chỗ. Sửa cấu hình xong thì gọi endpoint này thay vì đi sửa tay trong database.
 *
 * KHÔNG dựng lại payload: nó là ảnh chụp tại thời điểm sự kiện xảy ra. Chỉ URL đích
 * được cập nhật theo cấu hình hiện tại — vì đó chính là thứ vừa được sửa.
 *
 * Sự kiện đã `delivered` thì không đụng tới. Muốn gửi lại một sự kiện đã giao thành
 * công thì phải xoá dòng đó trong database, và sự bất tiện đó là cố ý: gửi lại
 * "order.confirmed" cho một đơn đã xử lý là cách nhanh nhất để shop giao hàng hai lần.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/v1/orders/[ref]/replay">) {
  const auth = checkApiKey(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { ref } = await ctx.params;

  if (!isValidRef(ref)) {
    return NextResponse.json({ error: "Mã đơn không hợp lệ." }, { status: 400 });
  }

  const order = await getOrderByRef(ref);
  if (!order) return NextResponse.json({ error: "Không tìm thấy đơn hàng." }, { status: 404 });

  const requeued = await replayWebhooks(order.id);

  // Gửi ngay sau khi response đã đi, chứ không bắt người gọi chờ một lời gọi HTTP sang
  // shop. `after` chạy cả khi response đã kết thúc — xem docs/01-app/.../after.md.
  after(async () => {
    try {
      await dispatchDueWebhooks();
    } catch (error) {
      console.error("[webhook] Gửi lại sau replay thất bại:", error);
    }
  });

  return NextResponse.json({
    ref: order.ref,
    requeued,
    deliveries: await listDeliveries(order.id),
  });
}
