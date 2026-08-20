"use client";

import { useEffect, useState } from "react";

import { Alert, Badge, Button, Card, CopyableField, Field, inputClass } from "./ui";
import { PaymentQr } from "./PaymentQr";
import { useNetworkId } from "@/lib/use-wallet-data";
import { useDict } from "@/lib/i18n/client";

/**
 * Thẻ tạo đơn thanh toán, dành cho phía người bán.
 *
 * Ví KHÔNG tham gia bước này: địa chỉ nhận tiền đến từ biến môi trường của server,
 * không bao giờ từ trình duyệt. Ví ở đây chỉ dùng để cảnh báo khi mạng đang kết nối
 * khác mạng của đơn.
 */

type CreatedOrder = {
  ref: string;
  network: string;
  amountUsd: string;
  description: string | null;
  expiresAt: string;
};

type HealthNetwork = { network: string; enabled: boolean };

export function CreateOrderCard() {
  const t = useDict();
  const walletNetworkId = useNetworkId();

  const [networks, setNetworks] = useState<string[] | null>(null);
  const [network, setNetwork] = useState<string>("");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [order, setOrder] = useState<CreatedOrder | null>(null);

  // Chỉ chào những mạng server thật sự nhận được tiền — tránh để người dùng tạo đơn
  // rồi mới biết mạng đó chưa cấu hình.
  useEffect(() => {
    let alive = true;

    fetch("/api/payments/health")
      .then((res) => res.json())
      .then((data: { networks?: HealthNetwork[] }) => {
        if (!alive) return;
        const enabled = (data.networks ?? []).filter((n) => n.enabled).map((n) => n.network);
        setNetworks(enabled);
        setNetwork((current) => current || enabled[0] || "");
      })
      .catch(() => alive && setNetworks([]));

    return () => {
      alive = false;
    };
  }, []);

  async function create() {
    setBusy(true);
    setError(null);
    setOrder(null);

    try {
      const res = await fetch("/api/payments/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ network, amountUsd: amount.trim(), description: description.trim() }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? t.createOrder.failed(res.status));
        return;
      }

      setOrder(data.order);
      setAmount("");
      setDescription("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (networks !== null && networks.length === 0) {
    return (
      <Card title={t.createOrder.title} icon={<InvoiceIcon />}>
        <Alert tone="info">
          {t.createOrder.noNetworks1}{" "}
          <a href="/api/payments/health" target="_blank" rel="noreferrer" className="underline underline-offset-4">
            /api/payments/health
          </a>{" "}
          {t.createOrder.noNetworks2}
        </Alert>
      </Card>
    );
  }

  const payUrl = order ? `${window.location.origin}/pay/${order.ref}` : null;

  // Ví đang ở mạng khác đơn thì người bán vẫn tạo được, nhưng chính họ sẽ không trả
  // thử được — nói trước còn hơn để họ loay hoay ở trang thanh toán.
  const walletNetwork = walletNetworkId === 1 ? "mainnet" : walletNetworkId === 0 ? "testnet" : null;
  const orderIsMainnet = network === "mainnet";
  const walletMismatch =
    walletNetwork !== null && (orderIsMainnet ? walletNetwork !== "mainnet" : walletNetwork !== "testnet");

  return (
    <Card
      title={t.createOrder.title}
      description={t.createOrder.description}
      icon={<InvoiceIcon />}
    >
      <div className="space-y-4">
        {networks && networks.length > 1 && (
          <Field label={t.createOrder.network}>
            <select
              className={inputClass}
              value={network}
              onChange={(e) => setNetwork(e.target.value)}
              disabled={busy}
            >
              {networks.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
        )}

        {orderIsMainnet && (
          <Alert tone="danger">
            {t.createOrder.mainnetWarning1} <strong>Mainnet</strong> {t.createOrder.mainnetWarning2}{" "}
            <strong>{t.createOrder.mainnetWarning3}</strong>.
          </Alert>
        )}

        <Field label={t.createOrder.amount} hint={t.createOrder.amountHint}>
          <input
            className={inputClass}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="12.50"
            inputMode="decimal"
            disabled={busy}
          />
        </Field>

        <Field label={t.createOrder.descriptionLabel} hint={t.createOrder.descriptionHint}>
          <input
            className={inputClass}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t.createOrder.descriptionPlaceholder}
            maxLength={200}
            disabled={busy}
          />
        </Field>

        {walletMismatch && (
          <Alert tone="warning">
            {t.createOrder.mismatch(walletNetwork ?? "", network)}
          </Alert>
        )}

        {error && <Alert tone="danger">{error}</Alert>}

        <Button onClick={create} disabled={busy || !amount.trim() || !network} loading={busy}>
          {busy ? t.createOrder.creating : t.createOrder.create}
        </Button>

        {order && payUrl && (
          <div className="motion-safe:animate-rise space-y-4 rounded-2xl border border-brand-500/35 bg-brand-500/[0.08] p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="font-medium text-brand-200">
                  {t.createOrder.created(order.ref)}
                </div>
                <div className="mt-0.5 text-sm text-fg-muted">
                  {order.amountUsd} USD
                  {order.description ? ` · ${order.description}` : ""}
                </div>
              </div>
              <Badge tone="success">{order.network}</Badge>
            </div>

            <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
              {/*
                QR mã hoá URL trang thanh toán, KHÔNG phải URI CIP-13: CIP-13 chỉ
                mô tả được số ADA, không mô tả được stablecoin. Quét bằng điện thoại
                rồi mở trong dApp browser của ví là đường duy nhất chạy được cho token.
              */}
              <PaymentQr value={payUrl} label={t.createOrder.qrLabel} />

              <div className="min-w-0 flex-1 space-y-3">
                {/*
                  Đây là hành động chính sau khi tạo đơn — việc chọn token, kết nối ví
                  và ký giao dịch đều diễn ra ở trang kia. Trước đây chỗ này chỉ có một
                  link chữ nhỏ, nên nhìn vào không thấy đường đi tiếp.
                */}
                <a href={`/pay/${order.ref}`} target="_blank" rel="noreferrer">
                  <Button className="w-full sm:w-auto">{t.createOrder.openPayPage}</Button>
                </a>

                <CopyableField label={t.createOrder.payLink} value={payUrl} href={`/pay/${order.ref}`} />

                <p className="text-xs leading-relaxed text-fg-subtle">
                  {t.createOrder.howTo(new Date(order.expiresAt).toLocaleString(t.dateLocale))}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

function InvoiceIcon() {
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
      <path d="M5 3.5h14v17l-3-2-2 2-2-2-2 2-2-2-3 2v-17Z" />
      <path d="M9 8.5h6M9 12.5h6M9 16h3" />
    </svg>
  );
}
