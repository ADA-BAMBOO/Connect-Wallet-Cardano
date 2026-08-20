"use client";

import Link from "next/link";
import { MeshProvider, useWallet, useWalletList } from "@meshsdk/react";
import { ConnectWallet } from "./ConnectWallet";
import { AccountCard } from "./AccountCard";
import { AssetsCard } from "./AssetsCard";
import { SignInCard } from "./SignInCard";
import { SendAdaCard } from "./SendAdaCard";
import { CreateOrderCard } from "./CreateOrderCard";
import { FaucetCard } from "./FaucetCard";
import { WalletDiagnostics } from "./WalletDiagnostics";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { useDict } from "@/lib/i18n/client";

/**
 * Toàn bộ phần phụ thuộc vào ví nằm trong file này.
 * File được nạp động với `ssr: false` nên MeshProvider và `window.cardano`
 * chỉ tồn tại ở client — không bao giờ chạy khi Next render trên server.
 */
export default function WalletApp() {
  return (
    <MeshProvider>
      <Shell />
    </MeshProvider>
  );
}

function Shell() {
  const { connected } = useWallet();
  const t = useDict();

  return (
    <>
      <header className="sticky top-0 z-40 border-b border-hairline bg-canvas/70 backdrop-blur-xl">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-3.5">
          <div className="flex min-w-0 items-center gap-3">
            <CardanoMark />
            <div className="min-w-0 leading-tight">
              <div className="truncate font-semibold text-fg">{t.shell.brand}</div>
              <div className="truncate text-xs text-fg-subtle">{t.shell.tagline}</div>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-3">
            {/*
              Sổ đơn hàng trước đây không có lối vào nào từ giao diện — muốn tới
              phải tự gõ URL. Điều hướng chính phải luôn với tới được.
            */}
            <Link
              href="/orders"
              className="hidden min-h-10 items-center rounded-lg px-3 text-sm font-medium text-fg-muted
                transition-colors duration-150 hover:bg-white/[0.06] hover:text-fg sm:inline-flex"
            >
              {t.shell.orderBook}
            </Link>
            <LanguageSwitcher />
            <ConnectWallet />
          </div>
        </div>
      </header>

      <main id="main" className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">
        {connected ? (
          <div className="space-y-6">
            <AccountCard />
            <div className="grid gap-6 lg:grid-cols-2">
              <SignInCard />
              <SendAdaCard />
            </div>
            <FaucetCard />
            <CreateOrderCard />
            <AssetsCard />
            <WalletDiagnostics />
          </div>
        ) : (
          <Welcome />
        )}
      </main>
    </>
  );
}

