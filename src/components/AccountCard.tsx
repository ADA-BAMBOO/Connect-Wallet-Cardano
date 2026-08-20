"use client";

import { Alert, Badge, Card, CopyableField, Spinner } from "./ui";
import { addressUrl, getNetworkInfo } from "@/lib/network";
import { lovelaceToAda, truncate } from "@/lib/format";
import {
  useLovelace,
  useNetworkId,
  useStakeAddress,
  useUtxos,
  useWalletAddress,
} from "@/lib/use-wallet-data";
import { useDict } from "@/lib/i18n/client";

export function AccountCard() {
  const t = useDict();
  const address = useWalletAddress();
  const lovelace = useLovelace();
  const networkId = useNetworkId();

  // Đi qua use-wallet-data thay vì tự gọi ví: ở đây trước kia là hai lời gọi CIP-30
  // không ai gộp và không có thử lại, bắn ra đúng lúc mọi thẻ khác cũng đang hỏi ví.
  const { value: stakeAddress, error: stakeError } = useStakeAddress();
  const { value: utxos } = useUtxos();
  const utxoCount = utxos?.length ?? null;

  const network = getNetworkInfo(networkId);

  return (
    <Card
      title={t.account.title}
      description={t.account.description}
      icon={<WalletIcon />}
      action={
        network ? (
          <Badge tone={network.isMainnet ? "warning" : "info"}>
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                network.isMainnet ? "bg-warn-400" : "bg-brand-400"
              }`}
            />
            {network.label}
          </Badge>
        ) : (
          <Badge>{t.account.readingNetwork}</Badge>
        )
      }
    >
      <div className="space-y-5">
        {network?.isMainnet && (
          <Alert tone="warning">
            {t.account.mainnetWarning1} <strong>Mainnet</strong> {t.account.mainnetWarning2}
          </Alert>
        )}

        {/*
          Số dư dùng tabular-nums: giá trị được đọc lại liên tục từ ví, chữ số
          không đều sẽ làm cả dòng nhảy qua nhảy lại mỗi lần cập nhật.
        */}
        <div
          className="rounded-2xl border border-brand-500/25 bg-gradient-to-br from-brand-500/15 via-brand-500/5
            to-transparent px-5 py-4"
        >
          <div className="text-xs font-medium uppercase tracking-wide text-fg-muted">{t.account.balance}</div>
          <div className="mt-1 flex items-baseline gap-2">
            {lovelace === undefined ? (
              <Spinner className="text-fg-subtle" />
            ) : (
              <>
                <span className="font-mono text-3xl font-semibold tabular-nums text-fg sm:text-4xl">
                  {lovelaceToAda(lovelace, 2)}
                </span>
                <span className="text-lg font-medium text-brand-300">ADA</span>
              </>
            )}
          </div>
          {lovelace !== undefined && (
            <div className="mt-1 font-mono text-xs tabular-nums text-fg-subtle">
              {BigInt(lovelace).toLocaleString("en-US")} lovelace
              {utxoCount !== null && t.account.utxoCount(utxoCount)}
            </div>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <CopyableField
            label={t.account.paymentAddress}
            value={address ?? ""}
            display={truncate(address, 14, 8)}
            href={address && network ? addressUrl(network, address) : undefined}
          />
          <CopyableField
            label={t.account.stakeAddress}
            value={stakeAddress ?? ""}
            display={
              stakeAddress
                ? truncate(stakeAddress, 14, 8)
                : stakeError
                  ? "—"
                  : t.account.stakeUnavailable
            }
          />
        </div>

        {/*
          Hỏi ví thất bại KHÔNG được hiện giống ví không có địa chỉ stake. Đây là
          trạng thái sửa được — tải lại trang là xong — nên phải nói ra, kèm đường
          đi tiếp. Trước đây cả hai trường hợp đều thành một dấu gạch ngang câm.
        */}
        {stakeError && (
          <Alert tone="warning">
            {t.account.stakeFailed(stakeError)}{" "}
            <span className="text-fg-muted">{t.account.stakeFailedHint}</span>
          </Alert>
        )}

        <p className="text-xs leading-relaxed text-fg-subtle">
          {t.account.stakeNote1} <strong>{t.account.stakeNote2}</strong> {t.account.stakeNote3}
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
