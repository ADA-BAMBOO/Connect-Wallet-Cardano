import "server-only";

import { randomUUID } from "node:crypto";
import Redis from "ioredis";

/**
 * Redis cho phần thanh toán. Ba việc, không hơn:
 *
 *   1. Cache tỷ giá ADA/USD (TTL ngắn) — tránh đốt rate limit của nguồn giá.
 *   2. Khoá phân tán khi watcher xử lý một đơn — nhiều instance không giẫm chân nhau.
 *   3. Nonce store cho luồng đăng nhập (thay Map trong RAM ở auth-server.ts).
 *
 * Redis KHÔNG giữ đơn hàng. Đơn hàng là dữ liệu tài chính, thuộc về Postgres.
 */

const globalForRedis = globalThis as unknown as { __paymentRedis?: Redis };

export function isRedisConfigured(): boolean {
  return Boolean(process.env.REDIS_URL?.trim());
}

export function getRedis(): Redis {
  const url = process.env.REDIS_URL?.trim();

  if (!url) {
    throw new Error(
      "Thiếu REDIS_URL. Chạy Redis bằng `docker compose up -d` rồi đặt REDIS_URL " +
        "trong .env.local — xem .env.example.",
    );
  }

  if (!globalForRedis.__paymentRedis) {
    const client = new Redis(url, {
      // Không nối máy ngay lúc import module — `next build` cũng nạp module này,
      // và một build không được phép cần Redis sống mới chạy được.
      lazyConnect: true,

      // Mặc định ioredis thử lại KHÔNG GIỚI HẠN. Với request HTTP thì đó là treo
      // vô hạn thay vì báo lỗi: thà hỏng nhanh và nói rõ Redis không truy cập được.
      maxRetriesPerRequest: 2,
      connectTimeout: 5_000,
      retryStrategy: (times) => (times > 5 ? null : Math.min(times * 200, 2_000)),
    });

    // ioredis phát 'error' khi mất kết nối. Không có listener thì Node sập tiến trình.
    client.on("error", (err: Error) => {
      console.error("[redis] lỗi kết nối:", err.message);
    });

    globalForRedis.__paymentRedis = client;
  }

  return globalForRedis.__paymentRedis;
}

/* ------------------------------------------------------------------ */
/* Cache JSON                                                          */
/* ------------------------------------------------------------------ */

export async function cacheGetJson<T>(key: string): Promise<T | null> {
  try {
    const raw = await getRedis().get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch (error) {
    // Cache hỏng không được phép làm hỏng request — coi như cache miss.
    console.error("[redis] đọc cache thất bại:", error);
    return null;
  }
}

export async function cacheSetJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  try {
    await getRedis().set(key, JSON.stringify(value), "EX", ttlSeconds);
  } catch (error) {
    console.error("[redis] ghi cache thất bại:", error);
  }
}

/* ------------------------------------------------------------------ */
/* Khoá phân tán                                                       */
/* ------------------------------------------------------------------ */

/** Chỉ xoá khoá nếu token còn khớp — tránh xoá nhầm khoá mà instance khác vừa giành được. */
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

/**
 * Chạy `fn` khi giành được khoá; không giành được thì trả về null ngay (không chờ).
 *
 * ĐÂY LÀ KHOÁ TƯ VẤN, KHÔNG PHẢI ĐẢM BẢO. Nếu `fn` chạy lâu hơn `ttlMs`, khoá tự hết
 * hạn và một instance khác có thể vào cùng lúc. Nó chỉ để giảm việc trùng lặp, còn
 * thứ thật sự ngăn double-credit là ràng buộc UNIQUE(tx_hash) trong Postgres.
 * Đừng bao giờ dùng khoá này thay cho ràng buộc ở tầng dữ liệu.
 */
export async function withLock<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<T | null> {
  const redis = getRedis();
  const token = randomUUID();

  const acquired = await redis.set(key, token, "PX", ttlMs, "NX");
  if (acquired !== "OK") return null;

  try {
    return await fn();
  } finally {
    try {
      await redis.eval(RELEASE_SCRIPT, 1, key, token);
    } catch (error) {
      // Không nhả được thì khoá tự hết hạn sau ttlMs — không chặn vĩnh viễn.
      console.error("[redis] nhả khoá thất bại:", error);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Health                                                              */
/* ------------------------------------------------------------------ */

export async function checkRedis(): Promise<{ ok: boolean; detail: string }> {
  if (!isRedisConfigured()) return { ok: false, detail: "Chưa đặt REDIS_URL." };

  try {
    const client = getRedis();
    if (client.status === "wait" || client.status === "end") await client.connect();

    const started = Date.now();
    const pong = await client.ping();
    return { ok: pong === "PONG", detail: `${pong} (${Date.now() - started}ms)` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}
