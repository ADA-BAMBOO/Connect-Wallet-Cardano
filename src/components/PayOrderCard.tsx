"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useWallet, useWalletList } from "@meshsdk/react";

import { ConnectWallet } from "./ConnectWallet";
import { PaymentQr } from "./PaymentQr";
import { Alert, Badge, Button, Card, CopyableField, Spinner } from "./ui";
import { describeError, isUserDeclined } from "@/lib/errors";
import { cip13PaymentUri } from "@/lib/cip13";
import { truncate } from "@/lib/format";
import { useNetworkId } from "@/lib/use-wallet-data";

/**
 * Trang thanh toán: chọn token, ký, rồi theo dõi cho tới khi đơn được xác nhận.
 *
 * Trang này KHÔNG tự kết luận đã trả tiền. Nó gửi giao dịch, báo txHash về server,
 * rồi hỏi lại trạng thái — mọi kết luận đều do server rút ra từ dữ liệu on-chain.
 */

type TokenOption = {
  symbol: string;
  label: string;
  unit: string;
  decimals: number;
  pegged: boolean;
  available: boolean;
  pegState: string | null;
};

type OrderPayment = {
  unit: string;
  symbol: string | null;
  quantity: string;
  quantityFormatted: string;
  adaRateUsd: string | null;
  rateSources: string[] | null;
  quoteExpiresAt: string | null;
  quoteExpired: boolean;
};

type Order = {
  ref: string;
  network: string;
  status: "pending" | "seen" | "confirmed" | "underpaid" | "expired" | "failed";
  amountUsd: string;
  description: string | null;
  merchantAddress: string;
  payment: OrderPayment | null;
  tx: {
    hash: string;
    blockHeight: string | null;
    confirmations: number;
    receivedQuantity: string | null;
  } | null;
  expiresAt: string;
  confirmedAt: string | null;
  /** Đường về cửa hàng, đã gắn ref/status. null khi đơn không đến từ shop nào. */
  returnUrl?: string | null;
};

/**
 * Các chặng của việc trả tiền, theo đúng thứ tự người dùng trải qua.
 *
 * Ba chặng đầu chỉ tồn tại ở client — server không biết gì về chúng cho tới khi giao
 * dịch lên chain. Đó chính là khoảng trống cần lấp: từ lúc bấm "Trả" tới lúc giao
 * dịch vào block có thể mất 20–60 giây, và nếu không hiện gì thì người dùng tưởng
 * hỏng rồi bấm lại.
 */
type PayStage = null | "building" | "signing" | "submitting" | "submitted";

/** Số xác nhận cần có. Trùng với PAYMENT_CONFIRMATIONS mặc định ở server. */
const REQUIRED_CONFIRMATIONS = 3;

const EXPLORER: Record<string, string> = {
  mainnet: "https://cardanoscan.io",
  preprod: "https://preprod.cardanoscan.io",
  preview: "https://preview.cardanoscan.io",
};

/** Nhịp hỏi lại trạng thái. Server tự tiết chế việc gọi Blockfrost nên đây chỉ là nhịp UI. */
const POLL_MS = 4_000;

export type OrderView = { order: Order; tokens: TokenOption[] };

