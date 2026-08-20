"use client";

import { useCallback, useEffect, useState } from "react";
import { useWallet } from "@meshsdk/react";

import { Alert, Badge, Button, Card, Field, inputClass } from "./ui";
import { describeError, readJsonResponse } from "@/lib/errors";
import { truncate } from "@/lib/format";
import { useNetworkId } from "@/lib/use-wallet-data";
import { useDict } from "@/lib/i18n/client";
import type { Dictionary } from "@/lib/i18n/dictionaries";

/**
 * Thẻ faucet — người test tự lấy stablecoin thử.
 *
 * Faucet CHỈ chạy trên Preprod (xem lib/faucet.ts). Component này không chọn mạng và
 * cũng không gửi mạng nào lên server: nó chỉ cảnh báo khi ví đang ở mainnet, vì lúc đó
 * địa chỉ trong ví không phải thứ faucet phát tới được.
 */

type FaucetToken = {
  symbol: string;
  label: string;
  unit: string;
  amount: string;
  mode: "mint" | "transfer";
  available: boolean | null;
};

type FaucetStatus = {
  network: string;
  enabled: boolean;
  problems: string[];
  address: string | null;
  ada: string;
  cooldownSeconds: number;
  tokens: FaucetToken[];
  balanceAda: string | null;
  balanceLow: boolean;
  usage: { last24h: number; total: number } | null;
  cooldownRemaining: number | null;
};

type ClaimResult = {
  txHash: string;
  explorerUrl: string;
  ada: string;
  assets: { symbol: string; amount: string }[];
};

/**
 * Cùng cách diễn đạt với `formatDuration` phía server, để hai bên không nói lệch nhau.
 *
 * Nhận cả từ điển thay vì gọi hook: hàm này chạy ngoài thân component (trong nhánh
 * JSX và trong chuỗi ghép), mà hook thì không gọi được ở đó.
 */
function formatDuration(seconds: number, t: Dictionary): string {
  if (seconds < 60) return t.faucet.seconds(seconds);

  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return t.faucet.minutes(minutes);

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? t.faucet.hours(hours) : t.faucet.hoursMinutes(hours, rest);
}

