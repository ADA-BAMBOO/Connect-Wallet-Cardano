import { NextResponse } from "next/server";

import { getOrderByRef, serializeOrder } from "@/lib/orders";
import { checkRateLimit, guardRequest } from "@/lib/rate-limit";
import { isValidRef } from "@/lib/ref";
import { checkOrderAgainstTx, rememberCandidateTx } from "@/lib/watcher";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Hạn mức cho endpoint này.
 *
 * Mỗi lần gọi tốn 4 lời gọi Blockfrost và có thể sinh một dòng nhật ký — mà nó công
 * khai, không cần đăng nhập, và chỉ đòi một `ref` hợp lệ cùng 64 ký tự hex bất kỳ.
 * Không chặn thì một vòng lặp curl đốt sạch hạn mức Blockfrost trong vài phút, và khi
 * hết hạn mức thì watcher chết theo — tức là MỌI đơn hàng thật ngừng xác minh được.
 *
 * Chặn theo HAI trục vì mỗi trục bịt một lỗ khác nhau: theo `ref` để một đơn không bị
 * dội từ nhiều IP, theo IP để một máy không rải qua nhiều đơn.
 */
const SUBMIT_WINDOW_SECONDS = 60;
const SUBMIT_PER_REF = 12;
const SUBMIT_PER_CLIENT = 60;

/**
 * POST /api/payments/orders/[ref]/submit
 *
 * Body: { txHash: "<64 hex>" }
 *
 * Người trả báo về giao dịch vừa gửi. Đây CHỈ LÀ GỢI Ý để khỏi chờ watcher quét —
 * server không tin một chữ nào trong đó ngoài việc dùng nó làm chỗ để đi hỏi chain.
 * Mọi kết luận "đã trả tiền" đều rút ra từ dữ liệu Blockfrost trả về.
 *
 * Bỏ hẳn endpoint này đi thì hệ thống vẫn đúng, chỉ chậm hơn vài giây — đó là phép
 * thử xem một thiết kế thanh toán có chắc hay không.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/payments/orders/[ref]/submit">) {
  const { ref } = await ctx.params;

  if (!isValidRef(ref)) {
    return NextResponse.json({ error: "Mã đơn không hợp lệ." }, { status: 400 });
  }

  // Chặn trước khi chạm tới Blockfrost hay Postgres — đó mới là thứ cần bảo vệ.
  // Theo `ref` để một đơn không bị dội từ nhiều IP; theo client (kèm hạn mức tổng khi
  // chưa khai proxy tin cậy) để một máy không rải qua nhiều đơn.
  const perRef = await checkRateLimit(`submit:ref:${ref}`, SUBMIT_PER_REF, SUBMIT_WINDOW_SECONDS);
  const perClient = perRef.allowed
    ? await guardRequest(request, "submit:client", SUBMIT_PER_CLIENT, SUBMIT_WINDOW_SECONDS)
    : perRef;

  if (!perClient.allowed) {
    return NextResponse.json(
      { error: `Quá nhiều lần báo giao dịch. Thử lại sau ${perClient.resetIn} giây.` },
      { status: 429, headers: { "retry-after": String(perClient.resetIn) } },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body không phải JSON hợp lệ." }, { status: 400 });
  }

  const { txHash } = (body ?? {}) as Record<string, unknown>;

  if (typeof txHash !== "string" || !/^[0-9a-f]{64}$/.test(txHash.trim())) {
    return NextResponse.json(
      { error: "txHash phải là 64 ký tự hex thường." },
      { status: 400 },
    );
  }

  const order = await getOrderByRef(ref);
  if (!order) return NextResponse.json({ error: "Không tìm thấy đơn hàng." }, { status: 404 });

  if (order.payUnit === null) {
    return NextResponse.json({ error: "Đơn chưa chọn token thanh toán." }, { status: 409 });
  }

  const { verdict, order: updated } = await checkOrderAgainstTx(order, txHash.trim());

  // Chỉ nhớ gợi ý khi hash CÓ THỂ là khoản trả của đơn này. Ghi vô điều kiện thì bất
  // kỳ ai cũng đạp được gợi ý thật của người đang trả bằng một hash rác, và watcher
  // phải chờ tới lượt quét địa chỉ mới tìm lại được.
  if (verdict.state !== "rejected") {
    // Nhớ lại kể cả khi lần kiểm này chưa thấy gì: giao dịch vừa gửi thường còn nằm
    // trong mempool, Blockfrost trả 404 cho tới khi nó vào block (20–60 giây). Nhờ gợi
    // ý này, watcher kiểm đúng một hash thay vì phải quét cả địa chỉ merchant.
    await rememberCandidateTx(ref, txHash.trim());
  }

  const settled = updated ?? order;

  const payload = {
    verdict: verdict.state,
    order: serializeOrder(settled),
  };

  // Tiền về nhưng đơn đã rời khỏi vòng đời nhận thanh toán (thường là vừa hết hạn).
  // `applyVerdict` đã ghi một dòng `late-payment` vào nhật ký; ở đây phải nói thật với
  // người trả thay vì trả về `verdict: "confirmed"` bên cạnh `status: "expired"`.
  if (
    verdict.state !== "rejected" &&
    verdict.state !== "not_found" &&
    settled.status !== "confirmed" &&
    settled.status !== "seen" &&
    settled.status !== "underpaid"
  ) {
    return NextResponse.json(
      {
        ...payload,
        message:
          `Đã nhận được thanh toán, nhưng đơn đang ở trạng thái "${settled.status}" nên ` +
          "không tự chốt được. Khoản trả đã được ghi nhận và người bán sẽ đối soát.",
      },
      { status: 200 },
    );
  }

  switch (verdict.state) {
    case "rejected":
      // 422: giao dịch có thật nhưng không thoả điều kiện. KHÔNG gắn vào đơn — gắn
      // vào là chiếm mất UNIQUE(tx_hash) và chặn luôn khoản trả thật đến sau.
      return NextResponse.json({ ...payload, error: verdict.reason }, { status: 422 });

    case "stale_quote":
      // 200, không phải lỗi: tiền đã về ví merchant và đã được ghi nhận. Nhưng tỷ giá
      // khoá cho đơn này đã hết hạn trước lúc giao dịch vào block, nên số ADA đó không
      // còn tương ứng với số USD của đơn — cần người bán xác nhận.
      return NextResponse.json(
        {
          ...payload,
          message:
            "Đã nhận được thanh toán, nhưng tỷ giá đã khoá hết hạn trước khi giao dịch " +
            "lên chain. Đơn đang chờ người bán đối soát.",
        },
        { status: 200 },
      );

    case "not_found":
      // 202: chưa thấy trên chain, nhưng đã ghi nhận. Không phải lỗi.
      return NextResponse.json(
        { ...payload, message: "Chưa thấy giao dịch trên chain. Thường mất 20–60 giây để vào block." },
        { status: 202 },
      );

    default:
      return NextResponse.json(payload);
  }
}
