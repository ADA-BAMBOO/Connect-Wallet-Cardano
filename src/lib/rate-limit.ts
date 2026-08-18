import "server-only";

import { clientIpFromForwarded, MAX_PROXY_HOPS, parseProxyHops } from "@/lib/client-ip";
import { getRedis, isRedisConfigured } from "@/lib/redis";

/**
 * Giới hạn tần suất, cửa sổ trượt thô (fixed window).
 *
 * `POST /api/payments/orders` và `POST /api/payments/orders/[ref]/submit` đều là
 * endpoint công khai: một cái ghi vào database, cái kia đốt hạn mức Blockfrost. Không
 * giới hạn thì một vòng lặp curl là đủ.
 *
 * FAIL-OPEN, ngược với tầng giá.
 * Redis chết thì cho qua chứ không chặn. Giới hạn tần suất là biện pháp giảm lạm dụng,
 * không phải chốt chặn đúng/sai; chặn hết khi Redis nấc một cái là tự tay làm sập API
 * của mình. Tầng giá thì ngược lại — ở đó sai một cái là mất tiền, nên fail-closed.
 *
 * Nhưng "fail-open" không có nghĩa là "không đếm gì cả": khi Redis vắng mặt, bộ đếm
 * trong RAM tiến trình vẫn chạy (xem `memoryHit`). Nó không chia sẻ được giữa nhiều
 * instance nên yếu hơn hẳn, song vẫn chặn đúng kịch bản đáng lo nhất — một client lặp
 * request vào một tiến trình.
 */

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  /** Số giây còn lại của cửa sổ hiện tại. */
  resetIn: number;
};

/* ------------------------------------------------------------------ */
/* Dự phòng trong RAM khi không có Redis                               */
/* ------------------------------------------------------------------ */

type MemoryEntry = { count: number; resetAt: number };
const memoryBuckets = new Map<string, MemoryEntry>();

/** Dọn định kỳ để Map không phình theo số key đã hết hạn. */
function pruneMemory(now: number) {
  if (memoryBuckets.size < 10_000) return;
  for (const [key, entry] of memoryBuckets) {
    if (entry.resetAt <= now) memoryBuckets.delete(key);
  }
}

function memoryHit(key: string, limit: number, windowSeconds: number): RateLimitResult {
  const now = Date.now();
  pruneMemory(now);

  const existing = memoryBuckets.get(key);
  const entry =
    existing && existing.resetAt > now
      ? existing
      : { count: 0, resetAt: now + windowSeconds * 1_000 };

  entry.count++;
  memoryBuckets.set(key, entry);

  return {
    allowed: entry.count <= limit,
    remaining: Math.max(0, limit - entry.count),
    resetIn: Math.max(0, Math.ceil((entry.resetAt - now) / 1_000)),
  };
}

/* ------------------------------------------------------------------ */

export async function checkRateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  if (!isRedisConfigured()) return memoryHit(key, limit, windowSeconds);

  try {
    const redis = getRedis();
    const bucket = Math.floor(Date.now() / 1000 / windowSeconds);
    const redisKey = `ratelimit:${key}:${bucket}`;

    // INCR rồi EXPIRE trong một lượt: gộp pipeline để khỏi mất một vòng mạng, và để
    // không có khe hở nào key bị tạo mà quên đặt hạn (khe đó làm key sống mãi).
    const [[, count]] = (await redis
      .multi()
      .incr(redisKey)
      .expire(redisKey, windowSeconds)
      .exec()) as [[Error | null, number], [Error | null, number]];

    const used = Number(count);
    return {
      allowed: used <= limit,
      remaining: Math.max(0, limit - used),
      resetIn: (bucket + 1) * windowSeconds - Math.floor(Date.now() / 1000),
    };
  } catch (error) {
    // Redis hỏng thì rơi về bộ đếm trong RAM, không phải cho qua vô điều kiện.
    console.error("[rate-limit] Redis lỗi, dùng bộ đếm trong RAM:", error);
    return memoryHit(key, limit, windowSeconds);
  }
}

/* ------------------------------------------------------------------ */
/* Định danh người gọi                                                 */
/* ------------------------------------------------------------------ */

