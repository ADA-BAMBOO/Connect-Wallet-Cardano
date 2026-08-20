"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { useDict, useLocale } from "@/lib/i18n/client";
import { LOCALES, LOCALE_COOKIE, LOCALE_MAX_AGE, LOCALE_LABELS, LOCALE_SHORT } from "@/lib/i18n/locales";
import type { Locale } from "@/lib/i18n/locales";

/**
 * Nút đổi ngôn ngữ.
 *
 * Ghi cookie ngay từ client rồi `router.refresh()`: refresh lấy lại payload của
 * server component với cookie mới, nên trang server (sổ đơn hàng, metadata) và
 * trang client (các thẻ ví) đổi ngôn ngữ trong cùng một lượt render.
 *
 * KHÔNG dùng `window.location.reload()`: reload làm mất kết nối ví — MeshProvider
 * phải enable lại từ đầu, và đó chính là chùm lời gọi CIP-30 mà `use-wallet-data.ts`
 * sinh ra để tránh. Đổi ngôn ngữ không được phép ngắt ví của người dùng.
 *
 * Cookie đặt từ client nên không thể httpOnly — chấp nhận được, ngôn ngữ hiển thị
 * không phải bí mật và không cấp quyền gì.
 */

/**
 * Nằm ngoài thân component: `react-hooks/immutability` chặn việc gán vào giá trị
 * bên ngoài ngay trong thân một component, và đây đúng là một side effect của DOM.
 */
function rememberLocale(locale: Locale) {
  document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=${LOCALE_MAX_AGE}; samesite=lax`;
}

export function LanguageSwitcher() {
  const router = useRouter();
  const current = useLocale();
  const t = useDict();
  const [pending, startTransition] = useTransition();

  function choose(locale: Locale) {
    if (locale === current) return;

    rememberLocale(locale);
    startTransition(() => router.refresh());
  }

  return (
    <div
      role="group"
      aria-label={t.a11y.switchLanguage}
      // min-h-10 giữ vùng chạm đủ lớn trên điện thoại, đồng bộ với các nút khác ở header.
      className={`flex min-h-10 items-center gap-0.5 rounded-lg border border-hairline bg-surface-2 p-0.5
        ${pending ? "opacity-60" : ""}`}
    >
      {LOCALES.map((locale) => {
        const active = locale === current;
        return (
          <button
            key={locale}
            type="button"
            onClick={() => choose(locale)}
            disabled={pending}
            // aria-pressed thay vì chỉ đổi màu: người dùng screen reader cũng phải
            // biết ngôn ngữ nào đang bật.
            aria-pressed={active}
            // lang= để trình đọc màn hình phát âm tên ngôn ngữ bằng đúng thứ tiếng đó.
            lang={locale}
            title={LOCALE_LABELS[locale]}
            className={`cursor-pointer rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors duration-150
              disabled:cursor-not-allowed
              ${
                active
                  ? "bg-brand-500/20 text-brand-200"
                  : "text-fg-subtle hover:bg-white/[0.06] hover:text-fg"
              }`}
          >
            {LOCALE_SHORT[locale]}
            <span className="sr-only"> — {LOCALE_LABELS[locale]}</span>
          </button>
        );
      })}
    </div>
  );
}
