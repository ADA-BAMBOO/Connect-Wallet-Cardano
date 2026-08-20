"use client";

import { useState } from "react";
import { useWallet } from "@meshsdk/react";
import { Alert, Button, Card, Field, inputClass } from "./ui";
import { adaToLovelace, lovelaceToAda, truncate } from "@/lib/format";
import { addressMatchesNetwork, getNetworkInfo, txUrl } from "@/lib/network";
import { describeError, isUserDeclined } from "@/lib/errors";
import { useLovelace, useNetworkId } from "@/lib/use-wallet-data";
import { useDict } from "@/lib/i18n/client";

/** Cardano yêu cầu mỗi UTxO phải chứa tối thiểu ~1 ADA (min-ADA / minUTxOValue). */
const MIN_LOVELACE = 1_000_000n;

export function SendAdaCard() {
  const { wallet, connected } = useWallet();
  const t = useDict();
  const balance = useLovelace();
  const networkId = useNetworkId();
  const network = getNetworkInfo(networkId);

  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  function validate(): string | null {
    const address = recipient.trim();

    if (!address) return t.send.errNoRecipient;
    if (!address.startsWith("addr")) return t.send.errBadPrefix;
    if (network && !addressMatchesNetwork(address, network)) {
      return network.isMainnet
        ? t.send.errMainnetToTestnet
        : t.send.errTestnetToMainnet;
    }

    const lovelace = adaToLovelace(amount);
    if (lovelace === null) return t.send.errBadAmount;
    if (BigInt(lovelace) < MIN_LOVELACE) return t.send.errBelowMin;
    if (balance && BigInt(lovelace) > BigInt(balance)) return t.send.errInsufficient;

    return null;
  }

  async function send() {
    if (!wallet) return;

    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    setBusy(true);
    setError(null);
    setTxHash(null);

    try {
      // Import động: giữ phần transaction builder (kèm WASM) ra khỏi bundle ban đầu.
      const { Transaction } = await import("@meshsdk/core");

      const lovelace = adaToLovelace(amount);
      if (!lovelace) throw new Error(t.send.errBadAmountShort);

      // 1. Dựng giao dịch — Mesh tự chọn UTxO, tính phí và trả tiền thừa về ví.
      const tx = new Transaction({ initiator: wallet });
      tx.sendLovelace(recipient.trim(), lovelace);
      const unsignedTx = await tx.build();

      // 2. Ví mở popup để người dùng xem lại và ký. Private key không rời khỏi ví.
      const signedTx = await wallet.signTx(unsignedTx);

      // 3. Đẩy giao dịch đã ký lên mạng.
      const hash = await wallet.submitTx(signedTx);

      setTxHash(hash);
      setRecipient("");
      setAmount("");
    } catch (err) {
      // Ví ném object CIP-30 `{code, info}`, không phải Error — xem lib/errors.ts.
      setError(
        isUserDeclined(err, "tx")
          ? t.send.errDeclined
          : t.send.errFailed(describeError(err)),
      );
    } finally {
      setBusy(false);
    }
  }

  const disabled = !connected || busy;

  return (
    <Card
      title={t.send.title}
      description={t.send.description}
      icon={<SendIcon />}
    >
      <div className="space-y-4">
        {network?.isMainnet && (
          <Alert tone="danger">
            {t.send.mainnetWarning1} <strong>Mainnet</strong>{t.send.mainnetWarning2}{" "}
            <strong>{t.send.mainnetWarning3}</strong> {t.send.mainnetWarning4}
          </Alert>
        )}

        <Field
          label={t.send.recipient}
          hint={
            network
              ? t.send.recipientHint(network.addressPrefix, network.label)
              : t.send.recipientHintGeneric
          }
        >
          <input
            className={inputClass}
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder={network?.isMainnet ? "addr1…" : "addr_test1…"}
            spellCheck={false}
            autoComplete="off"
            disabled={disabled}
          />
        </Field>

        <Field
          label={t.send.amount}
          hint={balance ? t.send.amountHint(lovelaceToAda(balance, 2)) : t.send.amountHintGeneric}
        >
          <input
            className={inputClass}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="1.5"
            inputMode="decimal"
            disabled={disabled}
          />
        </Field>

        {error && <Alert tone="danger">{error}</Alert>}

        {txHash && (
          <Alert tone="success">
            <div className="font-medium">{t.send.sent}</div>
            <div className="mt-1 font-mono text-xs break-all">{truncate(txHash, 20, 12)}</div>
            {network && (
              <a
                href={txUrl(network, txHash)}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-block underline underline-offset-4"
              >
                {t.send.viewOnExplorer}
              </a>
            )}
            <p className="mt-2 text-xs opacity-80">
              {t.send.blockWait}
            </p>
          </Alert>
        )}

        <Button onClick={send} disabled={disabled} loading={busy}>
          {busy ? t.send.submitting : t.send.submit}
        </Button>

        <p className="text-xs leading-relaxed text-fg-subtle">
          {t.send.needTestAda}{" "}
          <a
            href="https://docs.cardano.org/cardano-testnets/tools/faucet/"
            target="_blank"
            rel="noreferrer"
            className="text-brand-400 underline underline-offset-2"
          >
            Cardano Testnet Faucet
          </a>
          .
        </p>
      </div>
    </Card>
  );
}

function SendIcon() {
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
      <path d="M21.5 2.5 11 13" />
      <path d="M21.5 2.5 15 21l-4-8-8-4 18.5-6.5Z" />
    </svg>
  );
}
