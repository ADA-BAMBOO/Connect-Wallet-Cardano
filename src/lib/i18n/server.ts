import "server-only";

import { cookies } from "next/headers";

import { dictionaries, type Dictionary } from "@/lib/i18n/dictionaries";
import { LOCALE_COOKIE, resolveLocale, type Locale } from "@/lib/i18n/locales";

/**
 * Ngôn ngữ của request hiện tại, đọc từ cookie.
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
  return resolveLocale(store.get(LOCALE_COOKIE)?.value);
}

/** Từ điển của request hiện tại. */
export async function getDictionary(): Promise<Dictionary> {
  return dictionaries[await getLocale()];
}