export function FaucetCard() {
  const { wallet, connected } = useWallet();
  const t = useDict();
  const networkId = useNetworkId();

  const [status, setStatus] = useState<FaucetStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ClaimResult | null>(null);

  /** Nạp trạng thái; truyền địa chỉ để server trả kèm thời gian chờ còn lại. */
  const loadStatus = useCallback(async (forAddress?: string) => {
    const query = forAddress?.trim() ? `?address=${encodeURIComponent(forAddress.trim())}` : "";

    try {
      const res = await fetch(`/api/faucet${query}`);
      const data = await readJsonResponse<FaucetStatus>(res);

      if ("error" in data) {
        setStatusError(data.error);
        return;
      }
      setStatus(data);
      setStatusError(null);
    } catch (err) {
      setStatusError(describeError(err));
    }
  }, []);

  // Địa chỉ nhận mặc định là ví đang kết nối — đó là ví người test sắp trả tiền bằng.
  // Vẫn cho sửa: nhiều người muốn nạp cho một ví khác đang mở ở máy khác.
  useEffect(() => {
    if (!connected || !wallet) return;

    let alive = true;

    // `getChangeAddress()` của CIP-30 có ví trả Promise, có ví trả thẳng chuỗi
    // (SometimesPromise trong Mesh) — `await` xử lý được cả hai.
    void (async () => {
      try {
        const value = await wallet.getChangeAddress();
        if (alive) setAddress((current) => current || value);
      } catch {
        // Không lấy được địa chỉ thì để trống — người dùng dán tay.
      }
    })();

    return () => {
      alive = false;
    };
  }, [connected, wallet]);

  // Một effect cho cả hai việc: nạp trạng thái lần đầu, và hỏi lại cooldown mỗi khi
  // địa chỉ đổi. Lượt gõ phím được gộp lại chờ 600ms — mỗi lượt là một truy vấn
  // Postgres, không cần chạy theo từng phím.
  useEffect(() => {
    const target = address.trim();
    const timer = setTimeout(() => void loadStatus(target), target ? 600 : 0);
    return () => clearTimeout(timer);
  }, [address, loadStatus]);

  async function claim() {
    setBusy(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch("/api/faucet/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: address.trim() }),
      });
      const data = await readJsonResponse<ClaimResult & { error?: string }>(res);

      if (!res.ok || "error" in data) {
        setError(("error" in data && data.error) || t.faucet.claimFailed(res.status));
        return;
      }

      setResult(data);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
      // Số dư ví faucet và cooldown vừa đổi — dù thành công hay không.
      void loadStatus(address);
    }
  }

  const walletOnMainnet = networkId === 1;
  const addressLooksValid = /^addr_test1[0-9a-z]{20,}$/.test(address.trim());
  const cooldownLeft = status?.cooldownRemaining ?? 0;
  const disabled = busy || !status?.enabled || !addressLooksValid || cooldownLeft > 0;

  return (
    <Card
      title={t.faucet.title}
      description={t.faucet.description}
      icon={<DropIcon />}
      action={<Badge tone={status?.enabled ? "success" : "neutral"}>Preprod</Badge>}
    >
      <div className="space-y-4">
        {statusError && <Alert tone="warning">{t.faucet.statusError(statusError)}</Alert>}

        {status && !status.enabled && (
          <Alert tone="info">
            <div className="font-medium">{t.faucet.notReady}</div>
            <ul className="mt-1.5 list-disc space-y-1 pl-4 text-xs leading-relaxed">
              {status.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </Alert>
        )}

        {walletOnMainnet && (
          <Alert tone="warning">
            {t.faucet.mainnetWarning1} <strong>Mainnet</strong>{t.faucet.mainnetWarning2}{" "}
            <code>addr_test1…</code> {t.faucet.mainnetWarning3}
          </Alert>
        )}

        {status && status.tokens.length > 0 && (
          <div className="rounded-xl border border-hairline bg-ink-950/40 p-3.5">
            <div className="text-xs font-medium uppercase tracking-wide text-fg-subtle">
              {t.faucet.perClaim}
            </div>
            <ul className="mt-2 space-y-1.5">
              {status.tokens.map((token) => (
                <li key={token.unit} className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="text-fg-muted">
                    {token.symbol}
                    <span className="ml-1.5 text-xs text-fg-subtle">{token.label}</span>
                  </span>
                  <span className="font-mono text-fg">
                    {token.amount}
                    {token.available === false && (
                      <span className="ml-2 text-xs text-warn-400">{t.faucet.outOfStock}</span>
                    )}
                  </span>
                </li>
              ))}
              <li className="flex items-baseline justify-between gap-3 border-t border-hairline pt-1.5 text-sm">
                {/* ADA không phải quà: output mang native token bắt buộc phải có min-ADA. */}
                <span className="text-fg-muted">
                  ADA<span className="ml-1.5 text-xs text-fg-subtle">{t.faucet.minAdaNote}</span>
                </span>
                <span className="font-mono text-fg">{status.ada}</span>
              </li>
            </ul>
          </div>
        )}

        <Field
          label={t.faucet.recipient}
          hint={connected ? t.faucet.recipientHintConnected : t.faucet.recipientHintManual}
          error={address.trim() && !addressLooksValid ? t.faucet.recipientInvalid : undefined}
        >
          <input
            className={inputClass}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="addr_test1…"
            spellCheck={false}
            autoComplete="off"
            disabled={busy}
          />
        </Field>

        {error && <Alert tone="danger">{error}</Alert>}

        {result && (
          <Alert tone="success">
            <div className="font-medium">{t.faucet.sent}</div>
            <div className="mt-1 text-xs">
              {result.assets.map((asset) => `${asset.amount} ${asset.symbol}`).join(" · ")} +{" "}
              {result.ada} ADA
            </div>
            <div className="mt-1 font-mono text-xs break-all">{truncate(result.txHash, 20, 12)}</div>
            <a
              href={result.explorerUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-block underline underline-offset-4"
            >
              {t.faucet.viewOnExplorer}
            </a>
            <p className="mt-2 text-xs opacity-80">
              {t.faucet.arriveNote}
            </p>
          </Alert>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={claim} disabled={disabled} loading={busy}>
            {busy ? t.faucet.claiming : t.faucet.claim}
          </Button>

          {cooldownLeft > 0 && (
            <span className="text-sm text-fg-muted">
              {t.faucet.cooldown(formatDuration(cooldownLeft, t))}
            </span>
          )}
        </div>

        <p className="text-xs leading-relaxed text-fg-subtle">
          {t.faucet.worthless}{" "}
          <a
            href="https://docs.cardano.org/cardano-testnets/tools/faucet/"
            target="_blank"
            rel="noreferrer"
            className="text-brand-400 underline underline-offset-2"
          >
            Cardano Testnet Faucet
          </a>
          .
          {status?.cooldownSeconds
            ? t.faucet.cooldownNote(formatDuration(status.cooldownSeconds, t))
            : ""}
        </p>

        {status?.address && (
          <p className="text-xs text-fg-subtle">
            {t.faucet.faucetWallet} <span className="font-mono">{truncate(status.address, 12, 8)}</span>
            {status.balanceAda && (
              <>
                {t.faucet.remaining}
                <span className={status.balanceLow ? "text-warn-400" : ""}>
                  {status.balanceAda} ADA
                </span>
              </>
            )}
            {status.usage && t.faucet.usage(status.usage.last24h)}
          </p>
        )}
      </div>
    </Card>
  );
}

function DropIcon() {
  return (
    <svg
      className="h-5 w-5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 3.5c3.2 3.4 5.5 6.3 5.5 9a5.5 5.5 0 0 1-11 0c0-2.7 2.3-5.6 5.5-9Z" />
      <path d="M9.5 13.5a2.5 2.5 0 0 0 2.5 2.5" />
    </svg>
  );
}
