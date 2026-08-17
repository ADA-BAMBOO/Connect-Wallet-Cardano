"use client";

import { useState } from "react";
import { useLovelace, useNetwork, useWallet } from "@meshsdk/react";
import { Alert, Button, Card, Field, inputClass } from "./ui";
import { adaToLovelace, lovelaceToAda, truncate } from "@/lib/format";
import { addressMatchesNetwork, getNetworkInfo, txUrl } from "@/lib/network";
import { describeError, isUserDeclined } from "@/lib/errors";

/** Cardano yêu cầu mỗi UTxO phải chứa tối thiểu ~1 ADA (min-ADA / minUTxOValue). */
const MIN_LOVELACE = 1_000_000n;

export function SendAdaCard() {
  const { wallet, connected } = useWallet();
  const balance = useLovelace();
  const networkId = useNetwork();
  const network = getNetworkInfo(networkId);

  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  function validate(): string | null {
    const address = recipient.trim();

    if (!address) return "Nhập địa chỉ người nhận.";
    if (!address.startsWith("addr")) return "Địa chỉ phải bắt đầu bằng addr1 hoặc addr_test1.";
    if (network && !addressMatchesNetwork(address, network)) {
      return network.isMainnet
        ? "Ví đang ở Mainnet nhưng địa chỉ nhận là testnet (addr_test1)."
        : "Ví đang ở Testnet nhưng địa chỉ nhận là mainnet (addr1). Gửi nhầm mạng sẽ mất tiền.";
    }

    const lovelace = adaToLovelace(amount);
    if (lovelace === null) return "Số ADA không hợp lệ (tối đa 6 chữ số thập phân).";
    if (BigInt(lovelace) < MIN_LOVELACE) return "Cardano yêu cầu gửi tối thiểu 1 ADA mỗi output.";
    if (balance && BigInt(lovelace) > BigInt(balance)) return "Số dư không đủ.";

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
      if (!lovelace) throw new Error("Số ADA không hợp lệ.");

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
          ? "Bạn đã huỷ ký giao dịch."
          : `Giao dịch thất bại: ${describeError(err)}`,
      );
    } finally {
      setBusy(false);
    }
  }

  const disabled = !connected || busy;

  return (
    <Card
      title="Gửi ADA"
      description="Dựng, ký và phát giao dịch lên mạng Cardano"
      icon={<SendIcon />}
    >
      <div className="space-y-4">
        {network?.isMainnet && (
          <Alert tone="danger">
            Ví đang ở <strong>Mainnet</strong>. Giao dịch gửi đi là <strong>không thể hoàn tác</strong>
            {" "}và dùng ADA thật.
          </Alert>
        )}

        <Field
          label="Địa chỉ người nhận"
          hint={
            network
              ? `Phải là địa chỉ ${network.addressPrefix}… trên ${network.label}`
              : "Địa chỉ bech32 bắt đầu bằng addr1 / addr_test1"
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
          label="Số lượng (ADA)"
          hint={
            balance
              ? `Khả dụng: ${lovelaceToAda(balance, 2)} ADA · tối thiểu 1 ADA`
              : "Tối thiểu 1 ADA"
          }
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
            <div className="font-medium">Đã gửi giao dịch thành công</div>
            <div className="mt-1 font-mono text-xs break-all">{truncate(txHash, 20, 12)}</div>
            {network && (
              <a
                href={txUrl(network, txHash)}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-block underline underline-offset-4"
              >
                Xem trên Cardanoscan ↗
              </a>
            )}
            <p className="mt-2 text-xs opacity-80">
              Giao dịch cần khoảng 20–60 giây để được đưa vào block.
            </p>
          </Alert>
        )}

        <Button onClick={send} disabled={disabled} loading={busy}>
          {busy ? "Đang xử lý…" : "Gửi giao dịch"}
        </Button>

        <p className="text-xs leading-relaxed text-slate-500">
          Cần ADA testnet? Lấy miễn phí tại{" "}
          <a
            href="https://docs.cardano.org/cardano-testnets/tools/faucet/"
            target="_blank"
            rel="noreferrer"
            className="text-sky-400 underline underline-offset-2"
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
