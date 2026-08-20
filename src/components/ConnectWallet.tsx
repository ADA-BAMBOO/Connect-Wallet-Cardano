"use client";

import { useEffect, useRef, useState } from "react";
import { useWallet, useWalletList } from "@meshsdk/react";
import { Badge, Button, Modal, Spinner } from "./ui";
import { describeError } from "@/lib/errors";
import { useDict } from "@/lib/i18n/client";

const STORAGE_KEY = "cardano-demo:last-wallet";

/** Ví phổ biến để gợi ý cài đặt khi trình duyệt chưa có ví nào. */
const SUGGESTED_WALLETS = [
  { name: "Lace", url: "https://www.lace.io/" },
  { name: "Eternl", url: "https://eternl.io/" },
  { name: "Typhon", url: "https://typhonwallet.io/" },
  { name: "Vespr", url: "https://vespr.xyz/" },
];

export function ConnectWallet() {
  const t = useDict();
  const wallets = useWalletList();
  const { connect, disconnect, connected, connecting, name, error } = useWallet();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);

  // Ghi nhớ ví đã chọn và tự kết nối lại sau khi reload trang.
  const autoConnectTried = useRef(false);

  useEffect(() => {
    if (autoConnectTried.current || connected || connecting) return;
    if (wallets.length === 0) return; // chờ danh sách ví được inject xong

    autoConnectTried.current = true;
    const last = window.localStorage.getItem(STORAGE_KEY);
    if (last && wallets.some((w) => w.name === last)) {
      connect(last).catch(() => window.localStorage.removeItem(STORAGE_KEY));
    }
  }, [wallets, connected, connecting, connect]);

  useEffect(() => {
    if (connected && name) window.localStorage.setItem(STORAGE_KEY, name);
  }, [connected, name]);

  async function handleConnect(walletName: string) {
    setPending(walletName);
    try {
      await connect(walletName);
      setOpen(false);
    } catch {
      // Lỗi đã được Mesh đưa vào `error`, hiển thị bên dưới.
    } finally {
      setPending(null);
    }
  }

  function handleDisconnect() {
    window.localStorage.removeItem(STORAGE_KEY);
    disconnect();
  }

  if (connected) {
    const current = wallets.find((w) => w.name === name);
    return (
      <div className="flex items-center gap-3">
        <Badge tone="success">
          <span className="h-1.5 w-1.5 rounded-full bg-brand-400" />
          {t.connect.connected}
        </Badge>
        <div className="flex min-h-10 items-center gap-2 rounded-lg border border-hairline bg-surface-2 px-3 py-1.5">
          {current?.icon && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={current.icon} alt="" className="h-5 w-5 rounded" />
          )}
          <span className="text-sm font-medium capitalize text-fg">{name}</span>
        </div>
        <Button variant="secondary" size="sm" onClick={handleDisconnect}>
          {t.connect.disconnect}
        </Button>
      </div>
    );
  }

  return (
    <>
      <Button onClick={() => setOpen(true)} loading={connecting}>
        {connecting ? t.connect.connecting : t.connect.connect}
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t.connect.chooseWallet}
        description={
          wallets.length > 0
            ? t.connect.walletsFound(wallets.length)
            : t.connect.noWalletDetected
        }
        footer={
          <p className="text-xs text-fg-subtle">
            {t.connect.detectedVia}{" "}
            <a
              href="https://cips.cardano.org/cip/CIP-30"
              target="_blank"
              rel="noreferrer"
              className="text-fg-muted underline underline-offset-2 hover:text-fg"
            >
              CIP-30
            </a>{" "}
            (<code className="font-mono">window.cardano</code>). {t.connect.neverReadsKey}
          </p>
        }
      >
        <div className="p-3">
          {wallets.length > 0 ? (
            <ul className="space-y-1.5">
              {wallets.map((wallet) => (
                <li key={wallet.name}>
                  <button
                    onClick={() => handleConnect(wallet.name)}
                    disabled={pending !== null}
                    className="flex w-full cursor-pointer items-center gap-3 rounded-xl border border-transparent
                          px-3 py-3 text-left transition-colors duration-150
                          hover:border-hairline hover:bg-surface-2
                          disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    {wallet.icon ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={wallet.icon} alt="" className="h-9 w-9 rounded-lg" />
                    ) : (
                      <div className="h-9 w-9 rounded-lg border border-hairline bg-surface-2" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="font-medium capitalize text-fg">{wallet.name}</div>
                      {wallet.version && (
                        <div className="text-xs text-fg-subtle">v{wallet.version}</div>
                      )}
                    </div>
                    {pending === wallet.name && <Spinner className="text-brand-400" />}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="px-2 py-3">
              <p className="text-sm text-fg-muted">
                {t.connect.installPrompt}
              </p>
              <ul className="mt-3 grid grid-cols-2 gap-2">
                {SUGGESTED_WALLETS.map((w) => (
                  <li key={w.name}>
                    <a
                      href={w.url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex min-h-11 items-center rounded-lg border border-hairline bg-surface/60 px-3
                        text-sm text-brand-300 transition-colors duration-150
                        hover:border-hairline-strong hover:bg-surface-2"
                    >
                      {w.name} ↗
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {error != null && (
            <p className="mt-2 px-2 pb-1 text-sm text-danger-400">
              {t.connect.connectFailed(describeError(error))}
            </p>
          )}
        </div>
      </Modal>
    </>
  );
}
