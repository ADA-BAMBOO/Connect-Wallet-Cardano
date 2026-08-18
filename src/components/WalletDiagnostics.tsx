"use client";

import { useState } from "react";
import { Alert, Badge, Button, Card } from "./ui";
import { describeError, readJsonResponse, walletErrorCode } from "@/lib/errors";
import { truncate } from "@/lib/format";

/**
 * Công cụ chẩn đoán ví, chia làm hai pha để tránh "popup fatigue".
 *
 * Pha 1 (tự động, KHÔNG popup): dò ví, enable, networkId, và lấy từng loại địa chỉ
 * — báo nguyên nhân thật khi không lấy được, không im lặng bỏ qua.
 *
 * Pha 2 (bấm từng nút): thử ký. Mỗi lần ký là một popup, nên để người dùng chủ động
 * chọn thay vì bắn 3 popup liên tiếp — bắn liên tiếp khiến người ta bấm huỷ và kết
 * quả trở thành vô nghĩa.
 *
 * Quan trọng: pha 2 thử CẢ HAI đường đi để khoanh vùng lỗi:
 *   - "CIP-30 thô": gọi thẳng api.signData của extension
 *   - "qua Mesh":   gọi BrowserWallet.signData — đúng đường mà form đăng nhập dùng
 * Nếu thô OK mà Mesh FAIL thì lỗi ở lớp Mesh, không phải ở ví.
 */

type AddrInfo = { label: string; hex?: string; bech32Hint?: string; error?: string };

type WalletInfo = {
  name: string;
  enabled: boolean;
  enableError?: string;
  hasSignData: boolean;
  networkId?: number;
  networkError?: string;
  addresses: AddrInfo[];
};

type SignResult = {
  key: string;
  path: "raw" | "mesh" | "login";
  label: string;
  ok: boolean;
  detail: string;
  code?: number | null;
};

type CardanoApi = Record<string, unknown>;

/**
 * Địa chỉ CIP-30 là hex; Mesh nhận bech32. Dùng đúng cặp hàm mà chính
 * `BrowserWallet.getRewardAddresses` dùng nội bộ để chuyển đổi.
 */
async function hexToBech32(addrHex: string): Promise<string> {
  const { deserializeAddress, addressToBech32 } = await import("@meshsdk/core-cst");
  return addressToBech32(deserializeAddress(addrHex));
}

