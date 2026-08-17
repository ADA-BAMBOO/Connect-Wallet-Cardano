"use client";

import { useEffect, useRef, useState, type ReactNode, type ButtonHTMLAttributes } from "react";
import { createPortal } from "react-dom";

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
      className={`rounded-2xl border border-white/10 bg-white/[0.03] backdrop-blur-sm ${className}`}
    >
      {(title || action) && (
        <header className="flex items-start justify-between gap-4 border-b border-white/10 px-5 py-4">
          <div className="flex items-start gap-3">
            {icon && <div className="mt-0.5 text-sky-400">{icon}</div>}
            <div>
              {title && <h2 className="font-semibold text-white">{title}</h2>}
              {description && <p className="mt-0.5 text-sm text-slate-400">{description}</p>}
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
        bg-black/70 p-4 backdrop-blur-sm"
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
        className="my-auto flex max-h-[min(85vh,44rem)] w-full max-w-md flex-col overflow-hidden
          rounded-2xl border border-white/10 bg-slate-900 shadow-2xl outline-none
          motion-safe:animate-[modal-in_160ms_ease-out]"
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-white/10 px-5 py-4">
          <div>
            <h2 id={titleId} className="font-semibold text-white">
              {title}
            </h2>
            {description && <p className="mt-0.5 text-sm text-slate-400">{description}</p>}
          </div>
          <button
            onClick={onClose}
            className="-mr-1 shrink-0 rounded-lg p-2 text-slate-400 transition hover:bg-white/10 hover:text-white"
            aria-label="Đóng"
          >
            <svg
              className="h-5 w-5"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
            >
              <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        {/* Danh sách dài thì cuộn bên trong popup, không đẩy popup tràn màn hình. */}
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>

        {footer && <div className="shrink-0 border-t border-white/10 px-5 py-3">{footer}</div>}
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

const VARIANTS: Record<NonNullable<ButtonProps["variant"]>, string> = {
  primary: "bg-sky-500 text-white hover:bg-sky-400 focus-visible:outline-sky-400",
  secondary:
    "bg-white/10 text-white hover:bg-white/[0.15] border border-white/10 focus-visible:outline-white/40",
  ghost: "text-slate-300 hover:text-white hover:bg-white/5 focus-visible:outline-white/30",
  danger: "bg-rose-500/90 text-white hover:bg-rose-500 focus-visible:outline-rose-400",
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
  const sizing = size === "sm" ? "px-3 py-1.5 text-sm" : "px-4 py-2.5 text-sm";

  return (
    <button
      {...props}
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center gap-2 rounded-lg font-medium transition
        focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2
        disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${sizing} ${className}`}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <svg className={`h-4 w-4 animate-spin ${className}`} viewBox="0 0 24 24" fill="none">
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
    neutral: "bg-white/10 text-slate-300 border-white/10",
    success: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
    warning: "bg-amber-500/15 text-amber-300 border-amber-500/30",
    danger: "bg-rose-500/15 text-rose-300 border-rose-500/30",
    info: "bg-sky-500/15 text-sky-300 border-sky-500/30",
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
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 flex items-center gap-2">
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="truncate font-mono text-sm text-sky-300 underline-offset-4 hover:underline"
            title={value}
          >
            {display ?? value}
          </a>
        ) : (
          <span className="truncate font-mono text-sm text-slate-200" title={value}>
            {display ?? value}
          </span>
        )}
        <button
          onClick={copy}
          className="shrink-0 rounded-md p-1.5 text-slate-500 transition hover:bg-white/10 hover:text-white"
          aria-label={`Sao chép ${label}`}
        >
          {copied ? (
            <svg className="h-4 w-4 text-emerald-400" viewBox="0 0 20 20" fill="currentColor">
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
            >
              <rect x="7" y="7" width="9" height="9" rx="2" />
              <path d="M13 4.5A1.5 1.5 0 0 0 11.5 3h-6A2.5 2.5 0 0 0 3 5.5v6A1.5 1.5 0 0 0 4.5 13" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Alert                                                               */
/* ------------------------------------------------------------------ */

export function Alert({
  tone = "danger",
  children,
}: {
  tone?: "danger" | "success" | "warning" | "info";
  children: ReactNode;
}) {
  const tones = {
    danger: "border-rose-500/30 bg-rose-500/10 text-rose-200",
    success: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
    warning: "border-amber-500/30 bg-amber-500/10 text-amber-200",
    info: "border-sky-500/30 bg-sky-500/10 text-sky-200",
  } as const;

  return <div className={`rounded-lg border px-3.5 py-3 text-sm ${tones[tone]}`}>{children}</div>;
}

/* ------------------------------------------------------------------ */
/* Input                                                               */
/* ------------------------------------------------------------------ */

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-slate-300">{label}</span>
      {children}
      {error ? (
        <span className="mt-1.5 block text-xs text-rose-300">{error}</span>
      ) : hint ? (
        <span className="mt-1.5 block text-xs text-slate-500">{hint}</span>
      ) : null}
    </label>
  );
}

export const inputClass =
  "mt-1.5 w-full rounded-lg border border-white/10 bg-black/30 px-3.5 py-2.5 font-mono text-sm " +
  "text-slate-100 placeholder:text-slate-600 focus:border-sky-500/60 focus:outline-none " +
  "focus:ring-1 focus:ring-sky-500/40";
