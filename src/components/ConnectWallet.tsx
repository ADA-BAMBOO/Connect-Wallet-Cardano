"use client";

import { useEffect, useRef, useState } from "react";
import { useWallet, useWalletList } from "@meshsdk/react";
import { Badge, Button, Modal, Spinner } from "./ui";
import { describeError } from "@/lib/errors";

const STORAGE_KEY = "cardano-demo:last-wallet";

/** Ví phổ biến để gợi ý cài đặt khi trình duyệt chưa có ví nào. */
const SUGGESTED_WALLETS = [
  { name: "Lace", url: "https://www.lace.io/" },
  { name: "Eternl", url: "https://eternl.io/" },
  { name: "Typhon", url: "https://typhonwallet.io/" },
  { name: "Vespr", url: "https://vespr.xyz/" },
];

export function ConnectWallet() {
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
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          Đã kết nối
        </Badge>
        <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5">
          {current?.icon && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={current.icon} alt="" className="h-5 w-5 rounded" />
          )}
          <span className="text-sm font-medium capitalize text-white">{name}</span>
        </div>
        <Button variant="secondary" size="sm" onClick={handleDisconnect}>
          Ngắt kết nối
        </Button>
      </div>
    );
  }

  return (
    <>
      <Button onClick={() => setOpen(true)} loading={connecting}>
        {connecting ? "Đang kết nối…" : "Kết nối ví"}
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Chọn ví"
        description={
          wallets.length > 0
            ? `Tìm thấy ${wallets.length} ví trong trình duyệt`
            : "Chưa phát hiện ví nào"
        }
        footer={
          <p className="text-xs text-slate-500">
            Ví được phát hiện qua chuẩn{" "}
            <a
              href="https://cips.cardano.org/cip/CIP-30"
              target="_blank"
              rel="noreferrer"
              className="text-slate-400 underline underline-offset-2 hover:text-slate-200"
            >
              CIP-30
            </a>{" "}
            (<code className="font-mono">window.cardano</code>). Trang này không bao giờ đọc được
            private key của bạn.
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
                    className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition
                          hover:bg-white/[0.07] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {wallet.icon ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={wallet.icon} alt="" className="h-9 w-9 rounded-lg" />
                    ) : (
                      <div className="h-9 w-9 rounded-lg bg-white/10" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="font-medium capitalize text-white">{wallet.name}</div>
                      {wallet.version && (
                        <div className="text-xs text-slate-500">v{wallet.version}</div>
                      )}
                    </div>
                    {pending === wallet.name && <Spinner className="text-sky-400" />}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="px-2 py-3">
              <p className="text-sm text-slate-400">
                Trình duyệt chưa cài extension ví Cardano nào. Cài một trong các ví sau rồi tải lại
                trang:
              </p>
              <ul className="mt-3 grid grid-cols-2 gap-2">
                {SUGGESTED_WALLETS.map((w) => (
                  <li key={w.name}>
                    <a
                      href={w.url}
                      target="_blank"
                      rel="noreferrer"
                      className="block rounded-lg border border-white/10 px-3 py-2 text-sm text-sky-300 transition hover:bg-white/5"
                    >
                      {w.name} ↗
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {error != null && (
            <p className="mt-2 px-2 pb-1 text-sm text-rose-300">
              Không kết nối được: {describeError(error)}
            </p>
          )}
        </div>
      </Modal>
    </>
  );
}
