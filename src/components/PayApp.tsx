"use client";

import { MeshProvider } from "@meshsdk/react";
import Link from "next/link";

import { PayOrderCard, type OrderView } from "./PayOrderCard";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { useDict } from "@/lib/i18n/client";

/**
 * Vỏ của trang thanh toán.
 *
 * Có MeshProvider riêng chứ không dùng chung với WalletApp: đây là một trang độc
 * lập, người trả tiền đến thẳng đây qua link hoặc QR mà không đi qua trang chủ.
 *
 * File được nạp động với `ssr: false` — `window.cardano` chỉ tồn tại trên trình
 * duyệt, và Mesh SDK kéo theo WebAssembly.
 */
export default function PayApp({ orderRef, initial }: { orderRef: string; initial: OrderView }) {
  const t = useDict();

  return (
    <MeshProvider>
      <header className="border-b border-hairline bg-canvas/70 backdrop-blur-xl">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-3 px-6 py-3.5">
          <Link
            href="/"
            className="flex min-h-11 items-center gap-3 rounded-lg pr-2 text-fg-muted
              transition-colors duration-150 hover:text-fg"
          >
            <div
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-leaf-500/25
                bg-gradient-to-br from-brand-500 to-brand-700"
            >
              <svg className="h-4 w-4 text-leaf-200" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <circle cx="12" cy="12" r="2.6" />
                <circle cx="12" cy="4.4" r="1.5" />
                <circle cx="12" cy="19.6" r="1.5" />
                <circle cx="5.4" cy="8.2" r="1.5" />
                <circle cx="18.6" cy="8.2" r="1.5" />
                <circle cx="5.4" cy="15.8" r="1.5" />
                <circle cx="18.6" cy="15.8" r="1.5" />
              </svg>
            </div>
            <span className="text-sm font-medium">{t.shell.brand}</span>
          </Link>
          <LanguageSwitcher />
        </div>
      </header>

      <main id="main" className="mx-auto w-full max-w-2xl flex-1 px-6 py-8 sm:py-10">
        <PayOrderCard orderRef={orderRef} initial={initial} />
      </main>
    </MeshProvider>
  );
}
