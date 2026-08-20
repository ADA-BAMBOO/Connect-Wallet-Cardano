import "server-only";

import { cookies } from "next/headers";

import { dictionaries, type Dictionary } from "@/lib/i18n/dictionaries";
import {
  DEFAULT_LOCALE,
  isLocale,
  LOCALES,
  LOCALE_COOKIE,
  resolveLocale,
  type Locale,
} from "@/lib/i18n/locales";

let warnedAboutBadDefault = false;

/**
 * Ngôn ngữ dùng khi người dùng CHƯA bấm chọn gì.
 *
 * Đọc từ biến môi trường `DEFAULT_LOCALE` để một lần deploy có thể mặc định tiếng
 * Anh mà không phải sửa mã — nút đổi ngôn ngữ và cookie vẫn hoạt động y như cũ, nên
 * người Việt bấm VI một lần là xong.
 *
 * Chỉ đọc ở phía server. Biến không mang tiền tố `NEXT_PUBLIC_` nên nó không lọt vào
 * bundle trình duyệt — mà cũng không cần: layout gốc phân giải ngôn ngữ rồi truyền
 * xuống client qua LocaleProvider.
 *
 * Giá trị sai thì cảnh báo MỘT lần rồi quay về tiếng Việt, thay vì ném lỗi. Gõ nhầm
 * tên ngôn ngữ không phải lý do chính đáng để cả cổng thanh toán ngừng nhận tiền.
 */
function resolveDefaultLocale(): Locale {
  const configured = process.env.DEFAULT_LOCALE?.trim();
  if (!configured) return DEFAULT_LOCALE;

  if (!isLocale(configured)) {
    if (!warnedAboutBadDefault) {
      warnedAboutBadDefault = true;
      console.warn(
        `DEFAULT_LOCALE="${configured}" không phải ngôn ngữ được hỗ trợ ` +
          `(${LOCALES.join(", ")}). Đang dùng "${DEFAULT_LOCALE}".`,
      );
    }
    return DEFAULT_LOCALE;
  }

  return configured;
}

/**
 * Ngôn ngữ của request hiện tại: cookie người dùng đã chọn, không có thì lấy mặc
 * định của lần deploy này.
 *
 * Dùng được trong Server Component VÀ Route Handler. Lưu ý `next/root-params` —
 * cách mà tài liệu Next 16 giới thiệu cho i18n theo đường dẫn — KHÔNG chạy trong
 * Route Handler, mà thông báo lỗi của API lại chính là thứ cần dịch. Cookie là
 * nguồn duy nhất chạy được ở cả hai nơi.
 *
 * Gọi `cookies()` khiến route thành dynamic rendering — xem chú thích ở từng trang.
 */
export async function getLocale(): Promise<Locale> {
  const store = await cookies();
  return resolveLocale(store.get(LOCALE_COOKIE)?.value, resolveDefaultLocale());
}

/** Từ điển của request hiện tại. */
export async function getDictionary(): Promise<Dictionary> {
  return dictionaries[await getLocale()];
}
