import { WalletAppLoader } from "@/components/WalletAppLoader";

export default function Home() {
  return (
    <>
      {/* Nền trang trí, không tương tác */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 -z-10 bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,rgba(56,132,255,0.18),transparent)]"
      />

      <WalletAppLoader />

      <footer className="border-t border-white/10">
        <div className="mx-auto max-w-5xl px-6 py-6 text-sm text-slate-500">
          <p>
            Dự án mẫu — dựng bằng Next.js và{" "}
            <a
              href="https://meshjs.dev"
              target="_blank"
              rel="noreferrer"
              className="text-slate-400 underline underline-offset-4 hover:text-slate-200"
            >
              Mesh SDK
            </a>
            . Chuẩn kết nối:{" "}
            <a
              href="https://cips.cardano.org/cip/CIP-30"
              target="_blank"
              rel="noreferrer"
              className="text-slate-400 underline underline-offset-4 hover:text-slate-200"
            >
              CIP-30
            </a>
            .
          </p>
        </div>
      </footer>
    </>
  );
}
