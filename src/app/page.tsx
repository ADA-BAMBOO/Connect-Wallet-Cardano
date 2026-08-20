import { WalletAppLoader } from "@/components/WalletAppLoader";
import { getDictionary } from "@/lib/i18n/server";

/* Nền trang trí nằm ở root layout (components/Ambient), không lặp lại ở từng page. */

export default async function Home() {
  const t = await getDictionary();

  return (
    <>
      <WalletAppLoader />

      <footer className="mt-auto border-t border-hairline">
        <div className="mx-auto max-w-5xl px-6 py-8 text-sm text-fg-subtle">
          <p className="leading-relaxed">
            {t.shell.footerBuiltWith}{" "}
            <a
              href="https://meshjs.dev"
              target="_blank"
              rel="noreferrer"
              className="text-fg-muted underline decoration-hairline-strong underline-offset-4
                transition-colors duration-150 hover:text-brand-300 hover:decoration-brand-400"
            >
              Mesh SDK
            </a>
            . {t.shell.footerStandard}{" "}
            <a
              href="https://cips.cardano.org/cip/CIP-30"
              target="_blank"
              rel="noreferrer"
              className="text-fg-muted underline decoration-hairline-strong underline-offset-4
                transition-colors duration-150 hover:text-brand-300 hover:decoration-brand-400"
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
