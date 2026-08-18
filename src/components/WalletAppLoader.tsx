"use client";

import dynamic from "next/dynamic";
import { Spinner } from "./ui";

/**
 * Mesh SDK và `window.cardano` chỉ tồn tại trên trình duyệt, nên toàn bộ app ví
 * được nạp với `ssr: false`. Cách này tránh lỗi hydration mismatch và giữ WASM
 * ra khỏi quá trình render phía server.
 *
 * `ssr: false` chỉ được phép dùng trong Client Component ở App Router — đó là
 * lý do file này tồn tại thay vì gọi thẳng trong page.tsx.
 */
const WalletApp = dynamic(() => import("./WalletApp"), {
  ssr: false,
  loading: () => (
    <div className="flex flex-1 items-center justify-center py-32">
      <div className="flex items-center gap-3 text-fg-muted">
        <Spinner className="text-brand-400" />
        <span className="text-sm">Đang khởi tạo kết nối ví…</span>
      </div>
    </div>
  ),
});

export function WalletAppLoader() {
  return <WalletApp />;
}
