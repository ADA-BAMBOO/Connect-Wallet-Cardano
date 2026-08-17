"use client";

import { useEffect, useState } from "react";
import { useAddress, useLovelace, useNetwork, useWallet } from "@meshsdk/react";
import { Alert, Badge, Card, CopyableField, Spinner } from "./ui";
import { addressUrl, getNetworkInfo } from "@/lib/network";
import { lovelaceToAda, truncate } from "@/lib/format";

export function AccountCard() {
  const { wallet, connected } = useWallet();
  const address = useAddress();
  const lovelace = useLovelace();
  const networkId = useNetwork();

  const [stakeAddress, setStakeAddress] = useState<string | null>(null);
  const [utxoCount, setUtxoCount] = useState<number | null>(null);

  const network = getNetworkInfo(networkId);

  // Component này chỉ được render khi đã kết nối, và bị unmount khi ngắt kết nối,
  // nên không cần reset state đồng bộ — chỉ cần huỷ request đang bay.
  useEffect(() => {
    if (!connected || !wallet) return;

    let cancelled = false;

    (async () => {
      try {
        const [rewards, utxos] = await Promise.all([
          wallet.getRewardAddresses(),
          wallet.getUtxos(),
        ]);
        if (cancelled) return;
        setStakeAddress(rewards[0] ?? null);
        setUtxoCount(utxos.length);
      } catch {
        if (!cancelled) setStakeAddress(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [wallet, connected]);

  return (
    <Card
      title="Tài khoản"
      description="Dữ liệu đọc trực tiếp từ ví qua CIP-30"
      icon={<WalletIcon />}
      action={
        network ? (
          <Badge tone={network.isMainnet ? "warning" : "info"}>
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                network.isMainnet ? "bg-amber-400" : "bg-sky-400"
              }`}
            />
            {network.label}
          </Badge>
        ) : (
          <Badge>Đang đọc mạng…</Badge>
        )
      }
    >
      <div className="space-y-5">
        {network?.isMainnet && (
          <Alert tone="warning">
            Ví đang ở <strong>Mainnet</strong> — mọi giao dịch dùng ADA thật. Để thử nghiệm an
            toàn, hãy chuyển ví sang Preprod/Preview testnet.
          </Alert>
        )}

        <div className="rounded-xl border border-white/10 bg-gradient-to-br from-sky-500/10 to-transparent px-5 py-4">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-400">Số dư</div>
          <div className="mt-1 flex items-baseline gap-2">
            {lovelace === undefined ? (
              <Spinner className="text-slate-500" />
            ) : (
              <>
                <span className="font-mono text-3xl font-semibold tabular-nums text-white">
                  {lovelaceToAda(lovelace, 2)}
                </span>
                <span className="text-lg font-medium text-slate-400">ADA</span>
              </>
            )}
          </div>
          {lovelace !== undefined && (
            <div className="mt-1 font-mono text-xs text-slate-500">
              {BigInt(lovelace).toLocaleString("en-US")} lovelace
              {utxoCount !== null && ` · ${utxoCount} UTxO`}
            </div>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <CopyableField
            label="Địa chỉ nhận (payment)"
            value={address ?? ""}
            display={truncate(address, 14, 8)}
            href={address && network ? addressUrl(network, address) : undefined}
          />
          <CopyableField
            label="Địa chỉ stake"
            value={stakeAddress ?? ""}
            display={stakeAddress ? truncate(stakeAddress, 14, 8) : "—"}
          />
        </div>

        <p className="text-xs leading-relaxed text-slate-500">
          Địa chỉ payment có thể đổi theo từng giao dịch, nên <strong>địa chỉ stake</strong> mới là
          định danh ổn định của một ví — đó là lý do phần đăng nhập bên dưới ký bằng địa chỉ stake.
        </p>
      </div>
    </Card>
  );
}

function WalletIcon() {
  return (
    <svg
      className="h-5 w-5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H18a2 2 0 0 1 2 2v1" />
      <path d="M3 7.5V17a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3" />
      <path d="M21 10.5h-4a1.75 1.75 0 0 0 0 3.5h4v-3.5Z" />
    </svg>
  );
}
