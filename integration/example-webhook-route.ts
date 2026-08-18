/**
 * VÍ DỤ — dán vào dự án bán hàng tại `src/app/api/webhooks/cardano-pay/route.ts`.
 *
 * Rồi trỏ `MERCHANT_WEBHOOK_URL` của cổng thanh toán về đúng đường dẫn này.
 *
 * Ba luật của một endpoint nhận webhook, và cả ba đều được minh hoạ bên dưới:
 *
 *   1. Xác minh chữ ký TRƯỚC KHI đọc nội dung. Không có bước này thì bất kỳ ai biết
 *      URL cũng "xác nhận" được đơn của chính họ.
 *   2. Xử lý IDEMPOTENT. Đảm bảo là "ít nhất một lần" — cùng một sự kiện có thể tới
 *      hai lần khi lần đầu trả lỗi sau lúc bạn đã ghi database.
 *   3. Trả 2xx NHANH. Việc nặng đẩy sang hàng đợi nền; endpoint chậm quá 10 giây bị
 *      tính là thất bại và sẽ được gửi lại.
 */

import { verifyWebhook, SIGNATURE_HEADER, type WebhookPayload } from "./cardano-pay-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const secret = process.env.CARDANO_PAY_WEBHOOK_SECRET;
  if (!secret) {
    // 500 chứ không 200: thiếu cấu hình thì phải được thử lại sau khi bạn sửa xong,
    // không phải được đánh dấu "đã giao" rồi biến mất.
    console.error("[cardano-pay] Thiếu CARDANO_PAY_WEBHOOK_SECRET.");
    return new Response("chưa cấu hình", { status: 500 });
  }

  // THÂN THÔ, không phải request.json(). Xem chú thích ở verifyWebhook — parse rồi
  // stringify lại là chữ ký không bao giờ khớp nữa.
  const raw = await request.text();

  const result = verifyWebhook(raw, request.headers.get(SIGNATURE_HEADER), secret);
  if (!result.ok) {
    console.warn("[cardano-pay] Webhook bị từ chối:", result.error);
    // 401 để bên gửi ghi lại lý do. Không tiết lộ thêm gì.
    return new Response("chữ ký không hợp lệ", { status: 401 });
  }

  const { event, data } = result.payload;

  try {
    await handleEvent(result.payload);
  } catch (error) {
    console.error(`[cardano-pay] Xử lý ${event} cho ${data.ref} thất bại:`, error);
    // 500 để được gửi lại. Nuốt lỗi rồi trả 200 nghĩa là mất hẳn sự kiện này.
    return new Response("lỗi xử lý", { status: 500 });
  }

  return Response.json({ received: true });
}

async function handleEvent(payload: WebhookPayload): Promise<void> {
  const { event, data: order } = payload;

  // `externalOrderId` chính là mã đơn bạn đã gửi lúc tạo. Nó là cầu nối duy nhất về
  // database của shop — `ref` chỉ có nghĩa bên cổng thanh toán.
  const orderId = order.externalOrderId;
  if (!orderId) {
    // Đơn tạo thẳng từ trang demo của cổng thanh toán, không thuộc shop nào.
    console.warn(`[cardano-pay] ${event} cho ${order.ref} không có externalOrderId — bỏ qua.`);
    return;
  }

  switch (event) {
    case "order.confirmed": {
      // ĐÂY là trạng thái duy nhất được phép giao hàng.
      //
      // Idempotency: cập nhật CÓ ĐIỀU KIỆN thay vì đọc-rồi-ghi. Hai webhook tới cùng
      // lúc (lần thử lại chồng lên lần đầu) đều đọc thấy "chưa trả" rồi cả hai cùng
      // giao hàng — điều kiện nằm trong câu UPDATE thì database phân xử giúp bạn.
      //
      //   UPDATE orders
      //      SET status = 'paid', tx_hash = $2, paid_at = now()
      //    WHERE id = $1 AND status <> 'paid'
      //
      // Chỉ tiếp tục giao hàng khi câu lệnh đó thực sự đổi được một dòng.
      await markOrderPaid(orderId, {
        txHash: order.tx?.hash ?? null,
        amountUsd: order.amountUsd,
        paidWith: order.payment?.symbol ?? null,
      });
      break;
    }

    case "order.underpaid": {
      // Tiền đã về nhưng thiếu, hoặc về sau khi tỷ giá ADA đã hết hạn. KHÔNG tự động
      // giao và cũng KHÔNG tự động huỷ — tiền thật đang nằm trong ví merchant, và
      // quyết định (thu thêm, hoàn lại, hay chấp nhận) là của con người.
      await flagForReview(orderId, order.ref);
      break;
    }

    case "order.expired": {
      // Nhả hàng đang giữ trong kho. Hết hạn là kết cục rất phổ biến của đơn crypto —
      // người ta mở trang thanh toán rồi đổi ý.
      await releaseReservation(orderId);
      break;
    }

    case "order.seen": {
      // Giao dịch đã lên chain nhưng CHƯA đủ xác nhận. Dùng để hiện "đang xác nhận…"
      // cho khách. TUYỆT ĐỐI không giao hàng ở đây: block chứa giao dịch này vẫn có
      // thể bị thay thế, và khi đó tiền chưa từng về.
      await markOrderPending(orderId);
      break;
    }

    case "order.failed":
      await flagForReview(orderId, order.ref);
      break;
  }
}

/* ------------------------------------------------------------------ */
/* Thay bằng hàm thật của shop                                         */
/* ------------------------------------------------------------------ */

async function markOrderPaid(
  orderId: string,
  info: { txHash: string | null; amountUsd: string; paidWith: string | null },
): Promise<void> {
  console.log(`[shop] Đơn ${orderId} đã thanh toán ${info.amountUsd} USD bằng ${info.paidWith}`, info.txHash);
}

async function markOrderPending(orderId: string): Promise<void> {
  console.log(`[shop] Đơn ${orderId} đang chờ xác nhận trên chain`);
}

async function flagForReview(orderId: string, ref: string): Promise<void> {
  console.warn(`[shop] Đơn ${orderId} (${ref}) cần người xem lại`);
}

async function releaseReservation(orderId: string): Promise<void> {
  console.log(`[shop] Nhả hàng giữ cho đơn ${orderId}`);
}
