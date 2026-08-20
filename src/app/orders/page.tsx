import Link from "next/link";

import { OrdersRefresher } from "@/components/OrdersRefresher";
import { checkAdmin, isAdminAllowlistConfigured } from "@/lib/admin";
import { formatAmount, USD_DECIMALS } from "@/lib/money";
import { cardanoTxUrl, type CardanoNetwork, isCardanoNetwork } from "@/lib/network";
import { getOrderStats, listOrders, type OrderStatus } from "@/lib/orders";
import { truncate } from "@/lib/format";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { getDictionary } from "@/lib/i18n/server";

/**
 * Sổ đơn hàng — trang đối soát cho người bán.
 *
 * Server component: dữ liệu lấy thẳng từ database, không đi vòng qua HTTP. Trang này
 * để lộ toàn bộ số tiền và địa chỉ nên bị khoá sau quyền quản trị — xem lib/admin.ts.
 */

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await getDictionary();
  return { title: t.meta.ordersTitle, robots: { index: false, follow: false } };
}

/*
 * `seen` và `confirmed` đều là xanh lá thương hiệu nên phải khác nhau ở chỗ khác
 * ngoài màu: `dot` cho sắc độ chấm, và nhãn chữ vẫn là thứ đọc được đầu tiên.
 *
 * Chỉ còn giữ MÀU. Nhãn nằm ở `t.status[...]` vì nó phải đổi theo ngôn ngữ, mà bảng
 * này là hằng số ở module scope — không đọc được cookie của request.
 */
