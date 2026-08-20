/**
 * Ngôn ngữ giao diện. Không import gì để chạy được ở cả server lẫn client.
 *
 * Chọn ngôn ngữ bằng COOKIE, không bằng đường dẫn (`/en/...`).
 *
 * Lý do: link thanh toán `/pay/<ref>` đã nằm trong mã QR người bán gửi cho khách và
 * trong tài liệu tích hợp. Thêm tiền tố ngôn ngữ vào URL là đổi luôn những link đó
 * — đổi URL của một hoá đơn đã phát đi là cái giá quá đắt cho một nút đổi ngôn ngữ.
 *
 * Đánh đổi: không có URL riêng cho từng ngôn ngữ nên không chia sẻ/đánh chỉ mục
 * riêng được. Chấp nhận vì /orders đã noindex và /pay là trang thanh toán.
 */

export const LOCALES = ["vi", "en"] as const;

export type Locale = (typeof LOCALES)[number];

/**
 * Tiếng Việt là mặc định khi chưa có cookie.
 *
 * KHÔNG tự đoán theo `Accept-Language`. Ngôn ngữ hiện ra phải phụ thuộc đúng một
 * thứ người dùng bấm được, thay vì đổi theo cấu hình trình duyệt của từng máy —
 * và các bài kiểm thử giao diện cũng cần một mặc định tiền đoán được.
 */
export const DEFAULT_LOCALE: Locale = "vi";

/** Không đặt httpOnly: nút đổi ngôn ngữ ghi cookie này ngay từ client. */
export const LOCALE_COOKIE = "cardano_locale";

export const LOCALE_MAX_AGE = 60 * 60 * 24 * 365; // 1 năm

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

export function resolveLocale(value: unknown): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

/** Tên ngôn ngữ hiển thị trên nút đổi — luôn viết bằng chính ngôn ngữ đó. */
export const LOCALE_LABELS: Record<Locale, string> = {
  vi: "Tiếng Việt",
  en: "English",
};

export const LOCALE_SHORT: Record<Locale, string> = {
  vi: "VI",
  en: "EN",
};
