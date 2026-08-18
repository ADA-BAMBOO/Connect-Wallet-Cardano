"use client";

import { useEffect, useId, useRef, useState, type ReactNode, type ButtonHTMLAttributes } from "react";
import { createPortal } from "react-dom";

/*
 * Bộ primitive dùng chung.
 *
 * Mọi màu ở đây đều đi qua token ngữ nghĩa khai báo trong globals.css
 * (surface / hairline / fg / brand / leaf / warn / danger). Không viết hex hay
 * màu Tailwind mặc định trực tiếp trong component — đổi bảng màu thì chỉ sửa
 * một chỗ, và không có chỗ nào lệch tông.
 */

/* ------------------------------------------------------------------ */
/* Card                                                                */
/* ------------------------------------------------------------------ */

export function Card({
  title,
  description,
  icon,
  action,
  children,
  className = "",
}: {
  title?: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-2xl border border-hairline bg-surface/80 shadow-[0_18px_40px_-32px_rgba(0,0,0,0.9)] backdrop-blur-sm ${className}`}
    >
      {(title || action) && (
        <header className="flex items-start justify-between gap-4 border-b border-hairline px-5 py-4">
          <div className="flex items-start gap-3">
            {icon && <div className="mt-0.5 text-brand-400">{icon}</div>}
            <div>
              {title && <h2 className="font-semibold text-fg">{title}</h2>}
              {description && <p className="mt-0.5 text-sm text-fg-muted">{description}</p>}
            </div>
          </div>
          {action}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Modal — popup căn giữa màn hình                                     */
/* ------------------------------------------------------------------ */

/**
 * Modal ĐƯỢC render qua portal vào `document.body`, không render tại chỗ.
 *
 * Lý do bắt buộc: header của trang dùng `backdrop-blur`. Theo chuẩn CSS, phần tử
 * có `backdrop-filter` (hoặc `filter`, `transform`, `perspective`, `contain`) trở
 * thành *containing block* cho mọi con `position: fixed`. Nếu render tại chỗ,
 * `fixed inset-0` sẽ bám theo khung header cao ~73px thay vì viewport, khiến popup
 * bị đẩy lệch hẳn lên trên khỏi màn hình. Portal đưa nó ra ngoài body nên `fixed`
 * lại đo theo viewport như mong đợi.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  footer,
  children,
  labelledBy,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  footer?: ReactNode;
  children: ReactNode;
  labelledBy?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Đóng bằng Esc + khoá cuộn nền để không cuộn trang phía sau popup.
  useEffect(() => {
    if (!open) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // Đưa focus vào popup để người dùng bàn phím không bị bỏ lại phía sau.
    const previouslyFocused = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();

    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus?.();
    };
  }, [open, onClose]);

  // `typeof document` thay cho cờ mounted: tránh setState trong effect, đồng thời
  // vẫn an toàn nếu Modal được dùng ở nhánh có SSR (createPortal cần document).
  if (!open || typeof document === "undefined") return null;

  const titleId = labelledBy ?? "modal-title";

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto
        bg-ink-950/85 p-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        // Chỉ đóng khi bấm đúng vào nền, không đóng khi kéo chuột từ trong ra.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="my-auto flex max-h-[min(85dvh,44rem)] w-full max-w-md flex-col overflow-hidden
          rounded-2xl border border-hairline bg-surface shadow-2xl outline-none
          motion-safe:animate-[modal-in_200ms_var(--ease-brand)]"
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-hairline px-5 py-4">
          <div>
            <h2 id={titleId} className="font-semibold text-fg">
              {title}
            </h2>
            {description && <p className="mt-0.5 text-sm text-fg-muted">{description}</p>}
          </div>
          <button
            onClick={onClose}
            className="-mr-2 -mt-1 shrink-0 cursor-pointer rounded-lg p-2.5 text-fg-muted transition-colors
              duration-150 hover:bg-white/10 hover:text-fg"
            aria-label="Đóng"
          >
            <svg
              className="h-5 w-5"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              aria-hidden
            >
              <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        {/* Danh sách dài thì cuộn bên trong popup, không đẩy popup tràn màn hình. */}
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>

        {footer && <div className="shrink-0 border-t border-hairline px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------ */
/* Button                                                              */
/* ------------------------------------------------------------------ */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  loading?: boolean;
};

/*
 * Nút chính dùng nền xanh lá SÁNG với chữ nền tối, không phải xanh lá đậm với
 * chữ trắng: chữ trắng trên #1F8F3A chỉ đạt 4.1:1, dưới ngưỡng AA cho chữ
 * thường. Chữ tối trên #A3C644 đạt 8.5:1 — vẫn đúng bộ nhận diện mà đọc được.
 */
const VARIANTS: Record<NonNullable<ButtonProps["variant"]>, string> = {
  primary:
    "bg-leaf-500 text-ink-950 hover:bg-leaf-400 active:bg-leaf-600 " +
    "shadow-[0_8px_24px_-14px_var(--color-leaf-500)]",
  secondary:
    "bg-surface-2 text-fg border border-hairline hover:bg-ink-800 hover:border-hairline-strong",
  ghost: "text-fg-muted hover:text-fg hover:bg-white/[0.06]",
  danger: "bg-danger-500 text-white hover:bg-danger-600",
};

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  disabled,
  children,
  className = "",
  ...props
}: ButtonProps) {
  // Chiều cao tối thiểu là vùng chạm, không phải kích thước chữ: 44px cho nút
  // chính, 40px cho nút phụ nằm trong khối dày.
  const sizing = size === "sm" ? "min-h-10 px-3.5 py-2 text-sm" : "min-h-11 px-4 py-2.5 text-sm";

  return (
    <button
      {...props}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl font-medium
        transition-[background-color,border-color,color,transform] duration-150 ease-out
        motion-safe:active:scale-[0.98]
        disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-45
        ${VARIANTS[variant]} ${sizing} ${className}`}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <svg className={`h-4 w-4 animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
      <path
        d="M12 2a10 10 0 0 1 10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Badge                                                               */
/* ------------------------------------------------------------------ */

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "success" | "warning" | "danger" | "info";
}) {
  const tones = {
    neutral: "bg-white/[0.06] text-fg-muted border-hairline",
    success: "bg-brand-500/15 text-brand-300 border-brand-500/35",
    warning: "bg-warn-500/15 text-warn-400 border-warn-500/35",
    danger: "bg-danger-500/15 text-danger-400 border-danger-500/35",
    info: "bg-leaf-500/12 text-leaf-300 border-leaf-500/30",
  } as const;

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* CopyableField — hiển thị giá trị dài kèm nút copy                   */
/* ------------------------------------------------------------------ */

export function CopyableField({
  label,
  value,
  display,
  href,
}: {
  label: string;
  value: string;
  display?: string;
  href?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard API cần HTTPS hoặc localhost — bỏ qua nếu bị chặn.
    }
  }

  return (
    <div className="min-w-0">
      <div className="text-xs font-medium uppercase tracking-wide text-fg-subtle">{label}</div>
      <div className="mt-1 flex items-center gap-2">
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="truncate font-mono text-sm text-brand-300 underline-offset-4 hover:underline"
            title={value}
          >
            {display ?? value}
          </a>
        ) : (
          <span className="truncate font-mono text-sm text-fg" title={value}>
            {display ?? value}
          </span>
        )}
        <button
          onClick={copy}
          className="shrink-0 cursor-pointer rounded-md p-2 text-fg-subtle transition-colors duration-150
            hover:bg-white/10 hover:text-fg"
          aria-label={`Sao chép ${label}`}
        >
          {copied ? (
            <svg className="h-4 w-4 text-brand-400" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
              <path
                fillRule="evenodd"
                d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0L3.3 9.7a1 1 0 1 1 1.4-1.4l3.8 3.8 6.8-6.8a1 1 0 0 1 1.4 0Z"
                clipRule="evenodd"
              />
            </svg>
          ) : (
            <svg
              className="h-4 w-4"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              aria-hidden
            >
              <rect x="7" y="7" width="9" height="9" rx="2" />
              <path d="M13 4.5A1.5 1.5 0 0 0 11.5 3h-6A2.5 2.5 0 0 0 3 5.5v6A1.5 1.5 0 0 0 4.5 13" />
            </svg>
          )}
        </button>
        {/* Xác nhận copy phải đọc được bằng screen reader, không chỉ đổi icon. */}
        <span aria-live="polite" className="sr-only">
          {copied ? `Đã sao chép ${label}` : ""}
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Alert                                                               */
/* ------------------------------------------------------------------ */

/*
 * Mỗi tone có icon riêng. Màu KHÔNG được là tín hiệu duy nhất — người mù màu
 * và người đọc bằng screen reader vẫn phải phân biệt được cảnh báo với xác nhận.
 */
const ALERT_ICONS = {
  danger:
    "M12 8v5M12 16.5v.01M10.3 3.9 2.6 17.1A2 2 0 0 0 4.3 20h15.4a2 2 0 0 0 1.7-2.9L13.7 3.9a2 2 0 0 0-3.4 0Z",
  warning:
    "M12 8v5M12 16.5v.01M10.3 3.9 2.6 17.1A2 2 0 0 0 4.3 20h15.4a2 2 0 0 0 1.7-2.9L13.7 3.9a2 2 0 0 0-3.4 0Z",
  success: "m8 12.5 2.8 2.8L16.5 9.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  info: "M12 11v5.5M12 7.5v.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
} as const;

export function Alert({
  tone = "danger",
  children,
}: {
  tone?: "danger" | "success" | "warning" | "info";
  children: ReactNode;
}) {
  const tones = {
    danger: "border-danger-500/35 bg-danger-500/10 text-danger-400",
    success: "border-brand-500/35 bg-brand-500/10 text-brand-200",
    warning: "border-warn-500/35 bg-warn-500/10 text-warn-400",
    info: "border-leaf-500/30 bg-leaf-500/[0.08] text-leaf-200",
  } as const;

  return (
    <div
      role={tone === "danger" ? "alert" : undefined}
      className={`flex gap-3 rounded-xl border px-3.5 py-3 text-sm ${tones[tone]}`}
    >
      <svg
        className="mt-0.5 h-4 w-4 shrink-0"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d={ALERT_ICONS[tone]} />
      </svg>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Input                                                               */
/* ------------------------------------------------------------------ */

export function Field({
  label,
  hint,
  error,
  required,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: ReactNode;
}) {
  const messageId = useId();

  return (
    <label className="block">
      <span className="text-sm font-medium text-fg">
        {label}
        {required && (
          <span className="ml-1 text-danger-400" aria-label="bắt buộc">
            *
          </span>
        )}
      </span>
      {children}
      {error ? (
        // role="alert" để screen reader đọc lỗi ngay khi nó xuất hiện.
        <span
          id={messageId}
          role="alert"
          className="mt-1.5 flex items-center gap-1.5 text-xs text-danger-400"
        >
          <svg
            className="h-3.5 w-3.5 shrink-0"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7.5v5M12 16v.01" strokeLinecap="round" />
          </svg>
          {error}
        </span>
      ) : hint ? (
        <span id={messageId} className="mt-1.5 block text-xs text-fg-subtle">
          {hint}
        </span>
      ) : null}
    </label>
  );
}

export const inputClass =
  "mt-1.5 min-h-11 w-full rounded-xl border border-hairline bg-ink-950/60 px-3.5 py-2.5 font-mono text-sm " +
  "text-fg placeholder:text-fg-subtle/70 transition-colors duration-150 " +
  "hover:border-hairline-strong focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/35 " +
  "disabled:cursor-not-allowed disabled:opacity-50";
