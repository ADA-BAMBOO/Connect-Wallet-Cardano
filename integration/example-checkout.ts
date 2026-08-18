/**
 * VÍ DỤ — phía shop: từ giỏ hàng tới trang thanh toán.
 *
 * Đặt ở `src/lib/cardano-pay.ts` (client dùng chung) và `src/app/checkout/actions.ts`
 * (server action) trong dự án bán hàng.
 */

import { createCardanoPayClient, type PaymentOrder } from "./cardano-pay-client";

/* ------------------------------------------------------------------ */
/* Client dùng chung                                                   */
/* ------------------------------------------------------------------ */

/**
 * KHÓA API CHỈ SỐNG Ở SERVER.
 *
 * Không đặt tên biến bắt đầu bằng `NEXT_PUBLIC_`, và đừng import file này từ component
 * có `"use client"`. Khoá lọt vào bundle trình duyệt là ai xem mã nguồn trang cũng
 * đọc được, và họ tạo được đơn mang `externalOrderId` tuỳ ý — tức là mã đơn quyết định
 * shop giao hàng cho ai.
 */
export const cardanoPay = createCardanoPayClient({
  baseUrl: process.env.CARDANO_PAY_URL!, // https://pay.shop.com
  apiKey: process.env.CARDANO_PAY_API_KEY!,
  network: (process.env.CARDANO_PAY_NETWORK ?? "preprod") as "mainnet" | "preprod",
});

/* ------------------------------------------------------------------ */
/* Server action: khách bấm "Thanh toán bằng crypto"                   */
/* ------------------------------------------------------------------ */

export async function startCryptoCheckout(shopOrderId: string) {
  // 1. Lấy đơn từ database CỦA SHOP và tự tính lại số tiền.
  //
  //    Số tiền phải đến từ server. Nhận amount do trình duyệt gửi lên là cho khách tự
  //    ra giá cho món hàng của bạn.
  const order = await loadShopOrder(shopOrderId);

  // 2. Tạo đơn thanh toán. Gọi lại bao nhiêu lần cũng an toàn nhờ `externalOrderId`.
  const { payUrl, order: payment, reused } = await cardanoPay.createPayment({
    externalOrderId: order.id,
    amountUsd: order.totalUsd, // chuỗi thập phân, ví dụ "42.00"
    description: `Đơn ${order.id} — ${order.itemCount} sản phẩm`,
    returnUrl: `https://shop.com/don-hang/${order.id}`,
  });

  // 3. Lưu `ref` lại. Đây là thứ dùng để hỏi trạng thái khi webhook chưa tới, và để
  //    hiện lại link thanh toán cho khách nếu họ đóng tab.
  if (!reused) await savePaymentRef(order.id, payment.ref);

  // 4. Redirect. Trong server action của Next.js: redirect(payUrl)
  return payUrl;
}

/* ------------------------------------------------------------------ */
/* Trang "cảm ơn" — nơi khách quay về                                  */
/* ------------------------------------------------------------------ */

/**
 * Khách quay về `https://shop.com/don-hang/<id>?ref=…&status=confirmed&orderId=…`.
 *
 * ĐỪNG TIN mấy tham số đó. Chúng nằm trong thanh địa chỉ, ai cũng sửa được thành
 * `status=confirmed`. Chúng chỉ dùng để biết ĐI HỎI VỀ ĐƠN NÀO.
 *
 * Sự thật có hai nguồn, và cả hai đều đi qua server:
 *   - webhook đã ký (đường chính, tự động)
 *   - `getPayment(ref)` (đường phụ, khi cần chắc chắn ngay tại chỗ)
 */
export async function resolveThankYouPage(shopOrderId: string): Promise<{
  paid: boolean;
  payment: PaymentOrder | null;
}> {
  const order = await loadShopOrder(shopOrderId);

  // Webhook thường tới trước khi khách kịp quay về, nên đường nhanh nhất là đọc chính
  // database của shop.
  if (order.status === "paid") return { paid: true, payment: null };

  // Chưa thấy gì thì hỏi thẳng cổng thanh toán. Xảy ra khi khách quay về nhanh hơn
  // webhook, hoặc khi endpoint webhook của shop đang hỏng.
  try {
    const { order: payment } = await cardanoPay.getPaymentByOrderId(shopOrderId);
    return { paid: payment.status === "confirmed", payment };
  } catch {
    // Cổng thanh toán không trả lời — hiện "đang kiểm tra", đừng hiện "thất bại".
    // Tiền có thể đã về rồi, và webhook vẫn sẽ tới.
    return { paid: false, payment: null };
  }
}

/* ------------------------------------------------------------------ */
/* Thay bằng hàm thật của shop                                         */
/* ------------------------------------------------------------------ */

type ShopOrder = { id: string; totalUsd: string; itemCount: number; status: string };

async function loadShopOrder(id: string): Promise<ShopOrder> {
  return { id, totalUsd: "42.00", itemCount: 3, status: "awaiting_payment" };
}

async function savePaymentRef(orderId: string, ref: string): Promise<void> {
  console.log(`[shop] Đơn ${orderId} ↔ ref ${ref}`);
}