export function PayOrderCard({ orderRef, initial }: { orderRef: string; initial: OrderView }) {
  const { wallet, connected } = useWallet();
  const walletList = useWalletList();
  const walletNetworkId = useNetworkId();

  // Dữ liệu ban đầu do server component đưa xuống, nên không có trạng thái "đang
  // tải" nào cả — người trả tiền thấy số tiền ngay từ lần render đầu.
  const [order, setOrder] = useState<Order>(initial.order);
  const [tokens, setTokens] = useState<TokenOption[]>(initial.tokens);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [payError, setPayError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Chặng hiện tại và txHash vừa gửi. Hai thứ này chỉ sống ở client, lấp đúng khoảng
  // thời gian server chưa biết gì về giao dịch.
  const [payStage, setPayStage] = useState<PayStage>(null);
  const [submittedTx, setSubmittedTx] = useState<string | null>(null);
  const [submittedAt, setSubmittedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/payments/orders/${orderRef}`);
      const data = await res.json();
      if (!res.ok) {
        setLoadError(data.error ?? `Không đọc được đơn (HTTP ${res.status}).`);
        return null;
      }
      setOrder(data.order);
      setTokens(data.tokens ?? []);
      setLoadError(null);
      return data.order as Order;
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, [orderRef]);

  // Chỉ poll khi còn có thể thay đổi. Đơn đã `confirmed`/`expired` thì dừng hẳn —
  // để một tab bỏ quên không gọi API mãi mãi.
  const status = order.status;
  const livePoll = status === "pending" || status === "seen";

  useEffect(() => {
    if (!livePoll) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [livePoll, load]);

  // Nhịp riêng cho đồng hồ đếm ngược, để không phải gọi API mỗi giây.
  useEffect(() => {
    if (!livePoll) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [livePoll]);

  /* ---------------------------------------------------------------- */

  async function chooseToken(unit: string) {
    setBusy(unit);
    setPayError(null);
    try {
      const res = await fetch(`/api/payments/orders/${orderRef}/quote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ unit }),
      });
      const data = await res.json();
      if (!res.ok) setPayError(data.error ?? `Khoá giá thất bại (HTTP ${res.status}).`);
      else setOrder(data.order);
    } catch (err) {
      setPayError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function pay() {
    if (!wallet || !order?.payment) return;

    setBusy("pay");
    setPayError(null);

    try {
      // Import động: giữ transaction builder (kèm WASM) ra khỏi bundle ban đầu.
      const { Transaction } = await import("@meshsdk/core");

      setPayStage("building");

      const tx = new Transaction({ initiator: wallet });
      const { unit, quantity } = order.payment;

      if (unit === "lovelace") tx.sendLovelace(order.merchantAddress, quantity);
      else tx.sendAssets(order.merchantAddress, [{ unit, quantity }]);

      // Đây là thứ buộc giao dịch với đơn hàng. Không có nó, server không có cách nào
      // biết khoản tiền này trả cho đơn nào — và cũng không nhận nó.
      tx.setMetadata(674, { msg: [`pay:${order.ref}`] });

      const unsigned = await tx.build();

      // Từ đây ví bật popup và có thể đứng yên khá lâu chờ người dùng bấm — phải nói
      // rõ đang chờ ai, nếu không họ tưởng trang bị treo.
      setPayStage("signing");
      const signed = await wallet.signTx(unsigned);

      setPayStage("submitting");
      const txHash = await wallet.submitTx(signed);

      setSubmittedTx(txHash);
      setSubmittedAt(Date.now());
      setPayStage("submitted");

      // Báo về cho server để khỏi phải chờ watcher quét. Chỉ là gợi ý — nếu bước này
      // hỏng thì watcher vẫn tự tìm ra bằng cách đọc metadata trên chain.
      await fetch(`/api/payments/orders/${orderRef}/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ txHash }),
      }).catch(() => {});

      await load();
    } catch (err) {
      setPayStage(null);
      // Ví CIP-30 ném object { code, info } chứ không phải Error — xem lib/errors.ts.
      setPayError(
        isUserDeclined(err, "tx") ? "Bạn đã huỷ ký giao dịch." : `Thanh toán thất bại: ${describeError(err)}`,
      );
    } finally {
      setBusy(null);
    }
  }

  /* ---------------------------------------------------------------- */

  const explorer = EXPLORER[order.network] ?? EXPLORER.preprod!;
  const done = order.status === "confirmed";
  const dead = order.status === "expired" || order.status === "failed";

  // Đủ điều kiện bấm trả: đã chọn token và báo giá còn hiệu lực.
  const payReady = Boolean(order.payment && !order.payment.quoteExpired);

  // Giao dịch đang trên đường: hoặc client vừa ký xong, hoặc server đã thấy tx.
  // Kiểm cả hai để tải lại trang giữa chừng vẫn không mất dấu.
  const inFlight = payStage !== null || order.tx !== null;

  return (
    <div className="space-y-5">
      {/* Lỗi khi poll không được xoá màn hình: dữ liệu cũ vẫn đúng và vẫn hữu ích. */}
      {loadError && <Alert tone="warning">Không cập nhật được trạng thái: {loadError}</Alert>}

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="font-mono text-sm text-fg-subtle">Đơn {order.ref}</div>
            <div className="mt-1 text-3xl font-semibold tabular-nums text-fg sm:text-4xl">
              {order.amountUsd} <span className="text-2xl text-fg-muted sm:text-3xl">USD</span>
            </div>
            {order.description && <div className="mt-1.5 text-fg-muted">{order.description}</div>}
          </div>
          <StatusBadge status={order.status} confirmations={order.tx?.confirmations ?? 0} />
        </div>

        {order.status === "pending" && !dead && (
          <p className="mt-4 text-xs text-fg-subtle">
            Đơn hết hạn lúc {new Date(order.expiresAt).toLocaleString("vi-VN")}
          </p>
        )}
      </Card>

      {done && <ConfirmedPanel order={order} explorer={explorer} />}

      {order.status === "underpaid" && (
        <Card title="Nhận thiếu tiền">
          <Alert tone="warning">
            Đã nhận {order.tx?.receivedQuantity} nhưng đơn yêu cầu {order.payment?.quantity}. Liên hệ
            người bán để được xử lý — giao dịch vẫn nằm trên chain.
          </Alert>
        </Card>
      )}

      {dead && (
        <Card title="Đơn không còn hiệu lực">
          <Alert tone="danger">
            Đơn này đã {order.status === "expired" ? "hết hạn" : "thất bại"}. Hãy xin người bán tạo
            đơn mới — <strong>đừng gửi tiền</strong> cho đơn này nữa.
          </Alert>
        </Card>
      )}

      {/*
        Khi giao dịch đang trên đường, dòng thời gian là thứ người dùng cần nhìn — và
        là thứ duy nhất họ cần nhìn. Ẩn hẳn phần chọn token: đổi token lúc này không
        có tác dụng gì, chỉ khiến người ta tưởng phải trả lại lần nữa.
      */}
      {inFlight && !done && (
        <PaymentProgress
          order={order}
          stage={payStage}
          submittedTx={submittedTx}
          submittedAt={submittedAt}
          now={now}
          explorer={explorer}
        />
      )}

      {!inFlight && !done && !dead && order.status !== "underpaid" && (
        <>
          <Card title="Chọn cách trả" description="Stablecoin quy đổi 1:1, ADA theo tỷ giá thị trường">
            <div className="grid gap-2 sm:grid-cols-2">
              {tokens.map((token) => {
                const active = order.payment?.unit === token.unit;
                return (
                  <button
                    key={token.unit}
                    onClick={() => chooseToken(token.unit)}
                    disabled={!token.available || busy !== null || order.status !== "pending"}
                    // min-h-16: ô chọn token là vùng chạm chính trên điện thoại
                    className={`flex min-h-16 cursor-pointer items-center justify-between gap-3 rounded-xl border px-4 py-3
                      text-left transition-colors duration-150
                      disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-45
                      ${
                        active
                          ? "border-brand-500/60 bg-brand-500/15"
                          : "border-hairline bg-surface hover:border-hairline-strong hover:bg-surface-2"
                      }`}
                  >
                    <div className="min-w-0">
                      <div className="font-medium text-fg">{token.symbol}</div>
                      <div className="truncate text-xs text-fg-subtle">{token.label}</div>
                    </div>
                    {busy === token.unit ? (
                      <Spinner className="text-brand-400" />
                    ) : !token.available ? (
                      <Badge tone="warning">lệch peg</Badge>
                    ) : active ? (
                      <Badge tone="info">đã chọn</Badge>
                    ) : null}
                  </button>
                );
              })}
            </div>

            {tokens.some((t) => !t.available) && (
              <p className="mt-3 text-xs leading-relaxed text-fg-subtle">
                Token bị đánh dấu <em>lệch peg</em> đang giao dịch cách xa mốc 1 USD nên tạm không
                nhận — trả bằng nó là bạn chịu thiệt.
              </p>
            )}

            {/*
              Người trả thử trên Preprod rất hay dừng lại ở đúng chỗ này: chọn được token
              nhưng trong ví không có đồng nào, và trang không hề nói phải lấy ở đâu.
            */}
            {order.network === "preprod" && (
              <p className="mt-3 text-xs leading-relaxed text-fg-subtle">
                Chưa có token thử trong ví?{" "}
                <Link href="/" className="text-brand-400 underline underline-offset-2">
                  Lấy miễn phí ở faucet
                </Link>{" "}
                trên trang chủ.
              </p>
            )}
          </Card>

          {order.payment && (
            <QuotePanel
              order={order}
              payment={order.payment}
              now={now}
              onRequote={() => chooseToken(order.payment!.unit)}
              requoting={busy === order.payment.unit}
            />
          )}

          {/*
            Thẻ này LUÔN hiện, kể cả khi chưa chọn token.

            Trước đây nó chỉ xuất hiện sau khi đã khoá giá, nên người vừa mở trang
            không thấy bước ví nào cả — không có nút kết nối, không có nút trả tiền,
            và cũng không có gì gợi ý rằng phải chọn token trước. Nút bị vô hiệu hoá
            kèm lý do vẫn tốt hơn nhiều so với một nút không tồn tại.
          */}
          <Card title="Trả bằng ví">
            {walletList.length === 0 ? (
              <NoWalletHelp orderRef={order.ref} />
            ) : (
              <div className="space-y-4">
                {!connected && (
                  <>
                    <p className="text-sm text-fg-muted">
                      Kết nối ví để ký giao dịch. Ví sẽ mở popup cho bạn xác nhận —
                      website không bao giờ chạm được vào private key.
                    </p>
                    <ConnectWallet />
                  </>
                )}

                <NetworkWarning orderNetwork={order.network} walletNetworkId={walletNetworkId} />

                {payError && <Alert tone="danger">{payError}</Alert>}

                {connected && (
                  <>
                    <Button
                      onClick={pay}
                      loading={busy === "pay"}
                      disabled={busy !== null || !payReady}
                    >
                      {busy === "pay"
                        ? "Đang xử lý…"
                        : payReady
                          ? `Trả ${order.payment!.quantityFormatted} ${order.payment!.symbol}`
                          : "Chọn cách trả ở trên"}
                    </Button>

                    {!order.payment && (
                      <p className="text-xs text-fg-subtle">
                        Chọn ADA hoặc một stablecoin ở khối phía trên, hệ thống sẽ tính số
                        tiền phải trả rồi mở ví để bạn ký.
                      </p>
                    )}
                    {order.payment?.quoteExpired && (
                      <p className="text-xs text-warn-400">
                        Báo giá đã hết hạn — lấy báo giá mới ở khối phía trên trước khi trả.
                      </p>
                    )}
                  </>
                )}

              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function QuotePanel({
  order,
  payment,
  now,
  onRequote,
  requoting,
}: {
  order: Order;
  payment: OrderPayment;
  now: number;
  onRequote: () => void;
  requoting: boolean;
}) {
  const expiresAt = payment.quoteExpiresAt ? new Date(payment.quoteExpiresAt).getTime() : null;
  const secondsLeft = expiresAt === null ? null : Math.max(0, Math.round((expiresAt - now) / 1000));
  const expired = payment.quoteExpired || secondsLeft === 0;

  const cip13 =
    payment.unit === "lovelace" ? cip13PaymentUri(order.merchantAddress, BigInt(payment.quantity)) : null;

  return (
    <Card title="Số tiền phải trả">
      <div className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="font-mono text-3xl font-semibold tabular-nums text-fg sm:text-4xl">
            {payment.quantityFormatted}{" "}
            <span className="text-xl text-brand-300 sm:text-2xl">{payment.symbol}</span>
          </div>
          {secondsLeft !== null && !expired && (
            <Badge tone={secondsLeft < 120 ? "warning" : "neutral"}>
              Khoá giá còn {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, "0")}
            </Badge>
          )}
        </div>

        {payment.adaRateUsd && (
          <p className="text-xs text-fg-subtle">
            Tỷ giá đã khoá: 1 ADA = {payment.adaRateUsd} USD
            {payment.rateSources?.length ? ` · trung vị của ${payment.rateSources.join(", ")}` : ""}
          </p>
        )}

        {!payment.adaRateUsd && (
          <p className="text-xs text-fg-subtle">
            Stablecoin quy ước 1 token = 1 USD nên không có tỷ giá nào để hết hạn.
          </p>
        )}

        {expired && (
          <Alert tone="warning">
            <div>Báo giá đã hết hạn — tỷ giá ADA đã thay đổi.</div>
            <Button variant="secondary" size="sm" className="mt-2" onClick={onRequote} loading={requoting}>
              Lấy báo giá mới
            </Button>
          </Alert>
        )}

        <CopyableField
          label="Địa chỉ nhận"
          value={order.merchantAddress}
          display={truncate(order.merchantAddress, 18, 10)}
        />

        {cip13 && !expired && (
          <div className="flex flex-col gap-4 border-t border-hairline pt-4 sm:flex-row sm:items-center">
            <PaymentQr value={cip13} label="Quét bằng ví hỗ trợ CIP-13" />
            <p className="text-xs leading-relaxed text-fg-subtle">
              Mã này theo chuẩn <strong>CIP-13</strong> và chỉ mô tả được số ADA — nó không mô tả
              được stablecoin, nên chỉ hiện khi bạn chọn trả bằng ADA. Ví không hỗ trợ CIP-13 thì
              cứ trả bằng nút bên dưới.
            </p>
          </div>
        )}
      </div>
    </Card>
  );
}

function ConfirmedPanel({ order, explorer }: { order: Order; explorer: string }) {
  return (
    <Card>
      <div className="motion-safe:animate-rise flex items-start gap-4">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-brand-500/30 bg-brand-500/15">
          <svg className="h-6 w-6 text-brand-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m5 12.5 4.5 4.5L19 7.5" />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-lg font-semibold text-brand-200">Đã thanh toán</div>
          <p className="mt-1 text-sm text-fg-muted">
            {order.payment?.quantityFormatted} {order.payment?.symbol} · {order.tx?.confirmations} xác
            nhận
            {order.confirmedAt ? ` · ${new Date(order.confirmedAt).toLocaleString("vi-VN")}` : ""}
          </p>
          {order.tx && (
            <a
              href={`${explorer}/transaction/${order.tx.hash}`}
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-block font-mono text-xs text-brand-300 underline underline-offset-4"
            >
              {truncate(order.tx.hash, 20, 12)} ↗
            </a>
          )}

          {/* Đơn đến từ một shop thì việc trả tiền chưa phải là hết chuyện — khách còn
              cần thấy đơn hàng của mình. Không có lối về, họ ngồi lại ở trang này và
              không biết món hàng đã được ghi nhận hay chưa.

              KHÔNG tự động chuyển trang: bằng chứng thanh toán (txHash, số xác nhận)
              chỉ có ở đây, và giật khách đi khỏi nó ngay khi vừa xong là cách chắc
              chắn để họ mất thứ duy nhất chứng minh mình đã trả tiền. */}
          {order.returnUrl && (
            <a
              href={order.returnUrl}
              className="mt-4 inline-flex items-center gap-2 rounded-lg border border-brand-500/30 bg-brand-500/10 px-4 py-2 text-sm font-medium text-brand-200 transition hover:bg-brand-500/20"
            >
              Quay lại cửa hàng
              <span aria-hidden>→</span>
            </a>
          )}
        </div>
      </div>
    </Card>
  );
}

type StepState = "done" | "active" | "todo" | "failed";

/**
 * Dòng thời gian của một khoản thanh toán.
 *
 * Trạng thái được suy ra từ HAI nguồn ghép lại: chặng cục bộ ở client (biết sớm nhất,
 * nhưng mất khi tải lại trang) và trạng thái đơn từ server (chậm hơn nhưng bền). Nhờ
 * vậy người dùng thấy phản hồi ngay khi bấm ký, mà tải lại trang giữa chừng vẫn không
 * mất dấu — dòng thời gian dựng lại được từ đơn hàng.
 */
function PaymentProgress({
  order,
  stage,
  submittedTx,
  submittedAt,
  now,
  explorer,
}: {
  order: Order;
  stage: PayStage;
  submittedTx: string | null;
  submittedAt: number | null;
  now: number;
  explorer: string;
}) {
  const txHash = order.tx?.hash ?? submittedTx;
  const confirmations = order.tx?.confirmations ?? 0;

  const inBlock =
    order.status === "confirmed" ||
    order.status === "underpaid" ||
    (order.tx?.blockHeight ?? null) !== null ||
    order.status === "seen";

  const signed = stage === "submitting" || stage === "submitted" || Boolean(txHash);
  const submitted = Boolean(txHash);
  const done = order.status === "confirmed";

  const steps: { key: string; label: string; state: StepState; detail?: React.ReactNode }[] = [
    {
      key: "sign",
      label: "Ký trong ví",
      state: signed ? "done" : stage === "signing" ? "active" : stage === "building" ? "active" : "todo",
      detail:
        stage === "building"
          ? "Đang dựng giao dịch…"
          : stage === "signing"
            ? "Ví đã mở popup — bấm xác nhận trong ví"
            : undefined,
    },
    {
      key: "submit",
      label: "Gửi lên mạng Cardano",
      state: submitted ? "done" : stage === "submitting" ? "active" : "todo",
      detail: txHash ? (
        <a
          href={`${explorer}/transaction/${txHash}`}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-xs text-brand-300 underline underline-offset-4"
        >
          {truncate(txHash, 14, 8)} ↗
        </a>
      ) : undefined,
    },
    {
      key: "block",
      label: "Vào block",
      state: inBlock ? "done" : submitted ? "active" : "todo",
      detail:
        !inBlock && submitted
          ? `Thường mất 20–60 giây${submittedAt ? ` · đã chờ ${Math.round((now - submittedAt) / 1000)}s` : ""}`
          : undefined,
    },
    {
      key: "confirm",
      label: `Đủ ${REQUIRED_CONFIRMATIONS} xác nhận`,
      state: done ? "done" : order.status === "underpaid" ? "failed" : inBlock ? "active" : "todo",
      detail:
        order.status === "underpaid"
          ? "Số tiền nhận được ít hơn yêu cầu"
          : inBlock && !done
            ? `${confirmations}/${REQUIRED_CONFIRMATIONS} — mỗi block khoảng 20 giây`
            : undefined,
    },
  ];

  return (
    <Card title="Tiến trình thanh toán">
      <ol className="space-y-3">
        {steps.map((step) => (
          <li key={step.key} className="flex gap-3">
            <StepMark state={step.state} />
            <div className="min-w-0 flex-1 pt-0.5">
              <div
                className={
                  step.state === "todo"
                    ? "text-sm text-fg-subtle"
                    : step.state === "failed"
                      ? "text-sm font-medium text-warn-400"
                      : "text-sm font-medium text-fg"
                }
              >
                {step.label}
              </div>
              {step.detail && <div className="mt-0.5 text-xs text-fg-muted">{step.detail}</div>}
            </div>
          </li>
        ))}
      </ol>

      {submitted && !done && order.status !== "underpaid" && (
        <p className="mt-4 border-t border-hairline pt-3 text-xs leading-relaxed text-fg-subtle">
          Giao dịch đã nằm trên chain — <strong>bạn có thể đóng trang này</strong>. Đơn vẫn được
          ghi nhận, và không cần trả lại lần nữa.
        </p>
      )}
    </Card>
  );
}

function StepMark({ state }: { state: StepState }) {
  if (state === "done") {
    return (
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-500/20">
        <svg className="h-3 w-3 text-brand-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path d="m5 12.5 4.5 4.5L19 7.5" />
        </svg>
      </span>
    );
  }

  if (state === "failed") {
    return (
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-warn-500/20 text-xs font-bold text-warn-400">
        !
      </span>
    );
  }

  if (state === "active") {
    return (
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
        <Spinner className="h-4 w-4 text-leaf-400" />
      </span>
    );
  }

  return (
    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
      <span className="h-2 w-2 rounded-full bg-hairline-strong" />
    </span>
  );
}

function StatusBadge({ status, confirmations }: { status: Order["status"]; confirmations: number }) {
  switch (status) {
    case "confirmed":
      return <Badge tone="success">Đã thanh toán</Badge>;
    case "seen":
      return <Badge tone="info">Đang xác nhận · {confirmations}</Badge>;
    case "underpaid":
      return <Badge tone="warning">Nhận thiếu</Badge>;
    case "expired":
      return <Badge tone="danger">Hết hạn</Badge>;
    case "failed":
      return <Badge tone="danger">Thất bại</Badge>;
    default:
      return <Badge>Chờ thanh toán</Badge>;
  }
}

function NetworkWarning({
  orderNetwork,
  walletNetworkId,
}: {
  orderNetwork: string;
  walletNetworkId: number | undefined;
}) {
  if (walletNetworkId === undefined) return null;

  const orderIsMainnet = orderNetwork === "mainnet";
  const walletIsMainnet = walletNetworkId === 1;
  if (orderIsMainnet === walletIsMainnet) return null;

  // Gửi nhầm mạng là mất tiền và không lấy lại được — chặn trước khi họ bấm ký.
  return (
    <Alert tone="danger">
      Ví đang ở <strong>{walletIsMainnet ? "Mainnet" : "Testnet"}</strong> nhưng đơn này thuộc{" "}
      <strong>{orderNetwork}</strong>. Đổi mạng trong ví trước khi trả — gửi nhầm mạng là mất tiền.
    </Alert>
  );
}

/**
 * Trình duyệt thường trên điện thoại không có `window.cardano` — CIP-30 chỉ tồn tại
 * trong extension desktop và trong dApp browser tích hợp sẵn của ví mobile.
 * Hiện hướng dẫn cụ thể thay vì để một nút bấm không làm gì cả.
 */
function NoWalletHelp({ orderRef }: { orderRef: string }) {
  const url = typeof window === "undefined" ? "" : `${window.location.origin}/pay/${orderRef}`;

  return (
    <div className="space-y-4">
      <Alert tone="info">Không phát hiện ví Cardano nào trong trình duyệt này.</Alert>
      <div className="space-y-2 text-sm leading-relaxed text-fg-muted">
        <p>
          <strong className="text-fg">Trên máy tính:</strong> cài extension Lace, Eternl,
          Nami, Typhon… rồi tải lại trang.
        </p>
        <p>
          <strong className="text-fg">Trên điện thoại:</strong> mở link này trong{" "}
          <em>dApp browser</em> của ví (Eternl, Vespr, Lace mobile). Trình duyệt thường không truy
          cập được ví.
        </p>
      </div>
      {url && <CopyableField label="Link trang này" value={url} display={truncate(url, 28, 12)} />}
    </div>
  );
}