const HOPS_ENV = "TRUSTED_PROXY_HOPS";

/**
 * Số proxy tin cậy đứng trước ứng dụng. 0 = không có (mặc định).
 *
 * PHẢI khai báo tường minh, không đoán. `x-forwarded-for` là header do CLIENT gửi được;
 * thứ duy nhất khiến nó đáng tin là biết chắc có bao nhiêu proxy phía trước đã ghi đè
 * lên nó. Không biết con số đó thì không có cách nào phân biệt phần proxy ghi với phần
 * client bịa ra.
 */
function trustedProxyHops(): number {
  const raw = process.env[HOPS_ENV];
  const parsed = parseProxyHops(raw);

  if (parsed === null) {
    console.warn(`[rate-limit] ${HOPS_ENV}="${raw}" không hợp lệ (0..${MAX_PROXY_HOPS}), coi như 0.`);
    return 0;
  }
  return parsed;
}

export function isProxyTrustConfigured(): boolean {
  return trustedProxyHops() > 0;
}

export function proxyTrustHops(): number {
  return trustedProxyHops();
}

/**
 * Định danh người gọi để tính hạn mức.
 *
 * `x-forwarded-for` là một DANH SÁCH `client, proxy1, proxy2…`, mỗi proxy nối thêm địa
 * chỉ mà chính nó nhìn thấy vào CUỐI. Nên với `n` proxy tin cậy, IP thật nằm ở
 * `chain[chain.length - n]` — mọi thứ bên trái đó đều do client tự viết.
 *
 * Lấy phần tử ĐẦU (cách viết phổ biến) chỉ đúng khi có đúng một proxy và client không
 * gửi sẵn header. Client gửi `x-forwarded-for: <ngẫu nhiên>` mỗi request là mỗi request
 * một bucket, và hạn mức biến mất hoàn toàn.
 *
 * Chưa khai `TRUSTED_PROXY_HOPS` thì không định danh nổi ai: trả về khoá chung có tiền
 * tố `untrusted:` để `guardRequest` biết mà bật thêm hạn mức tổng.
 */
export function clientKey(request: Request): string {
  const hops = trustedProxyHops();
  const forwarded = request.headers.get("x-forwarded-for");

  if (hops > 0) {
    const ip = clientIpFromForwarded(forwarded, hops);
    if (ip) return ip;

    // Không đọc được: chuỗi ngắn hơn số hop đã khai (cấu hình sai, hoặc có người cắt
    // header), hoặc proxy không ghi `x-forwarded-for` mà chỉ ghi `x-real-ip`.
    if (forwarded) return "malformed-xff";
    return request.headers.get("x-real-ip")?.trim() || "unknown";
  }

  return forwarded ? `untrusted:${forwarded.split(",")[0]!.trim()}` : "untrusted:unknown";
}

/* ------------------------------------------------------------------ */
/* Hàng rào hai tầng                                                   */
/* ------------------------------------------------------------------ */

/**
 * Hạn mức tổng của endpoint = hạn mức mỗi client × số này.
 *
 * Chỉ bật khi chưa khai `TRUSTED_PROXY_HOPS`, tức lúc `clientKey` không đáng tin. Kẻ
 * tấn công lách được tầng một bằng header giả vẫn đâm vào tầng hai, còn lưu lượng thật
 * thì gần như không bao giờ chạm tới nó.
 */
const UNTRUSTED_GLOBAL_MULTIPLIER = 20;

/**
 * Kiểm hạn mức cho một request. Trả về kết quả đầu tiên bị chặn, hoặc kết quả của
 * tầng client nếu qua hết.
 *
 * `scope` là tên endpoint ("orders:create"), dùng để các endpoint không dùng chung bucket.
 */
export async function guardRequest(
  request: Request,
  scope: string,
  perClientLimit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const perClient = await checkRateLimit(
    `${scope}:${clientKey(request)}`,
    perClientLimit,
    windowSeconds,
  );
  if (!perClient.allowed) return perClient;

  if (isProxyTrustConfigured()) return perClient;

  return checkRateLimit(
    `${scope}:__all__`,
    perClientLimit * UNTRUSTED_GLOBAL_MULTIPLIER,
    windowSeconds,
  );
}
