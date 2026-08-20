"use client";

import dynamic from "next/dynamic";
import { Spinner } from "./ui";
import { useDict } from "@/lib/i18n/client";

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
  loading: () => <Loading />,
});

/**
 * Tách thành component riêng chứ không viết thẳng JSX vào `loading`: hook chỉ gọi
 * được trong thân một component, mà chuỗi ở đây phải lấy từ từ điển.
 */
function Loading() {
  const t = useDict();

  return (
    <div className="flex flex-1 items-center justify-center py-32">
      <div className="flex items-center gap-3 text-fg-muted">
        <Spinner className="text-brand-400" />
        <span className="text-sm">{t.shell.loadingWallet}</span>
      </div>
    </div>
  );
}

export function WalletAppLoader() {
  return <WalletApp />;
}
