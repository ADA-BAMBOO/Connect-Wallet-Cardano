/**
 * Nền trang trí dùng chung cho mọi trang.
 *
 * Trước đây mỗi page tự khai báo một `radial-gradient` riêng, nên đổi tông là
 * phải sửa ba chỗ và rất dễ để sót một trang lệch màu. Giờ nó nằm ở root layout.
 *
 * Hai vệt sáng chuyển động rất chậm (18–26s) và chỉ dùng `transform`, nên không
 * gây reflow. `motion-safe:` giữ chúng đứng yên khi người dùng bật giảm chuyển
 * động — nền không được phép là thứ khiến ai đó chóng mặt.
 */
export function Ambient() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-canvas">
      {/* Quầng xanh lá chủ đạo, toả từ mép trên — hướng mắt vào phần đầu trang */}
      <div
        className="absolute -top-[28rem] left-1/2 h-[46rem] w-[80rem] -translate-x-1/2 rounded-full
          bg-[radial-gradient(closest-side,var(--color-brand-500),transparent)] opacity-[0.18] blur-3xl
          motion-safe:animate-[ambient-drift_24s_ease-in-out_infinite]"
      />
      {/* Quầng lá sáng ở góc, lệch nhịp để hai vệt không đập cùng lúc */}
      <div
        className="absolute -bottom-[22rem] -right-[16rem] h-[38rem] w-[38rem] rounded-full
          bg-[radial-gradient(closest-side,var(--color-leaf-500),transparent)] opacity-[0.10] blur-3xl
          motion-safe:animate-[ambient-drift_30s_ease-in-out_infinite_reverse]"
      />
      {/* Lưới rất mờ, đủ để nền có kết cấu mà không cạnh tranh với nội dung */}
      <div
        className="absolute inset-0 opacity-[0.35]
          bg-[linear-gradient(var(--color-hairline)_1px,transparent_1px),linear-gradient(90deg,var(--color-hairline)_1px,transparent_1px)]
          bg-[size:64px_64px]
          [mask-image:radial-gradient(ellipse_70%_50%_at_50%_0%,black,transparent)]"
      />
    </div>
  );
}