const STATUS_STYLE: Record<OrderStatus, { className: string; dot: string }> = {
  pending: {
    className: "bg-white/[0.06] text-fg-muted border-hairline",
    dot: "bg-fg-subtle",
  },
  seen: {
    className: "bg-leaf-500/12 text-leaf-300 border-leaf-500/30",
    dot: "bg-leaf-400 motion-safe:animate-pulse",
  },
  confirmed: {
    className: "bg-brand-500/15 text-brand-300 border-brand-500/35",
    dot: "bg-brand-400",
  },
  underpaid: {
    className: "bg-warn-500/15 text-warn-400 border-warn-500/35",
    dot: "bg-warn-400",
  },
  expired: {
    className: "bg-white/[0.04] text-fg-subtle border-hairline",
    dot: "bg-fg-subtle/60",
  },
  failed: {
    className: "bg-danger-500/15 text-danger-400 border-danger-500/35",
    dot: "bg-danger-400",
  },
};

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ network?: string; limit?: string }>;
}) {
  const t = await getDictionary();
  const admin = await checkAdmin();

  if (!admin.ok) {
    // Trang bị khoá không phải là "lỗi" với người dùng — nó là một trạng thái có
    // lối ra. Đưa luôn nút đi tiếp thay vì để họ tự tìm đường về trang chủ.
    return (
      <Shell>
        <div className="mx-auto max-w-md py-16 text-center">
          <div
            className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border
              border-hairline bg-surface-2 text-fg-muted"
          >
            <svg
              className="h-6 w-6"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <rect x="4" y="10.5" width="16" height="10" rx="2.5" />
              <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
            </svg>
          </div>

          <h1 className="mt-5 text-xl font-semibold text-fg">{t.orders.lockedTitle}</h1>
          <p className="mt-2 text-sm leading-relaxed text-fg-muted">{admin.error}</p>

          {admin.status === 401 && (
            <Link
              href="/"
              className="mt-6 inline-flex min-h-11 cursor-pointer items-center justify-center rounded-xl
                bg-leaf-500 px-4 text-sm font-medium text-ink-950 transition-colors duration-150
                hover:bg-leaf-400"
            >
              {t.orders.loginAtHome}
            </Link>
          )}
        </div>
      </Shell>
    );
  }

  const params = await searchParams;
  const network: CardanoNetwork | undefined = isCardanoNetwork(params.network)
    ? params.network
    : undefined;
  const limit = Math.min(Math.max(Number(params.limit ?? 50) || 50, 1), 200);

  const [orders, stats] = await Promise.all([
    listOrders({ network, limit }),
    getOrderStats(network),
  ]);

  return (
    <Shell>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-fg">{t.orders.title}</h1>
          <p className="mt-1 text-sm text-fg-muted">
            {t.orders.subtitle(
              network ? t.orders.networkScope(network) : t.orders.allNetworks,
              stats.total,
            )}
          </p>
        </div>
        <OrdersRefresher />
      </div>

      {/*
        Chế độ mở của dev phải nói rõ ra. Không có cảnh báo này thì rất dễ deploy lên
        production mà tưởng trang đã được bảo vệ sẵn.
      */}
      {!isAdminAllowlistConfigured() && (
        <div className="mb-6 flex gap-3 rounded-xl border border-warn-500/35 bg-warn-500/10 px-3.5 py-3 text-sm text-warn-400">
          {/* Icon đi kèm màu: cảnh báo không được chỉ phân biệt bằng sắc độ. */}
          <svg
            className="mt-0.5 h-4 w-4 shrink-0"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M12 8v5M12 16.5v.01M10.3 3.9 2.6 17.1A2 2 0 0 0 4.3 20h15.4a2 2 0 0 0 1.7-2.9L13.7 3.9a2 2 0 0 0-3.4 0Z" />
          </svg>
          <div>
          {t.orders.openWarning1} <strong>{t.orders.openWarning2}</strong> {t.orders.openWarning3}{" "}
          <code className="font-mono">PAYMENT_ADMIN_ADDRESSES</code>
          {t.orders.openWarning4}
          </div>
        </div>
      )}

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Stat
          label={t.orders.statCollected}
          value={`${formatAmount(stats.confirmedUsd, USD_DECIMALS)} USD`}
          tone="brand"
        />
        <Stat
          label={t.orders.statPending}
          value={`${formatAmount(stats.pendingUsd, USD_DECIMALS)} USD`}
          tone="leaf"
        />
        <Stat
          label={t.orders.statManual}
          value={t.orders.statManualValue(stats.byStatus.underpaid ?? 0)}
          tone={stats.byStatus.underpaid ? "warn" : "muted"}
        />
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        <FilterLink href="/orders" active={!network}>
          {t.orders.filterAll}
        </FilterLink>
        {(["mainnet", "preprod", "preview"] as const).map((item) => (
          <FilterLink key={item} href={`/orders?network=${item}`} active={network === item}>
            {item}
          </FilterLink>
        ))}
      </div>

      {orders.length === 0 ? (
        <div className="rounded-2xl border border-hairline bg-surface/70 px-4 py-14 text-center text-sm text-fg-subtle">
          {t.orders.empty1}{" "}
          <Link href="/" className="text-brand-300 underline underline-offset-4">
            {t.orders.empty2}
          </Link>
          .
        </div>
      ) : (
        // Bảng rộng phải cuộn ngang trong khung của nó, không đẩy cả trang tràn ra.
        <div className="overflow-x-auto rounded-2xl border border-hairline bg-surface/60 backdrop-blur-sm">
          <table className="w-full min-w-[52rem] text-left text-sm">
            <thead className="border-b border-hairline bg-surface-2/70 text-xs uppercase tracking-wide text-fg-subtle">
              <tr>
                <th className="px-4 py-3 font-medium">{t.orders.colRef}</th>
                <th className="px-4 py-3 font-medium">{t.orders.colAmount}</th>
                <th className="px-4 py-3 font-medium">{t.orders.colToken}</th>
                <th className="px-4 py-3 font-medium">{t.orders.colStatus}</th>
                <th className="px-4 py-3 font-medium">{t.orders.colTx}</th>
                <th className="px-4 py-3 font-medium">{t.orders.colCreated}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {orders.map((order) => {
                const style = STATUS_STYLE[order.status];
                return (
                  <tr key={order.id} className="transition-colors duration-150 hover:bg-white/[0.03]">
                    <td className="px-4 py-3">
                      <Link
                        href={`/pay/${order.ref}`}
                        className="font-mono text-brand-300 underline-offset-4 hover:underline"
                      >
                        {order.ref}
                      </Link>
                      {order.description && (
                        <div className="mt-0.5 max-w-[16rem] truncate text-xs text-fg-subtle">
                          {order.description}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap tabular-nums text-fg">
                      {formatAmount(order.amountUsd, USD_DECIMALS)} USD
                      <div className="text-xs text-fg-subtle">{order.network}</div>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {order.paySymbol ? (
                        <>
                          <div className="text-fg">{order.paySymbol}</div>
                          {order.payQuantity !== null && order.payDecimals !== null && (
                            <div className="text-xs text-fg-subtle">
                              {formatAmount(order.payQuantity, order.payDecimals)}
                            </div>
                          )}
                        </>
                      ) : (
                        <span className="text-fg-subtle">{t.orders.noToken}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span
                        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${style.className}`}
                      >
                        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${style.dot}`} />
                        {t.status[order.status]}
                      </span>
                      {order.status === "seen" && (
                        <div className="mt-1 text-xs text-fg-subtle">
                          {t.orders.confirmations(order.confirmations)}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {order.txHash ? (
                        <a
                          href={cardanoTxUrl(order.network, order.txHash)}
                          target="_blank"
                          rel="noreferrer"
                          className="font-mono text-xs text-brand-300 underline-offset-4 hover:underline"
                        >
                          {truncate(order.txHash, 10, 6)} ↗
                        </a>
                      ) : (
                        <span className="text-fg-subtle">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-xs text-fg-subtle">
                      {order.createdAt.toLocaleString(t.dateLocale)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {orders.length === limit && (
        <p className="mt-3 text-xs text-fg-subtle">
          {t.orders.showing(limit)}{" "}
          <Link
            href={`/orders?${network ? `network=${network}&` : ""}limit=200`}
            className="text-brand-300 underline underline-offset-4"
          >
            {t.orders.show200}
          </Link>
        </p>
      )}
    </Shell>
  );
}

/* ------------------------------------------------------------------ */

async function Shell({ children }: { children: React.ReactNode }) {
  // Nền trang trí nằm ở root layout (components/Ambient).
  const t = await getDictionary();

  return (
    <>
      <header className="sticky top-0 z-40 border-b border-hairline bg-canvas/70 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-3">
          <Link
            href="/"
            className="inline-flex min-h-11 items-center gap-2 rounded-lg pr-2 text-sm font-medium
              text-fg-muted transition-colors duration-150 hover:text-fg"
          >
            <svg
              className="h-4 w-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M15 5l-7 7 7 7" />
            </svg>
            {t.shell.brand}
          </Link>
          <LanguageSwitcher />
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">
        {children}
      </main>
    </>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "brand" | "leaf" | "warn" | "muted";
}) {
  const tones = {
    brand: "text-brand-300",
    leaf: "text-leaf-300",
    warn: "text-warn-400",
    muted: "text-fg-muted",
  } as const;

  return (
    <div className="rounded-2xl border border-hairline bg-surface/80 px-4 py-3.5 backdrop-blur-sm">
      <div className="text-xs font-medium uppercase tracking-wide text-fg-subtle">{label}</div>
      {/* tabular-nums: số không co giãn khi trang tự làm mới mỗi 10s */}
      <div className={`mt-1 text-xl font-semibold tabular-nums ${tones[tone]}`}>{value}</div>
    </div>
  );
}

function FilterLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`inline-flex min-h-10 items-center rounded-lg border px-3.5 text-sm
        transition-colors duration-150 ${
          active
            ? "border-brand-500/60 bg-brand-500/15 font-medium text-brand-300"
            : "border-hairline bg-surface/70 text-fg-muted hover:border-hairline-strong hover:text-fg"
        }`}
    >
      {children}
    </Link>
  );
}
