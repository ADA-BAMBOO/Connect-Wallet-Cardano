"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { useDict } from "@/lib/i18n/client";

/**
 * Tự tải lại dữ liệu server component của trang sổ đơn hàng.
 *
 * `router.refresh()` chỉ lấy lại payload từ server rồi ghép vào cây React hiện tại —
 * không tải lại cả trang, nên không mất vị trí cuộn và không nháy màn hình.
 *
 * setState nằm trong callback của interval chứ không nằm trong thân effect: đó là
 * kiểu "đăng ký nhận cập nhật từ hệ thống ngoài" mà React 19 mong đợi.
 */
export function OrdersRefresher({ seconds = 10 }: { seconds?: number }) {
  const router = useRouter();
  const t = useDict();
  const [lastAt, setLastAt] = useState<number | null>(null);

  useEffect(() => {
    const timer = setInterval(() => {
      router.refresh();
      setLastAt(Date.now());
    }, seconds * 1_000);

    return () => clearInterval(timer);
  }, [router, seconds]);

  return (
    <span className="text-xs text-fg-subtle">
      {t.orders.autoRefresh(seconds)}
      {lastAt && t.orders.lastRefresh(new Date(lastAt).toLocaleTimeString(t.dateLocale))}
    </span>
  );
}
