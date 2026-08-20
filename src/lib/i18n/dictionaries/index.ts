import { vi } from "@/lib/i18n/dictionaries/vi";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Locale } from "@/lib/i18n/locales";

/**
 * `vi` là bản gốc: kiểu `Dictionary` sinh ra từ nó, nên thêm một chuỗi vào `vi` mà
 * quên `en` là lỗi biên dịch chứ không phải một ô trống lặng lẽ hiện ra lúc chạy.
 *
 * `Localized` giữ nguyên chữ ký của hàm (chuỗi có nội suy tham số) và nới mọi
 * chuỗi literal thành `string`, để bản dịch không bị buộc phải trùng từng chữ.
 */
export type Localized<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => string
    ? (...args: A) => string
    : T[K] extends string
      ? string
      : Localized<T[K]>;
};

export type Dictionary = Localized<typeof vi>;

export const dictionaries: Record<Locale, Dictionary> = { vi, en };
