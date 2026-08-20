import { notFound } from "next/navigation";

import { PayAppLoader } from "@/components/PayAppLoader";
import { getOrderView } from "@/lib/order-view";
import { isValidRef } from "@/lib/ref";
import { getDictionary } from "@/lib/i18n/server";

/**
 * Trang thanh toán — nơi link và mã QR trỏ tới.
 *
 * Đơn hàng được nạp NGAY Ở SERVER rồi truyền xuống làm props, thay vì để client
 * fetch sau khi mount. Hai cái lợi:
 *
 *   1. Không nhấp nháy spinner — người trả tiền thấy số tiền ngay lập tức.
 *   2. Client chỉ còn setState từ callback của interval, đúng kiểu "đăng ký nhận
 *      cập nhật từ hệ thống ngoài" mà React 19 mong đợi. Fetch-rồi-setState ngay
 *      trong effect sinh ra render dây chuyền và bị eslint chặn.
 *
 * Phần ký vẫn phải ở client vì cần `window.cardano`.
 *
 * Next 16: `params` là một Promise, phải await.
 */

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params;
  const t = await getDictionary();

  return {
    title: t.meta.payTitle(ref),
    description: t.meta.payDescription,
    // Trang thanh toán không nên nằm trong kết quả tìm kiếm.
    robots: { index: false, follow: false },
  };
}

export default async function PayPage({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params;

  // Chặn mã sai định dạng ngay ở server: không cần tải cả bundle ví chỉ để báo lỗi.
  if (!isValidRef(ref)) notFound();

  const view = await getOrderView(ref);
  if (!view) notFound();

  // Nền trang trí nằm ở root layout (components/Ambient).
  return <PayAppLoader orderRef={ref} initial={view} />;
}