function Welcome() {
  const wallets = useWalletList();
  const t = useDict();

  return (
    <div className="py-8 sm:py-12">
      <div className="max-w-2xl">
        <span
          className="inline-flex items-center gap-2 rounded-full border border-brand-500/35 bg-brand-500/10
            px-3 py-1 text-xs font-medium text-brand-300"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-brand-400" />
          {t.welcome.badge}
        </span>

        <h1 className="mt-5 text-4xl font-semibold tracking-tight text-balance text-fg sm:text-5xl">
          {t.welcome.headline}
          <span className="text-leaf-500">.</span>
        </h1>
        {/* max-w giữ dòng ở khoảng 65–75 ký tự, đọc dễ hơn hẳn dòng dài hết khung */}
        <p className="mt-4 max-w-[60ch] text-lg leading-relaxed text-fg-muted">
          {t.welcome.intro}
        </p>

        <div className="mt-8">
          <ConnectWallet />
          <p className="mt-3 flex items-center gap-2 text-sm text-fg-subtle">
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                wallets.length > 0 ? "bg-brand-400" : "bg-fg-subtle"
              }`}
            />
            {wallets.length > 0
              ? t.welcome.walletsDetected(wallets.length, wallets.map((w) => w.name).join(", "))
              : t.welcome.noWallets}
          </p>
        </div>
      </div>

      <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Feature
          icon={<PlugIcon />}
          title={t.welcome.detectTitle}
          body={t.welcome.detectBody}
        />
        <Feature
          icon={<CoinsIcon />}
          title={t.welcome.balanceTitle}
          body={t.welcome.balanceBody}
        />
        <Feature
          icon={<ShieldIcon />}
          title={t.welcome.loginTitle}
          body={t.welcome.loginBody}
        />
        <Feature
          icon={<PaperPlaneIcon />}
          title={t.welcome.sendTitle}
          body={t.welcome.sendBody}
        />
      </div>

      <div className="mt-12 overflow-hidden rounded-2xl border border-hairline bg-surface/80 p-6 backdrop-blur-sm">
        <h2 className="font-semibold text-fg">{t.welcome.howTitle}</h2>
        <p className="mt-2 max-w-[72ch] text-sm leading-relaxed text-fg-muted">
          {t.welcome.howBody1}{" "}
          <code className="rounded bg-ink-950/60 px-1.5 py-0.5 font-mono text-brand-300">
            window.cardano
          </code>
          {t.welcome.howBody2}{" "}
          <code className="rounded bg-ink-950/60 px-1.5 py-0.5 font-mono text-brand-300">
            enable()
          </code>
          {t.welcome.howBody3}
        </p>
      </div>
    </div>
  );
}

function Feature({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div
      className="group rounded-2xl border border-hairline bg-surface/70 p-4 transition-colors duration-200
        hover:border-hairline-strong hover:bg-surface-2/70"
    >
      <div
        className="flex h-9 w-9 items-center justify-center rounded-lg border border-brand-500/25
          bg-brand-500/10 text-brand-300 transition-colors duration-200 group-hover:text-leaf-400"
      >
        {icon}
      </div>
      <div className="mt-3 text-sm font-semibold text-fg">{title}</div>
      <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">{body}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Icon — cùng một họ: stroke 1.7, đầu nét bo tròn, khung 24            */
/* ------------------------------------------------------------------ */

function Glyph({ children }: { children: React.ReactNode }) {
  return (
    <svg
      className="h-[18px] w-[18px]"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

function PlugIcon() {
  return (
    <Glyph>
      <path d="M9 3v6M15 3v6" />
      <path d="M6 9h12v3a6 6 0 0 1-6 6 6 6 0 0 1-6-6V9Z" />
      <path d="M12 18v3" />
    </Glyph>
  );
}

function CoinsIcon() {
  return (
    <Glyph>
      <ellipse cx="12" cy="6.5" rx="7" ry="3.2" />
      <path d="M5 6.5v5c0 1.8 3.1 3.2 7 3.2s7-1.4 7-3.2v-5" />
      <path d="M5 11.5v5c0 1.8 3.1 3.2 7 3.2s7-1.4 7-3.2v-5" />
    </Glyph>
  );
}

function ShieldIcon() {
  return (
    <Glyph>
      <path d="M12 3 5 6v5.5c0 4.2 2.9 7.6 7 9.5 4.1-1.9 7-5.3 7-9.5V6l-7-3Z" />
      <path d="m9.2 12 2 2 3.6-3.6" />
    </Glyph>
  );
}

function PaperPlaneIcon() {
  return (
    <Glyph>
      <path d="M21.5 2.5 11 13" />
      <path d="M21.5 2.5 15 21l-4-8-8-4 18.5-6.5Z" />
    </Glyph>
  );
}

function CardanoMark() {
  return (
    <div
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-leaf-500/25
        bg-gradient-to-br from-brand-500 to-brand-700
        shadow-[0_6px_18px_-10px_var(--color-brand-500)]"
    >
      <svg className="h-5 w-5 text-leaf-200" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <circle cx="12" cy="12" r="2.6" />
        <circle cx="12" cy="4.4" r="1.5" />
        <circle cx="12" cy="19.6" r="1.5" />
        <circle cx="5.4" cy="8.2" r="1.5" />
        <circle cx="18.6" cy="8.2" r="1.5" />
        <circle cx="5.4" cy="15.8" r="1.5" />
        <circle cx="18.6" cy="15.8" r="1.5" />
      </svg>
    </div>
  );
}
