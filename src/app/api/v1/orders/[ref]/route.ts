import { NextResponse } from "next/server";

import { checkApiKey } from "@/lib/api-key";
import { getOrderByRef, serializeOrder } from "@/lib/orders";
import { payUrlFor } from "@/lib/public-url";
import { isValidRef } from "@/lib/ref";
import { listDeliveries } from "@/lib/webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/orders/[ref]
 *
 * Trạng thái đơn theo góc nhìn của shop, kèm nhật ký webhook.
 *
 * ĐÂY LÀ NGUỒN SỰ THẬT khi shop cần chắc chắn. Tham số trên `returnUrl` do trình duyệt
 * mang về thì khách sửa được; webhook thì có thể đang trên đường. Trước khi giao một
 * món hàng đắt tiền, hỏi thẳng endpoint này.
 *
 * `deliveries` để trả lời câu "vì sao shop chưa nhận được webhook" mà không phải mở
 * database ra xem — gần như luôn là URL sai hoặc endpoint của shop trả lỗi, và
 * `lastError` nói thẳng ra điều đó.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/v1/orders/[ref]">) {
  const auth = checkApiKey(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { ref } = await ctx.params;

  if (!isValidRef(ref)) {
    return NextResponse.json({ error: "Mã đơn không hợp lệ." }, { status: 400 });
  }

  const order = await getOrderByRef(ref);
  if (!order) return NextResponse.json({ error: "Không tìm thấy đơn hàng." }, { status: 404 });

  return NextResponse.json({
    order: serializeOrder(order),
    payUrl: payUrlFor(order.ref, request),
    deliveries: await listDeliveries(order.id),
  });
}
