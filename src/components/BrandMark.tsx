/**
 * Dấu hiệu nhận diện của Kolo Pay — chữ K dựng bằng ba nét, không dùng <text>
 * để không phụ thuộc vào việc webfont đã tải xong hay chưa.
 *
 * Kolo (bboapp.xyz) nhận diện bằng chữ, không có biểu tượng riêng; ô monogram ở
 * đây là phần mở rộng cho ngữ cảnh cần một hình vuông nhỏ (header, favicon) —
 * vẫn đúng hai màu xanh của bộ nhận diện.
 *
 * Không có "use client": component thuần trình bày, dùng được ở cả server
 * component (trang sổ đơn hàng) lẫn client component (vỏ ví, trang thanh toán).
 */
export function BrandMark({ className = "h-9 w-9" }: { className?: string }) {
  return (
    <div
      className={`flex shrink-0 items-center justify-center rounded-xl border border-leaf-500/25
        bg-gradient-to-br from-brand-500 to-brand-700
        shadow-[0_6px_18px_-10px_var(--color-brand-500)] ${className}`}
    >
      <svg
        className="h-[55%] w-[55%] text-leaf-200"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M8.4 4.8v14.4" />
        <path d="M17 5.4 9.6 12.6" />
        <path d="m12.2 10.1 5.2 8.5" />
      </svg>
    </div>
  );
}
