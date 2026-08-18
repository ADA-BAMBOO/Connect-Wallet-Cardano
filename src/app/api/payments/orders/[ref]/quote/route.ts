import { NextResponse } from "next/server";

import { looksLikePaymentAddress } from "@/lib/network";
import { serializeOrder, setQuote } from "@/lib/orders";
import { isValidRef } from "@/lib/ref";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/payments/orders/[ref]/quote
 *
 * Body: { unit: "lovelace" | "<policyId><assetNameHex>", buyerAddress?: "addr…" }
 *
 * Chọn token và khoá số tiền phải trả. Với ADA thì tỷ giá được khoá 15 phút; với
 * stablecoin thì quy ước 1:1 nên không có gì để hết hạn.
 *
 * Gọi lại được khi người trả đổi ý hoặc báo giá hết hạn — nhưng chỉ khi đơn còn
 * `pending` và chưa gắn giao dịch nào. Điều kiện đó nằm trong mệnh đề WHERE của câu
 * UPDATE chứ không kiểm ở tầng ứng dụng, nên hai request đồng thời không lách được.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/payments/orders/[ref]/quote">) {
  const { ref } = await ctx.params;

  if (!isValidRef(ref)) {
    return NextResponse.json({ error: "Mã đơn không hợp lệ." }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body không phải JSON hợp lệ." }, { status: 400 });
  }

  const { unit, buyerAddress } = (body ?? {}) as Record<string, unknown>;

  if (typeof unit !== "string" || !unit.trim()) {
    return NextResponse.json({ error: 'Thiếu "unit".' }, { status: 400 });
  }

  // buyerAddress là tuỳ chọn và chỉ dùng để đối soát/hoàn tiền — nó KHÔNG ảnh hưởng
  // tới việc xác minh, nên khai sai cũng không lợi gì. Vẫn kiểm định dạng để không
  // lưu rác vào DB.
  if (buyerAddress !== undefined && buyerAddress !== null && !looksLikePaymentAddress(buyerAddress)) {
    return NextResponse.json({ error: "buyerAddress không phải địa chỉ hợp lệ." }, { status: 400 });
  }

  const result = await setQuote(ref, unit.trim(), typeof buyerAddress === "string" ? buyerAddress : undefined);

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.code });

  return NextResponse.json({ order: serializeOrder(result.order) });
}
