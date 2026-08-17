import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Hạ tầng tối giản cho luồng "đăng nhập bằng ví" (Sign-In With Cardano).
 *
 * LƯU Ý CHO PRODUCTION: nonce ở đây lưu trong RAM của tiến trình, sẽ mất khi
 * restart và không chia sẻ được giữa nhiều instance. Thực tế hãy thay bằng
 * Redis/DB có TTL. Phần ký & xác minh chữ ký thì đã đúng chuẩn.
 */

const NONCE_TTL_MS = 5 * 60 * 1000; // 5 phút
export const SESSION_COOKIE = "cardano_session";
export const SESSION_TTL_SECONDS = 60 * 60; // 1 giờ

type NonceEntry = { nonce: string; expiresAt: number };

const nonceStore = new Map<string, NonceEntry>();

function pruneExpired() {
  const now = Date.now();
  for (const [key, entry] of nonceStore) {
    if (entry.expiresAt <= now) nonceStore.delete(key);
  }
}

export function saveNonce(address: string, nonce: string) {
  pruneExpired();
  nonceStore.set(address, { nonce, expiresAt: Date.now() + NONCE_TTL_MS });
}

/** Lấy nonce ra và xoá ngay — nonce chỉ dùng được một lần (chống replay). */
export function consumeNonce(address: string): string | null {
  pruneExpired();
  const entry = nonceStore.get(address);
  if (!entry) return null;
  nonceStore.delete(address);
  return entry.expiresAt > Date.now() ? entry.nonce : null;
}

/**
 * Địa chỉ hợp lệ để đăng nhập: stake address (ưu tiên, định danh ổn định) hoặc
 * payment address (fallback cho ví không ký được bằng stake key).
 */
export function isValidLoginAddress(value: unknown): value is string {
  return typeof value === "string" && /^(stake|addr)(_test)?1[02-9ac-hj-np-z]{20,}$/.test(value);
}

/* ------------------------------------------------------------------ */
/* Session cookie: payload.signature (HMAC-SHA256)                     */
/* ------------------------------------------------------------------ */

const DEV_SECRET = randomBytes(32).toString("hex");

/**
 * Kiểm tra cấu hình khoá session. Trả về thông báo lỗi nếu thiếu, null nếu ổn.
 *
 * Tách riêng khỏi getSecret() để route có thể trả về JSON 500 rõ ràng thay vì
 * ném lỗi giữa chừng — throw ở đây làm handler chết với body rỗng, và client chỉ
 * thấy "Unexpected end of JSON input", cực kỳ khó lần ra nguyên nhân.
 */
export function getSessionSecretError(): string | null {
  const secret = process.env.SESSION_SECRET;
  if (secret && secret.length >= 16) return null;

  if (process.env.NODE_ENV !== "production") return null; // dev dùng khoá tạm

  return (
    "Server thiếu biến môi trường SESSION_SECRET (tối thiểu 16 ký tự). " +
    'Sinh khoá: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
  );
}

function getSecret(): string | null {
  const secret = process.env.SESSION_SECRET;
  if (secret && secret.length >= 16) return secret;

  // Chỉ dùng khi dev: mỗi lần restart sẽ vô hiệu hoá session cũ.
  return process.env.NODE_ENV === "production" ? null : DEV_SECRET;
}

export type Session = {
  /** Địa chỉ đã được xác minh — stake address nếu ví hỗ trợ, ngược lại payment address. */
  address: string;
  /** true nếu định danh là stake address (ổn định hơn payment address). */
  isStakeAddress: boolean;
  issuedAt: number;
  expiresAt: number;
};

/** Trả về null nếu server chưa cấu hình SESSION_SECRET (chỉ xảy ra ở production). */
export function createSessionToken(address: string): string | null {
  const secret = getSecret();
  if (!secret) return null;

  const now = Date.now();
  const session: Session = {
    address,
    isStakeAddress: address.startsWith("stake"),
    issuedAt: now,
    expiresAt: now + SESSION_TTL_SECONDS * 1000,
  };

  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");

  return `${payload}.${signature}`;
}

export function readSessionToken(token: string | undefined): Session | null {
  if (!token) return null;

  const secret = getSecret();
  if (!secret) return null; // thiếu cấu hình => coi như chưa đăng nhập, không ném lỗi

  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;

  const expected = createHmac("sha256", secret).update(payload).digest("base64url");

  // So sánh chống timing attack; độ dài khác nhau thì loại luôn.
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString()) as Session;
    return session.expiresAt > Date.now() ? session : null;
  } catch {
    return null;
  }
}