export function WalletDiagnostics() {
  const [scanning, setScanning] = useState(false);
  const [wallets, setWallets] = useState<WalletInfo[] | null>(null);
  const [results, setResults] = useState<SignResult[]>([]);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function scan() {
    setScanning(true);
    setResults([]);

    const injected =
      (window as unknown as { cardano?: Record<string, unknown> }).cardano ?? {};

    const names = Object.keys(injected).filter(
      (k) => typeof (injected[k] as { enable?: unknown })?.enable === "function",
    );

    const infos: WalletInfo[] = [];

    for (const name of names) {
      const entry = injected[name] as { enable: () => Promise<CardanoApi> };
      const info: WalletInfo = { name, enabled: false, hasSignData: false, addresses: [] };

      let api: CardanoApi;
      try {
        api = await entry.enable();
        info.enabled = true;
      } catch (err) {
        info.enableError = `${describeError(err)}${
          walletErrorCode(err) != null ? ` (code=${walletErrorCode(err)})` : ""
        }`;
        infos.push(info);
        continue;
      }

      info.hasSignData = typeof api.signData === "function";

      try {
        info.networkId =
          (await (api.getNetworkId as (this: CardanoApi) => Promise<number>).call(api)) ??
          undefined;
      } catch (err) {
        info.networkError = describeError(err);
      }

      // Lấy địa chỉ và GIỮ LẠI lỗi — đây là chỗ bản trước đã im lặng bỏ qua.
      const probes: Array<[string, string, (v: unknown) => string | undefined]> = [
        ["stake (reward)", "getRewardAddresses", (v) => (Array.isArray(v) ? (v[0] as string) : undefined)],
        ["change (payment)", "getChangeAddress", (v) => v as string],
        ["used (payment)", "getUsedAddresses", (v) => (Array.isArray(v) ? (v[0] as string) : undefined)],
        ["unused (payment)", "getUnusedAddresses", (v) => (Array.isArray(v) ? (v[0] as string) : undefined)],
      ];

      for (const [label, method, pick] of probes) {
        const fn = api[method];
        if (typeof fn !== "function") {
          info.addresses.push({ label, error: `ví không có hàm ${method}()` });
          continue;
        }
        try {
          // PHẢI gọi qua .call(api) để giữ `this`. Lấy hàm ra biến rồi gọi rời sẽ
          // ném TypeError với ví cài đặt API bằng class method — bản trước của
          // công cụ này mắc đúng lỗi đó và làm Lace trông như "không có địa chỉ".
          const raw = await (fn as (this: CardanoApi) => Promise<unknown>).call(api);
          const hex = pick(raw);
          if (!hex) {
            info.addresses.push({
              label,
              error: `${method}() trả về ${Array.isArray(raw) ? `mảng rỗng (${raw.length} phần tử)` : JSON.stringify(raw)}`,
            });
          } else {
            info.addresses.push({ label, hex });
          }
        } catch (err) {
          info.addresses.push({
            label,
            error: `${method}() lỗi: ${describeError(err)}${
              walletErrorCode(err) != null ? ` (code=${walletErrorCode(err)})` : ""
            }`,
          });
        }
      }

      infos.push(info);
    }

    setWallets(infos);
    setScanning(false);
  }

  /** Ký thử qua một đường cụ thể để khoanh vùng lỗi. */
  async function trySign(
    walletName: string,
    addrLabel: string,
    addrHex: string,
    path: "raw" | "mesh",
  ) {
    const key = `${walletName}:${addrLabel}:${path}`;
    setBusyKey(key);

    // Payload giống hệt luồng đăng nhập: 30 byte ASCII in được.
    const payloadHex = Array.from("Login diagnosticprobe0000001x")
      .map((c) => c.charCodeAt(0).toString(16).padStart(2, "0"))
      .join("");

    try {
      if (path === "raw") {
        const injected = (window as unknown as { cardano: Record<string, unknown> }).cardano;
        const api = await (
          injected[walletName] as { enable: () => Promise<CardanoApi> }
        ).enable();
        // .call(api) để giữ `this` — xem chú thích ở hàm scan().
        await (
          api.signData as (this: CardanoApi, a: string, p: string) => Promise<unknown>
        ).call(api, addrHex, payloadHex);
      } else {
        // Đúng đường mà form đăng nhập dùng.
        const { BrowserWallet } = await import("@meshsdk/core");
        const wallet = await BrowserWallet.enable(walletName);
        await wallet.signData(payloadHex, await hexToBech32(addrHex));
      }

      setResults((r) => [
        ...r,
        { key, path, label: `${walletName} · ${addrLabel} · ${path === "raw" ? "CIP-30 thô" : "qua Mesh"}`, ok: true, detail: "ký thành công" },
      ]);
    } catch (err) {
      setResults((r) => [
        ...r,
        {
          key,
          path,
          label: `${walletName} · ${addrLabel} · ${path === "raw" ? "CIP-30 thô" : "qua Mesh"}`,
          ok: false,
          detail: describeError(err),
          code: walletErrorCode(err),
        },
      ]);
    } finally {
      setBusyKey(null);
    }
  }

  /** Chạy trọn luồng đăng nhập thật (gồm cả xác minh phía server). */
  async function tryFullLogin(walletName: string, addrHex: string, addrLabel: string) {
    const key = `${walletName}:${addrLabel}:login`;
    setBusyKey(key);

    try {
      const { BrowserWallet } = await import("@meshsdk/core");
      const wallet = await BrowserWallet.enable(walletName);
      const bech32 = await hexToBech32(addrHex);

      const nonceRes = await fetch("/api/auth/nonce", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: bech32 }),
      });
      const noncePayload = await readJsonResponse<{ nonce: string; error?: string }>(nonceRes);
      if (!("nonce" in noncePayload)) throw new Error(noncePayload.error ?? "không lấy được nonce");

      const signature = await wallet.signData(noncePayload.nonce, bech32);

      const verifyRes = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: bech32, signature }),
      });
      const verifyPayload = await readJsonResponse<{ error?: string }>(verifyRes);
      if (!verifyRes.ok) throw new Error(verifyPayload.error ?? "verify thất bại");

      setResults((r) => [
        ...r,
        { key, path: "login", label: `${walletName} · ${addrLabel} · ĐĂNG NHẬP TRỌN LUỒNG`, ok: true, detail: "thành công, server đã xác minh chữ ký" },
      ]);
    } catch (err) {
      setResults((r) => [
        ...r,
        {
          key,
          path: "login",
          label: `${walletName} · ${addrLabel} · ĐĂNG NHẬP TRỌN LUỒNG`,
          ok: false,
          detail: describeError(err),
          code: walletErrorCode(err),
        },
      ]);
    } finally {
      setBusyKey(null);
    }
  }

  const report = buildReport(wallets, results);

  return (
    <Card
      title="Chẩn đoán ví"
      description="Khoanh vùng lỗi: ví, lớp Mesh, hay server"
      icon={<StethoscopeIcon />}
    >
      <div className="space-y-5">
        <Alert tone="info">
          <strong>Bước 1</strong> chỉ đọc thông tin, không mở popup nào. Sau đó bạn tự chọn từng
          phép ký ở <strong>bước 2</strong> — mỗi phép ký là một popup, làm từng cái để kết quả
          đáng tin (bấm huỷ vì mỏi tay sẽ cho số liệu sai).
        </Alert>

        <Button onClick={scan} loading={scanning} variant="secondary">
          {scanning ? "Đang dò…" : "Bước 1 — Dò ví (không popup)"}
        </Button>

        {wallets?.map((w) => (
          <div key={w.name} className="rounded-xl border border-hairline bg-ink-950/50 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold capitalize text-fg">{w.name}</span>
              {w.enabled ? <Badge tone="success">enable OK</Badge> : <Badge tone="danger">enable FAIL</Badge>}
              {w.enabled && (
                <Badge tone={w.hasSignData ? "success" : "danger"}>
                  {w.hasSignData ? "có signData" : "không có signData"}
                </Badge>
              )}
              {w.networkId !== undefined && (
                <Badge tone="info">network {w.networkId === 1 ? "mainnet" : "testnet"} ({w.networkId})</Badge>
              )}
              {w.networkError && <Badge tone="danger">networkId lỗi</Badge>}
            </div>

            {w.enableError && (
              <p className="mt-2 text-sm text-danger-400">enable(): {w.enableError}</p>
            )}

            {w.enabled && (
              <ul className="mt-3 space-y-2">
                {w.addresses.map((a) => (
                  <li key={a.label} className="rounded-lg bg-surface px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-fg">{a.label}</span>
                      {a.hex ? (
                        <code className="font-mono text-[11px] text-fg-subtle">
                          {truncate(a.hex, 14, 8)}
                        </code>
                      ) : (
                        <span className="text-xs text-danger-400">{a.error}</span>
                      )}
                    </div>

                    {a.hex && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={busyKey === `${w.name}:${a.label}:raw`}
                          onClick={() => trySign(w.name, a.label, a.hex!, "raw")}
                        >
                          Ký · CIP-30 thô
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={busyKey === `${w.name}:${a.label}:mesh`}
                          onClick={() => trySign(w.name, a.label, a.hex!, "mesh")}
                        >
                          Ký · qua Mesh
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={busyKey === `${w.name}:${a.label}:login`}
                          onClick={() => tryFullLogin(w.name, a.hex!, a.label)}
                        >
                          Đăng nhập trọn luồng
                        </Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}

        {results.length > 0 && (
          <div className="space-y-3">
            <h3 className="text-sm font-medium text-fg">Kết quả ký</h3>
            <ul className="divide-y divide-hairline overflow-hidden rounded-xl border border-hairline">
              {results.map((r, i) => (
                <li key={i} className="flex items-start gap-3 bg-ink-950/50 px-3.5 py-2.5">
                  <span
                    className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold ${
                      r.ok ? "bg-brand-500/20 text-brand-300" : "bg-danger-500/20 text-danger-400"
                    }`}
                  >
                    {r.ok ? "OK" : "FAIL"}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-fg">{r.label}</div>
                    <div className="break-words text-xs text-fg-muted">
                      {r.detail}
                      {r.code != null && (
                        <span className="ml-1 font-mono text-fg-subtle">(code={r.code})</span>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {(wallets || results.length > 0) && (
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(report);
                setCopied(true);
                setTimeout(() => setCopied(false), 1600);
              } catch {
                /* clipboard cần HTTPS hoặc localhost */
              }
            }}
          >
            {copied ? "Đã sao chép" : "Sao chép toàn bộ kết quả"}
          </Button>
        )}
      </div>
    </Card>
  );
}

function buildReport(wallets: WalletInfo[] | null, results: SignResult[]): string {
  const lines: string[] = [];

  for (const w of wallets ?? []) {
    lines.push(`## ${w.name}`);
    lines.push(`  enable: ${w.enabled ? "OK" : `FAIL — ${w.enableError}`}`);
    if (w.enabled) {
      lines.push(`  signData: ${w.hasSignData ? "có" : "KHÔNG"}`);
      lines.push(`  networkId: ${w.networkId ?? `lỗi — ${w.networkError}`}`);
      for (const a of w.addresses) {
        lines.push(`  ${a.label}: ${a.hex ? a.hex : `KHÔNG CÓ — ${a.error}`}`);
      }
    }
  }

  if (results.length > 0) {
    lines.push("", "## Kết quả ký");
    for (const r of results) {
      lines.push(`  [${r.ok ? "OK" : "FAIL"}] ${r.label}: ${r.detail}${r.code != null ? ` (code=${r.code})` : ""}`);
    }
  }

  return lines.join("\n");
}

function StethoscopeIcon() {
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
      <path d="M4 3v6a5 5 0 0 0 10 0V3" />
      <path d="M4 3H2.5M14 3h1.5" />
      <path d="M9 14v2a5 5 0 0 0 10 0v-1" />
      <circle cx="19" cy="13" r="2" />
    </svg>
  );
}
