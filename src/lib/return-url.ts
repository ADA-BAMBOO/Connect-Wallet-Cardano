import "server-only";

/**
 * Duyệt `returnUrl` — nơi khách được đưa về sau khi trả tiền xong.
 *
 * URL này do shop khai qua API, và nó xuất hiện trên trang `/pay/<ref>` dưới dạng một
 * đường dẫn khách bấm vào. Nhận bừa là tự tay dựng một open redirect có thương hiệu:
 * kẻ tấn công tạo đơn 0,01 USD với returnUrl trỏ sang trang lừa đảo, gửi link
 * `/pay/<ref>` đi, và nạn nhân thấy tên miền thanh toán quen thuộc của bạn.
 *
 * Nên origin phải nằm trong allowlist, và việc duyệt xảy ra ĐÚNG MỘT LẦN lúc tạo đơn.
 * Giá trị đã nằm trong cột `return_url` là giá trị đã qua cửa này.
 */

const ENV_NAME = "MERCHANT_RETURN_URL_ORIGINS";

/** URL dài quá thì gần như chắc chắn là đang nhồi dữ liệu, không phải đường dẫn thật. */
const MAX_LENGTH = 2_048;

/** Origin được phép, phân tách bằng dấu phẩy. So sánh theo origin đã chuẩn hoá. */
function allowedOrigins(): string[] {
  const configured = (process.env[ENV_NAME] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      try {
        return new URL(entry).origin;
      } catch {
        console.warn(`[integration] ${ENV_NAME} chứa mục không phải URL: "${entry}" — bỏ qua.`);
        return null;
      }
    })
    .filter((entry): entry is string => entry !== null);

  return configured;
}

export type ReturnUrlCheck = { ok: true; url: string } | { ok: false; error: string };

/**
 * Duyệt một returnUrl.
 *
 * Chưa cấu hình allowlist thì KHÔNG mở toang: ở dev chỉ chấp nhận localhost (đủ để
 * chạy shop ở cổng khác trên cùng máy), ở production từ chối hẳn. Không cấu hình mà
 * mặc định nhận mọi origin thì lỗ hổng open redirect có sẵn từ ngày đầu.
 */
export function validateReturnUrl(raw: unknown): ReturnUrlCheck {
  if (raw === null || raw === undefined || raw === "") return { ok: true, url: "" };

  if (typeof raw !== "string") return { ok: false, error: '"returnUrl" phải là chuỗi.' };
  if (raw.length > MAX_LENGTH) return { ok: false, error: `"returnUrl" dài quá ${MAX_LENGTH} ký tự.` };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: '"returnUrl" không phải URL tuyệt đối hợp lệ.' };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    // javascript:, data:, intent:… — mọi thứ ngoài http/https đều là đường tấn công,
    // không phải đường về cửa hàng.
    return { ok: false, error: '"returnUrl" phải dùng http hoặc https.' };
  }

  if (url.username || url.password) {
    // `https://shop.com@evil.com/` — mắt người đọc thành shop.com, trình duyệt đi
    // tới evil.com. Không có lý do chính đáng nào để URL quay về mang theo thông tin
    // đăng nhập, nên chặn thẳng.
    return { ok: false, error: '"returnUrl" không được chứa thông tin đăng nhập.' };
  }

  const allowlist = allowedOrigins();

  if (allowlist.length === 0) {
    const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (process.env.NODE_ENV !== "production" && isLocal) {
      return { ok: true, url: url.toString() };
    }
    return {
      ok: false,
      error: `Chưa cấu hình ${ENV_NAME} nên không nhận "returnUrl". Thêm origin của shop vào biến này.`,
    };
  }

  if (!allowlist.includes(url.origin)) {
    return {
      ok: false,
      error: `Origin "${url.origin}" không nằm trong ${ENV_NAME}.`,
    };
  }

  if (url.protocol === "http:" && process.env.NODE_ENV === "production") {
    const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (!isLocal) {
      // Origin có trong allowlist rồi, nhưng http nghĩa là mã đơn và trạng thái thanh
      // toán đi qua mạng ở dạng thô. Ở production thì đây là lỗi cấu hình, không phải
      // lựa chọn.
      return { ok: false, error: '"returnUrl" phải dùng https ở môi trường production.' };
    }
  }

  return { ok: true, url: url.toString() };
}

/**
 * Gắn kết quả vào URL quay về.
 *
 * Shop KHÔNG được tin mấy tham số này — khách sửa thanh địa chỉ là đổi được hết.
 * Chúng chỉ để hiển thị ("Cảm ơn, đơn ABC đã thanh toán"). Sự thật nằm ở webhook đã
 * ký, hoặc ở một lời gọi `GET /api/v1/orders/<ref>` từ server shop.
 */
export function buildReturnUrl(
  returnUrl: string,
  params: { ref: string; status: string; externalOrderId?: string | null },
): string {
  const url = new URL(returnUrl);
  url.searchParams.set("ref", params.ref);
  url.searchParams.set("status", params.status);
  if (params.externalOrderId) url.searchParams.set("orderId", params.externalOrderId);
  return url.toString();
}

export function isReturnUrlAllowlistConfigured(): boolean {
  return allowedOrigins().length > 0;
}
