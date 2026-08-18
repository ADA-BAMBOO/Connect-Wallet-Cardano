import "server-only";

import { safeEqual } from "@/lib/constant-time";

/**
 * Xác thực máy-với-máy cho API tích hợp (`/api/v1/*`).
 *
 * Endpoint tạo đơn công khai ở `/api/payments/orders` chỉ có rào rate-limit theo IP:
 * đủ cho một trang demo tự tạo đơn cho chính mình, KHÔNG đủ khi dự án bán hàng gọi
 * sang. Ở đó `externalOrderId` và `returnUrl` do người gọi khai, nên phải biết chắc
 * người gọi là server của shop chứ không phải trình duyệt bất kỳ.
 *
 * Khoá nằm trong biến môi trường của SERVER shop, không bao giờ nhúng vào bundle
 * trình duyệt. Lộ khoá thì kẻ tấn công tạo được đơn rác và gắn `returnUrl` — nhưng
 * KHÔNG đổi được địa chỉ nhận tiền (địa chỉ đó chỉ đến từ env của dịch vụ này).
 */

const ENV_NAME = "MERCHANT_API_KEYS";

/**
 * Độ dài tối thiểu. Khoá 8 ký tự đứng trước một endpoint ghi database thì thà không
 * có còn hơn — ít nhất lúc đó người ta biết là mình chưa bảo vệ gì.
 */
const MIN_KEY_LENGTH = 24;

/**
 * Danh sách khoá hợp lệ, phân tách bằng dấu phẩy.
 *
 * Nhận NHIỀU khoá để xoay khoá không phải ngừng dịch vụ: thêm khoá mới vào danh sách,
 * đổi cấu hình bên shop, rồi mới bỏ khoá cũ đi. Một khoá duy nhất thì mọi lần xoay
 * đều có một khoảng shop gọi sang bằng khoá đã chết.
 */
function configuredKeys(): string[] {
  return (process.env[ENV_NAME] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export type ApiKeyCheck =
  | { ok: true; reason: "dev-open" | "authenticated" }
  | { ok: false; status: 401 | 403 | 503; error: string };

/**
 * Đọc khoá từ request.
 *
 * Nhận cả hai kiểu vì hai kiểu đều phổ biến và người tích hợp không nên phải tra tài
 * liệu để biết dự án này chọn kiểu nào:
 *   Authorization: Bearer <key>
 *   x-api-key: <key>
 */
function readKey(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header) {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match) return match[1]!.trim();
  }
  return request.headers.get("x-api-key")?.trim() || null;
}

/**
 * Kiểm khoá API.
 *
 * Chưa cấu hình `MERCHANT_API_KEYS`:
 *   - dev        → cho qua (kèm cảnh báo), để chạy thử không phải dựng đủ cấu hình
 *   - production → CHẶN
 *
 * Fail-closed ở production theo đúng lệ của `checkAdmin`: quên cấu hình mà mặc định
 * mở nghĩa là API tạo đơn nằm trần trên internet, và không có gì báo cho bạn biết.
 */
export function checkApiKey(request: Request): ApiKeyCheck {
  const keys = configuredKeys();

  if (keys.length === 0) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(`[integration] Chưa cấu hình ${ENV_NAME} — /api/v1 đang mở vì đây là môi trường dev.`);
      return { ok: true, reason: "dev-open" };
    }
    return {
      ok: false,
      status: 503,
      error: `Chưa cấu hình ${ENV_NAME} nên API tích hợp bị khoá.`,
    };
  }

  // Khoá yếu bị từ chối ngay cả khi người gọi gửi ĐÚNG nó. Chấp nhận một khoá ngắn là
  // để lại một cửa mở mà nhật ký nào cũng báo "đăng nhập thành công".
  const weak = keys.filter((key) => key.length < MIN_KEY_LENGTH);
  if (weak.length > 0) {
    return {
      ok: false,
      status: 503,
      error: `${ENV_NAME} chứa khoá ngắn hơn ${MIN_KEY_LENGTH} ký tự. Sinh khoá mới: openssl rand -hex 32`,
    };
  }

  const presented = readKey(request);
  if (!presented) {
    return {
      ok: false,
      status: 401,
      error: 'Thiếu khoá API. Gửi kèm header "authorization: Bearer <khoá>" hoặc "x-api-key: <khoá>".',
    };
  }

  // Duyệt HẾT danh sách chứ không thoát sớm khi khớp: thời gian chạy khi đó phụ thuộc
  // vào vị trí của khoá trong danh sách, mà `safeEqual` vốn được dùng chính để không
  // rò rỉ kiểu thông tin đó.
  let matched = false;
  for (const key of keys) {
    if (safeEqual(presented, key)) matched = true;
  }

  if (!matched) return { ok: false, status: 403, error: "Khoá API không hợp lệ." };

  return { ok: true, reason: "authenticated" };
}

/** true nếu đã cấu hình khoá — trang health dựa vào cờ này. */
export function isApiKeyConfigured(): boolean {
  return configuredKeys().length > 0;
}
