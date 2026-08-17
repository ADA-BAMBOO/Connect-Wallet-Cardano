"use client";

import { MeshProvider, useWallet, useWalletList } from "@meshsdk/react";
import { ConnectWallet } from "./ConnectWallet";
import { AccountCard } from "./AccountCard";
import { AssetsCard } from "./AssetsCard";
import { SignInCard } from "./SignInCard";
import { SendAdaCard } from "./SendAdaCard";
import { WalletDiagnostics } from "./WalletDiagnostics";

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

  return (
    <>
      <header className="sticky top-0 z-40 border-b border-white/10 bg-slate-950/80 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-4">
          <div className="flex items-center gap-3">
            <CardanoMark />
            <div className="leading-tight">
              <div className="font-semibold text-white">Cardano Connect</div>
              <div className="text-xs text-slate-500">Demo kết nối ví CIP-30</div>
            </div>
          </div>
          <ConnectWallet />
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">
        {connected ? (
          <div className="space-y-5">
            <AccountCard />
            <div className="grid gap-5 lg:grid-cols-2">
              <SignInCard />
              <SendAdaCard />
            </div>
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

  return (
    <div className="py-10">
      <div className="max-w-2xl">
        <h1 className="text-4xl font-semibold tracking-tight text-white sm:text-5xl">
          Kết nối ví Cardano<span className="text-sky-400">.</span>
        </h1>
        <p className="mt-4 text-lg leading-relaxed text-slate-400">
          Dự án mẫu đầy đủ: phát hiện ví, đọc số dư và tài sản, đăng nhập bằng chữ ký, và gửi giao
          dịch ADA — xây trên chuẩn CIP-30 với Mesh SDK.
        </p>

        <div className="mt-8">
          <ConnectWallet />
          <p className="mt-3 text-sm text-slate-500">
            {wallets.length > 0
              ? `Phát hiện ${wallets.length} ví: ${wallets.map((w) => w.name).join(", ")}`
              : "Chưa phát hiện ví nào trong trình duyệt."}
          </p>
        </div>
      </div>

      <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <Feature title="Phát hiện ví" body="Liệt kê mọi ví CIP-30 đã cài, tự kết nối lại sau reload." />
        <Feature title="Số dư & tài sản" body="ADA, native token và NFT đọc trực tiếp từ UTxO của ví." />
        <Feature title="Đăng nhập Web3" body="Ký nonce bằng địa chỉ stake, server xác minh và cấp session." />
        <Feature title="Gửi giao dịch" body="Dựng, ký và phát tx ADA kèm kiểm tra đúng mạng." />
      </div>

      <div className="mt-12 rounded-2xl border border-white/10 bg-white/[0.03] p-6">
        <h2 className="font-semibold text-white">Ví hoạt động như thế nào?</h2>
        <p className="mt-2 text-sm leading-relaxed text-slate-400">
          Extension ví inject một object vào <code className="font-mono text-slate-300">window.cardano</code>.
          Trang web gọi <code className="font-mono text-slate-300">enable()</code>, người dùng bấm
          đồng ý trong popup, và trang nhận được quyền <strong>đọc</strong> địa chỉ cùng UTxO.
          Mọi thao tác ký đều phải được người dùng xác nhận thủ công trong ví —
          website không bao giờ chạm được vào private key.
        </p>
      </div>
    </div>
  );
}

function Feature({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <div className="text-sm font-semibold text-white">{title}</div>
      <p className="mt-1.5 text-sm leading-relaxed text-slate-400">{body}</p>
    </div>
  );
}

function CardanoMark() {
  return (
    <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-sky-500 to-blue-700">
      <svg className="h-5 w-5 text-white" viewBox="0 0 24 24" fill="currentColor">
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
