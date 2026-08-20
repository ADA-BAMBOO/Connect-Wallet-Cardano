"use client";

import { createContext, useContext } from "react";

import { dictionaries, type Dictionary } from "@/lib/i18n/dictionaries";
import { DEFAULT_LOCALE, type Locale } from "@/lib/i18n/locales";

/**
 * Ngôn ngữ cho phía client.
 *
 * Context chỉ mang CHUỖI locale, không mang cả từ điển. Từ điển có chứa hàm (để nội
 * suy tham số kiểu `walletsFound(3)`), mà hàm thì không serialize qua ranh giới
 * server → client được — truyền cả từ điển xuống sẽ vỡ ngay lúc render.
 *
 * Đổi lại, client bundle chứa cả hai ngôn ngữ. Với hai thứ tiếng của một app demo
 * thì đây là cái giá rẻ hơn nhiều so với việc bẻ từ điển thành dạng serialize được.
 */
const LocaleContext = createContext<Locale>(DEFAULT_LOCALE);

export function LocaleProvider({
  locale,
  children,
}: {
  locale: Locale;
  children: React.ReactNode;
}) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function useLocale(): Locale {
  return useContext(LocaleContext);
}

/** Từ điển đang dùng. Đặt tên `t` cho gọn ở chỗ gọi: `const t = useDict();` */
export function useDict(): Dictionary {
  return dictionaries[useLocale()];
}
