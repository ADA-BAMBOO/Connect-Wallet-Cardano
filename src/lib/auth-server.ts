import "server-only";

import { createHmac, randomBytes } from "node:crypto";

import { safeEqual } from "@/lib/constant-time";
import { getRedis, isRedisConfigured } from "@/lib/redis";

/**
 * Hạ tầng cho luồng "đăng nhập bằng ví" (Sign-In With Cardano).
 */

const NONCE_TTL_MS = 5 * 60 * 1000; // 5 phút
export const SESSION_COOKIE = "cardano_session";
export const SESSION_TTL_SECONDS = 60 * 60; // 1 giờ

const nonceKey = (address: string) => `auth:nonce:${address}`;

/* ------------------------------------------------------------------ */
/* Nonce store                                                         */
/* ------------------------------------------------------------------ */

/**
 * Dự phòng khi chưa cấu hình Redis — hoặc khi Redis được cấu hình nhưng chết.
 *
 * Nonce nằm trong RAM của tiến trình thì mất sau mỗi lần restart và không chia sẻ
 * được giữa nhiều instance — sau load balancer, người dùng xin nonce ở instance A
 * rồi gửi chữ ký tới instance B sẽ luôn bị từ chối. Chấp nhận được khi chạy một
 * tiến trình lúc dev; production hãy đặt REDIS_URL.
 *
 * Treo trên globalThis chứ không để `const` trần ở module scope: `next dev` nạp
 * lại module sau mỗi lần HMR, và một Map trần sẽ bị thay mới — nonce vừa ghi ở
 * request trước biến mất. Đúng cái pattern mà lib/redis.ts dùng cho client Redis.
 */
type NonceEntry = { nonce: string; expiresAt: number };

const globalForNonce = globalThis as unknown as { __authNonceStore?: Map<string, NonceEntry> };
const memoryStore = (globalForNonce.__authNonceStore ??= new Map<string, NonceEntry>());

function pruneExpired() {
  const now = Date.now();
  for (const [key, entry] of memoryStore) {
    if (entry.expiresAt <= now) memoryStore.delete(key);
  }
}

function saveNonceToMemory(address: string, nonce: string): void {
  pruneExpired();
  memoryStore.set(address, { nonce, expiresAt: Date.now() + NONCE_TTL_MS });
}

/** Đọc-và-xoá trong RAM. Xoá vô điều kiện: nonce dùng một lần, kể cả khi đã hết hạn. */
function consumeNonceFromMemory(address: string): string | null {
  pruneExpired();
  const entry = memoryStore.get(address);
  if (!entry) return null;
  memoryStore.delete(address);
  return entry.expiresAt > Date.now() ? entry.nonce : null;
}

export async function saveNonce(address: string, nonce: string): Promise<void> {
  if (isRedisConfigured()) {
    try {
      await getRedis().set(nonceKey(address), nonce, "PX", NONCE_TTL_MS);
      return;
    } catch (error) {
      // Redis chết thì rơi về RAM: thà đăng nhập được trên một instance còn hơn
      // hỏng hẳn. Việc chống replay vẫn nguyên vẹn vì nonce vẫn dùng một lần.
      console.error("[auth] không ghi được nonce vào Redis, dùng bộ nhớ tiến trình:", error);
    }
  }

  saveNonceToMemory(address, nonce);
}

/**
 * Lấy nonce ra và xoá ngay — nonce chỉ dùng được MỘT LẦN (chống replay).
 *
 * Trên Redis dùng GETDEL để đọc và xoá trong một thao tác nguyên tử. Nếu tách làm
 * GET rồi DEL, hai request đồng thời đều đọc được cùng một nonce trước khi nó bị
 * xoá — và thế là chống replay không còn tác dụng.
 *
 * PHẢI đối xứng với saveNonce. Trước đây nhánh Redis lỗi trả thẳng null với lý do
 * "nonce đã ghi vào Redis thì không có trong RAM" — lý do đó sai đúng ở trường hợp
 * hay xảy ra nhất: Redis chết thì saveNonce đã rơi về RAM, nên nonce nằm trong RAM
 * thật. Kết quả là đăng nhập luôn hỏng với thông báo "Nonce đã hết hạn hoặc không
 * tồn tại" trong khi nonce vẫn còn nguyên và hạn còn dài (REDIS_URL trỏ tới một
 * Redis không chạy là đủ để dính).
 *
 * Tra RAM cả khi Redis *đọc được nhưng không thấy*: Redis có thể vừa sống lại giữa
 * lúc xin nonce và lúc gửi chữ ký, khi đó nonce nằm ở RAM chứ không ở Redis.
 *
 * Không nới lỏng bảo mật: RAM chỉ có nonce do chính server ghi vào, và đọc là xoá
 * nên vẫn đúng một lần. Một nonce chỉ tồn tại ở MỘT nơi, không có đường phục sinh
 * nonce đã tiêu.
 */
export async function consumeNonce(address: string): Promise<string | null> {
  if (isRedisConfigured()) {
    try {
      const fromRedis = await getRedis().getdel(nonceKey(address));
      if (fromRedis) return fromRedis;
    } catch (error) {
      console.error("[auth] không đọc được nonce từ Redis, thử bộ nhớ tiến trình:", error);
    }
  }

  return consumeNonceFromMemory(address);
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
  if (!safeEqual(signature, expected)) return null;

  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString()) as Session;
    return session.expiresAt > Date.now() ? session : null;
  } catch {
    return null;
  }
}
