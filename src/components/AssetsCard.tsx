"use client";

import { useEffect, useMemo, useState } from "react";
import { useAssets, useNetwork, useWallet } from "@meshsdk/react";
import { Alert, Badge, Card, Spinner } from "./ui";
import {
  colorFromString,
  formatQuantity,
  parseUnit,
  SWATCH_FOREGROUND,
  truncate,
} from "@/lib/format";
import { getNetworkInfo } from "@/lib/network";

type AssetMeta = { unit: string; name?: string; images?: string[]; decimals?: number };

export function AssetsCard() {
  const { connected } = useWallet();
  const assets = useAssets();
  const networkId = useNetwork();
  const network = getNetworkInfo(networkId);

  const [meta, setMeta] = useState<Record<string, AssetMeta>>({});
  const [metaEnabled, setMetaEnabled] = useState<boolean | null>(null);
  /**
   * Gateway đang thử cho từng asset. Gateway IPFS đơn lẻ chỉ tải được ~50% ảnh,
   * nên khi <img> báo lỗi ta tăng chỉ số này để thử gateway kế tiếp. Hết ứng viên
   * thì rơi về placeholder gradient — không bao giờ để ảnh vỡ.
   */
  const [attempt, setAttempt] = useState<Record<string, number>>({});

  /** URL đang dùng cho asset, undefined khi đã thử hết ứng viên. */
  const imageFor = (info: AssetMeta | undefined, unit: string): string | undefined =>
    info?.images?.[attempt[unit] ?? 0];

  const nextGateway = (unit: string) =>
    setAttempt((a) => ({ ...a, [unit]: (a[unit] ?? 0) + 1 }));

  const { nfts, tokens } = useMemo(() => {
    const list = (assets ?? []).filter((a) => a.unit !== "lovelace");
    return {
      // Heuristic chuẩn của Cardano: NFT là asset có tổng cung = 1.
      nfts: list.filter((a) => a.quantity === "1"),
      tokens: list.filter((a) => a.quantity !== "1"),
    };
  }, [assets]);

  // Làm giàu metadata (tên, ảnh, decimals) qua Blockfrost — chỉ chạy nếu server có API key.
  useEffect(() => {
    const units = (assets ?? []).filter((a) => a.unit !== "lovelace").map((a) => a.unit);
    if (units.length === 0 || !network) return;

    let cancelled = false;

    (async () => {
      try {
        const res = await fetch("/api/assets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ units: units.slice(0, 40), networkId: network.id }),
        });

        if (!res.ok) {
          if (!cancelled) setMetaEnabled(false);
          return;
        }

        const data: { enabled: boolean; assets: AssetMeta[] } = await res.json();
        if (cancelled) return;

        setMetaEnabled(data.enabled);
        setMeta(Object.fromEntries(data.assets.map((a) => [a.unit, a])));
      } catch {
        if (!cancelled) setMetaEnabled(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [assets, network]);

  if (!connected) return null;

  const total = nfts.length + tokens.length;

  return (
    <Card
      title="Token & NFT"
      description="Native asset đang có trong ví"
      icon={<StackIcon />}
      action={
        assets === undefined ? (
          <Spinner className="text-fg-subtle" />
        ) : (
          <Badge>{total} asset</Badge>
        )
      }
    >
      {assets === undefined ? (
        <div className="flex items-center gap-2 py-6 text-sm text-fg-muted">
          <Spinner /> Đang đọc asset từ ví…
        </div>
      ) : total === 0 ? (
        <p className="py-6 text-center text-sm text-fg-subtle">
          Ví chưa có native token hay NFT nào ngoài ADA.
        </p>
      ) : (
        <div className="space-y-6">
          {nfts.length > 0 && (
            <div>
              <h3 className="mb-3 text-sm font-medium text-fg">NFT ({nfts.length})</h3>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {nfts.map((asset) => {
                  const parsed = parseUnit(asset.unit);
                  const info = meta[asset.unit];
                  const imageUrl = imageFor(info, asset.unit);
                  return (
                    <div
                      key={asset.unit}
                      className="overflow-hidden rounded-xl border border-hairline bg-ink-950/50"
                    >
                      <div
                        className="flex aspect-square items-center justify-center"
                        style={
                          imageUrl
                            ? undefined
                            : {
                                background: `linear-gradient(135deg, ${colorFromString(
                                  parsed.policyId,
                                )}, ${colorFromString(parsed.assetNameHex || parsed.policyId)})`,
                              }
                        }
                      >
                        {imageUrl ? (
                          // key = URL để đổi gateway thì <img> remount và tải lại
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            key={imageUrl}
                            src={imageUrl}
                            alt={info?.name ?? parsed.displayName}
                            className="h-full w-full object-cover"
                            loading="lazy"
                            onError={() => nextGateway(asset.unit)}
                          />
                        ) : (
                          <span
                            className="px-2 text-center text-2xl font-bold"
                            style={{ color: SWATCH_FOREGROUND }}
                          >
                            {(info?.name ?? parsed.displayName).slice(0, 2).toUpperCase()}
                          </span>
                        )}
                      </div>
                      <div className="p-2.5">
                        <div
                          className="truncate text-sm font-medium text-fg"
                          title={info?.name ?? parsed.displayName}
                        >
                          {info?.name ?? parsed.displayName}
                        </div>
                        <div
                          className="mt-0.5 truncate font-mono text-[11px] text-fg-subtle"
                          title={parsed.policyId}
                        >
                          {truncate(parsed.policyId, 8, 4)}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {tokens.length > 0 && (
            <div>
              <h3 className="mb-3 text-sm font-medium text-fg">
                Fungible token ({tokens.length})
              </h3>
              <ul className="divide-y divide-hairline overflow-hidden rounded-xl border border-hairline">
                {tokens.map((asset) => {
                  const parsed = parseUnit(asset.unit);
                  const info = meta[asset.unit];
                  const tokenImage = imageFor(info, asset.unit);
                  return (
                    <li
                      key={asset.unit}
                      className="flex items-center gap-3 bg-ink-950/50 px-3.5 py-3"
                    >
                      {tokenImage ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          key={tokenImage}
                          src={tokenImage}
                          alt=""
                          className="h-9 w-9 shrink-0 rounded-full object-cover"
                          loading="lazy"
                          onError={() => nextGateway(asset.unit)}
                        />
                      ) : (
                        <div
                          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold"
                          style={{
                            background: colorFromString(parsed.policyId),
                            color: SWATCH_FOREGROUND,
                          }}
                        >
                          {(info?.name ?? parsed.displayName).slice(0, 2).toUpperCase()}
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-fg">
                          {info?.name ?? parsed.displayName}
                        </div>
                        <div
                          className="truncate font-mono text-[11px] text-fg-subtle"
                          title={parsed.policyId}
                        >
                          {truncate(parsed.policyId, 10, 6)}
                        </div>
                      </div>
                      <div className="shrink-0 font-mono text-sm tabular-nums text-fg">
                        {formatQuantity(asset.quantity, info?.decimals ?? 0)}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {metaEnabled === false && (
            <Alert tone="info">
              <div className="font-medium">Vì sao NFT không có hình ảnh?</div>
              <p className="mt-1 opacity-90">
                Ví CIP-30 chỉ trả về <strong>mã asset và số lượng</strong> — trong ví không có
                tên hay ảnh. Muốn có ảnh phải hỏi một chain indexer.
              </p>
              <p className="mt-2 opacity-90">
                Server chưa cấu hình <code className="font-mono">BLOCKFROST_API_KEY</code>, nên
                app đang hiện placeholder sinh từ policy ID. Lấy key miễn phí tại{" "}
                <a
                  href="https://blockfrost.io"
                  target="_blank"
                  rel="noreferrer"
                  className="underline underline-offset-2"
                >
                  blockfrost.io
                </a>
                , thêm vào <code className="font-mono">.env.local</code> rồi khởi động lại server:
              </p>
              <pre className="mt-2 overflow-x-auto rounded-lg bg-ink-950/70 px-3 py-2 font-mono text-[11px]">
                BLOCKFROST_API_KEY=preprod...
              </pre>
              <p className="mt-2 text-xs opacity-80">
                Network suy ra từ prefix của key: <code className="font-mono">mainnet…</code> /{" "}
                <code className="font-mono">preprod…</code> /{" "}
                <code className="font-mono">preview…</code>
              </p>
            </Alert>
          )}
        </div>
      )}
    </Card>
  );
}

function StackIcon() {
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
      <path d="m12 3 9 4.5-9 4.5-9-4.5L12 3Z" />
      <path d="m3 12 9 4.5 9-4.5" />
      <path d="m3 16.5 9 4.5 9-4.5" />
    </svg>
  );
}
