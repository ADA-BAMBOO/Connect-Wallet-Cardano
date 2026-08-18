"use client";

import dynamic from "next/dynamic";
import type { ComponentProps } from "react";
import { Spinner } from "./ui";

/**
 * Nạp trang thanh toán với `ssr: false`, cùng lý do như WalletAppLoader: Mesh SDK
 * kéo theo WebAssembly và `window.cardano` chỉ tồn tại trên trình duyệt.
 *
 * `ssr: false` chỉ được phép dùng trong Client Component ở App Router — đó là lý do
 * file này tồn tại thay vì gọi thẳng trong page.tsx.
 */
const PayApp = dynamic(() => import("./PayApp"), {
  ssr: false,
  loading: () => (
    <div className="flex flex-1 items-center justify-center py-32">
      <div className="flex items-center gap-3 text-fg-muted">
        <Spinner className="text-brand-400" />
        <span className="text-sm">Đang tải trang thanh toán…</span>
      </div>
    </div>
  ),
});

export function PayAppLoader({
  orderRef,
  initial,
}: {
  orderRef: string;
  initial: ComponentProps<typeof PayApp>["initial"];
}) {
  return <PayApp orderRef={orderRef} initial={initial} />;
}
