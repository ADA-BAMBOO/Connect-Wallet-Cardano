import "server-only";

const ENV_NAME = "PAYMENT_PUBLIC_URL";

/**
 * Địa chỉ công khai của chính dịch vụ này — dùng để dựng link `/pay/<ref>` trả về cho shop.
 *
 * VÌ SAO KHÔNG CHỈ ĐỌC `host` TỪ REQUEST: `Host` và `X-Forwarded-Host` là header do
 * client gửi. Đằng sau một proxy không ghi đè chúng, kẻ tấn công tạo đơn với
 * `Host: evil.com` và nhận về `https://evil.com/pay/<ref>` — rồi shop đem chính link
 * đó gửi cho khách hàng của mình. Header chỉ được dùng làm phương án dự phòng lúc dev.
 *
 * Ở production hãy đặt `PAYMENT_PUBLIC_URL=https://pay.shop.com`.
 */
export function publicBaseUrl(request?: Request): string {
  const configured = process.env[ENV_NAME]?.trim();

  if (configured) {
    try {
      // Bỏ dấu `/` cuối để nối chuỗi không sinh ra `//pay/...`.
      return new URL(configured).toString().replace(/\/$/, "");
    } catch {
      console.warn(`[integration] ${ENV_NAME}="${configured}" không phải URL hợp lệ — bỏ qua.`);
    }
  }

  if (process.env.NODE_ENV === "production") {
    // Không đoán ở production. Link sai gửi tới khách hàng thật là chuyện phải sửa
    // cấu hình, không phải chuyện để hệ thống tự xoay xở cho qua.
    throw new Error(`Thiếu ${ENV_NAME}. Đặt địa chỉ công khai của cổng thanh toán, ví dụ https://pay.shop.com`);
  }

  if (request) {
    try {
      return new URL(request.url).origin;
    } catch {
      /* rơi xuống mặc định bên dưới */
    }
  }

  return "http://localhost:3000";
}

/** Link trang thanh toán gửi cho người trả tiền. */
export function payUrlFor(ref: string, request?: Request): string {
  return `${publicBaseUrl(request)}/pay/${ref}`;
}
