"use client";

import { useCallback, useEffect, useState } from "react";
import { useWallet } from "@meshsdk/react";
import { Alert, Badge, Button, Card, CopyableField } from "./ui";
import { truncate } from "@/lib/format";
import {
  describeError,
  isDataSigningUnsupported,
  isUserDeclined,
  readJsonResponse,
} from "@/lib/errors";
import { useDict } from "@/lib/i18n/client";

type Session = {
  authenticated: boolean;
  address?: string;
  isStakeAddress?: boolean;
  expiresAt?: number;
};

export function SignInCard() {
  const { wallet, connected } = useWallet();
  const t = useDict();

  const [session, setSession] = useState<Session | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Ví báo không hỗ trợ ký dữ liệu — cần hướng dẫn riêng, không phải lỗi để retry. */
  const [unsupported, setUnsupported] = useState<string | null>(null);

  const refreshSession = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/me", { cache: "no-store" });
      const data = await readJsonResponse<Session>(res);
      return "authenticated" in data ? data : ({ authenticated: false } as Session);
    } catch {
      return { authenticated: false } as Session;
    }
  }, []);

  // Đọc session hiện có khi mount. setState nằm sau `await` nên không gây
  // cascading render đồng bộ; cờ `cancelled` chặn cập nhật sau khi unmount.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const next = await refreshSession();
      if (!cancelled) setSession(next);
    })();

    return () => {
      cancelled = true;
    };
  }, [refreshSession]);

  async function signIn() {
    if (!wallet) return;

    setBusy(true);
    setError(null);
    setUnsupported(null);

    try {
      // 1. Ưu tiên địa chỉ stake làm định danh — nó không đổi theo từng giao dịch.
      //    Đa số ví CIP-30 ký được bằng stake key, nhưng không phải tất cả, nên
      //    giữ sẵn payment address để fallback.
      const [stakeAddress] = await wallet.getRewardAddresses();
      const changeAddress = await wallet.getChangeAddress();

      const candidates = [stakeAddress, changeAddress].filter(
        (a): a is string => typeof a === "string" && a.length > 0,
      );
      if (candidates.length === 0) throw new Error(t.signIn.noAddress);

      let lastError: unknown = null;

      for (const address of candidates) {
        try {
          // 2. Xin nonce từ server. Nonce chỉ dùng một lần, hết hạn sau 5 phút.
          const nonceRes = await fetch("/api/auth/nonce", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ address }),
          });
          const noncePayload = await readJsonResponse<{ nonce: string; error?: string }>(nonceRes);
          if (!nonceRes.ok || !("nonce" in noncePayload)) {
            throw new Error(noncePayload.error ?? t.signIn.nonceFailed);
          }

          // 3. Ví mở popup cho người dùng ký. Đây là thao tác OFF-CHAIN:
          //    không tốn phí, không tạo giao dịch, không đụng tới tiền trong ví.
          const signature = await wallet.signData(noncePayload.nonce, address);

          // 4. Server xác minh chữ ký gắn với đúng address rồi cấp session cookie.
          const verifyRes = await fetch("/api/auth/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ address, signature }),
          });
          const verifyPayload = await readJsonResponse<{ error?: string }>(verifyRes);
          if (!verifyRes.ok) throw new Error(verifyPayload.error ?? t.signIn.verifyFailed);

          lastError = null;
          break;
        } catch (err) {
          lastError = err;

          // CHỈ dừng sớm khi người dùng chủ động huỷ. Với mọi lỗi khác vẫn thử nốt
          // địa chỉ còn lại.
          //
          // Đừng suy diễn từ thông điệp lỗi rằng "cả ví không ký được nên thử tiếp
          // là vô ích": một số ví (Eternl) trả về đúng câu đó khi chỉ riêng *stake
          // address* không ký được, trong khi payment address vẫn ký bình thường.
          // Dừng sớm ở đó là tự tay chặn mất fallback đang chạy được.
          // Chi phí thử tiếp chỉ là một popup; chi phí đoán sai là hỏng đăng nhập.
          // Ví ném object CIP-30 `{code, info}`, không phải Error — xem lib/errors.ts.
          if (isUserDeclined(err, "data")) throw err;
        }
      }

      if (lastError) throw lastError;

      setSession(await refreshSession());
    } catch (err) {
      if (isUserDeclined(err, "data")) {
        setError(t.signIn.declined);
      } else if (isDataSigningUnsupported(err)) {
        setUnsupported(describeError(err));
      } else {
        setError(describeError(err));
      }
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      setSession(await refreshSession());
    } finally {
      setBusy(false);
    }
  }

  const authenticated = session?.authenticated === true;

  return (
    <Card
      title={t.signIn.title}
      description={t.signIn.description}
      icon={<KeyIcon />}
      action={
        authenticated ? (
          <Badge tone="success">{t.signIn.authenticated}</Badge>
        ) : (
          <Badge>{t.signIn.notAuthenticated}</Badge>
        )
      }
    >
      <div className="space-y-4">
        {authenticated ? (
          <>
            <Alert tone="success">
              {t.signIn.sessionGranted}
            </Alert>
            <CopyableField
              label={
                session?.isStakeAddress
                  ? t.signIn.identityStake
                  : t.signIn.identityPayment
              }
              value={session?.address ?? ""}
              display={truncate(session?.address, 16, 10)}
            />
            {session?.expiresAt && (
              <p className="text-xs text-fg-subtle">
                {t.signIn.expiresAt(new Date(session.expiresAt).toLocaleString(t.dateLocale))}
              </p>
            )}
            <Button variant="secondary" onClick={signOut} loading={busy}>
              {t.signIn.signOut}
            </Button>
          </>
        ) : (
          <>
            <ol className="space-y-2 text-sm text-fg-muted">
              <Step n={1}>{t.signIn.step1}</Step>
              <Step n={2}>{t.signIn.step2}</Step>
              <Step n={3}>{t.signIn.step3}</Step>
            </ol>

            {error && <Alert tone="danger">{error}</Alert>}

            {unsupported && (
              <Alert tone="warning">
                <div className="font-medium">{t.signIn.unsupportedTitle}</div>
                <p className="mt-1 opacity-90">
                  <em>{t.signIn.unsupportedSays(unsupported)}</em>
                </p>
                <p className="mt-2">
                  {t.signIn.unsupportedBody1}{" "}
                  <code className="font-mono">unsupportedWalletType</code>{" "}
                  {t.signIn.unsupportedBody2}
                </p>
                <p className="mt-2 text-xs opacity-90">
                  {t.signIn.unsupportedTypes}
                </p>
                <p className="mt-2 text-xs opacity-90">
                  {t.signIn.unsupportedDiagnose1} <strong>{t.diagnostics.title}</strong>{" "}
                  {t.signIn.unsupportedDiagnose2}
                </p>
                <p className="mt-2 text-xs opacity-90">
                  {t.signIn.unsupportedOthers}
                </p>
              </Alert>
            )}

            <Button onClick={signIn} disabled={!connected} loading={busy}>
              {busy ? t.signIn.waitingSignature : t.signIn.signToLogin}
            </Button>
          </>
        )}
      </div>
    </Card>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-brand-500/30 bg-brand-500/15 text-[11px] font-semibold tabular-nums text-brand-300">
        {n}
      </span>
      <span>{children}</span>
    </li>
  );
}

function KeyIcon() {
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
      <circle cx="8" cy="12" r="4" />
      <path d="M12 12h9M18 12v3M15.5 12v2" />
    </svg>
  );
}
