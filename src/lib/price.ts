import "server-only";

import { cacheGetJson, cacheSetJson, isRedisConfigured } from "@/lib/redis";
import {
  ADA_USD_SOURCES,
  aggregateRates,
  type Aggregated,
  DEFAULT_PEG_MAX_DEVIATION_BPS,
  evaluatePeg,
  parseRateToMicro,
  type PegStatus,
  type SourceQuote,
} from "@/lib/price-sources";
import type { CardanoNetwork } from "@/lib/network";
import { getStablecoins, type PayToken } from "@/lib/stablecoins";

/**
 * Lấy tỷ giá ADA/USD và kiểm tra peg của stablecoin.
 *
 * Phần thuần (parser từng sàn, trung vị, ngưỡng lệch) nằm ở price-sources.ts và
 * được test riêng. File này chỉ lo gọi mạng, cache, và ghép lại.
 */

/**
 * Cache 30 giây.
 *
 * Đủ ngắn để giá không lỗi thời trong một luồng checkout, đủ dài để không đốt hạn
 * mức của CoinGecko free (~30 request/phút, dùng chung cho cả server).
 */
const RATE_CACHE_SECONDS = 30;
const PEG_CACHE_SECONDS = 60;

const RATE_CACHE_KEY = "price:ada-usd:v1";
const PEG_CACHE_KEY = "price:peg:v1";

/** Nguồn giá chậm không được phép treo cả request tạo đơn. */
const SOURCE_TIMEOUT_MS = 4_000;

export type AdaRate = {
  /** micro-USD cho 1 ADA. */
  rate: bigint;
  sources: string[];
  spreadBps: number;
  /** Thời điểm lấy giá (ms). Cache trả về giá cũ tối đa 30 giây. */
  fetchedAt: number;
  cached: boolean;
};

export type AdaRateResult =
  | { ok: true; value: AdaRate }
  | { ok: false; error: string; sources: string[]; rejected: SourceQuote[] };

/* ------------------------------------------------------------------ */

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
      // Không để lớp cache của Next giữ giá — vòng đời cache do Redis quyết định,
      // để mọi instance cùng nhìn thấy một mức giá.
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Hỏi cả ba nguồn song song. Nguồn nào hỏng thì ghi lại lý do chứ không ném lỗi. */
async function collectQuotes(): Promise<SourceQuote[]> {
  return Promise.all(
    ADA_USD_SOURCES.map(async (source): Promise<SourceQuote> => {
      try {
        const rate = source.parse(await fetchJson(source.url));
        return rate === null
          ? { name: source.name, rate: null, error: "response không đúng hình dạng mong đợi" }
          : { name: source.name, rate };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          name: source.name,
          rate: null,
          error: message === "This operation was aborted" ? `quá ${SOURCE_TIMEOUT_MS}ms` : message,
        };
      }
    }),
  );
}

type CachedRate = { rate: string; sources: string[]; spreadBps: number; fetchedAt: number };

/**
 * Tỷ giá ADA/USD hiện tại.
 *
 * FAIL-CLOSED: dưới 2 nguồn đồng ý, hoặc các nguồn lệch nhau quá 3%, thì trả về lỗi
 * chứ không đoán. Hệ quả là không tạo được ĐƠN MỚI trả bằng ADA — đơn đã khoá giá
 * vẫn thanh toán và xác minh bình thường, vì tỷ giá của chúng nằm trong DB rồi.
 */
export async function getAdaUsdRate(): Promise<AdaRateResult> {
  if (isRedisConfigured()) {
    const cached = await cacheGetJson<CachedRate>(RATE_CACHE_KEY);
    if (cached) {
      return {
        ok: true,
        value: {
          rate: BigInt(cached.rate),
          sources: cached.sources,
          spreadBps: cached.spreadBps,
          fetchedAt: cached.fetchedAt,
          cached: true,
        },
      };
    }
  }

  const quotes = await collectQuotes();
  const aggregated: Aggregated = aggregateRates(quotes);

  if (!aggregated.ok) {
    return {
      ok: false,
      error: aggregated.error,
      sources: aggregated.sources,
      rejected: aggregated.rejected,
    };
  }

  const value: AdaRate = {
    rate: aggregated.rate,
    sources: aggregated.sources,
    spreadBps: aggregated.spreadBps,
    fetchedAt: Date.now(),
    cached: false,
  };

  if (isRedisConfigured()) {
    // bigint không JSON hoá được — lưu dạng chuỗi rồi dựng lại bằng BigInt.
    await cacheSetJson(
      RATE_CACHE_KEY,
      {
        rate: value.rate.toString(),
        sources: value.sources,
        spreadBps: value.spreadBps,
        fetchedAt: value.fetchedAt,
      } satisfies CachedRate,
      RATE_CACHE_SECONDS,
    );
  }

  return { ok: true, value };
}

/* ------------------------------------------------------------------ */
/* Peg                                                                 */
/* ------------------------------------------------------------------ */

export type TokenPeg = {
  symbol: string;
  unit: string;
  status: PegStatus;
  /** false khi lệch peg — checkout phải ẩn token này đi. */
  acceptable: boolean;
};

function pegMaxDeviationBps(): number {
  const raw = process.env.PAYMENT_PEG_MAX_DEVIATION_BPS?.trim();
  if (!raw) return DEFAULT_PEG_MAX_DEVIATION_BPS;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 5_000) {
    console.warn(`[price] PAYMENT_PEG_MAX_DEVIATION_BPS="${raw}" không hợp lệ, dùng mặc định.`);
    return DEFAULT_PEG_MAX_DEVIATION_BPS;
  }
  return value;
}

/**
 * Giá USD của các stablecoin, lấy một lần cho tất cả id trong cùng một request.
 *
 * Chỉ CoinGecko có iUSD/DJED/USDA — Kraken và Coinbase không niêm yết. Nên phần peg
 * chỉ có MỘT nguồn, khác hẳn tỷ giá ADA vốn có ba. Đó là lý do lệch peg chỉ **tắt
 * token khỏi checkout** chứ không được dùng làm căn cứ tính tiền.
 */
async function fetchPegPrices(ids: readonly string[]): Promise<Map<string, bigint | null>> {
  const result = new Map<string, bigint | null>();
  if (ids.length === 0) return result;

  const url =
    "https://api.coingecko.com/api/v3/simple/price?vs_currencies=usd&precision=8&ids=" +
    encodeURIComponent(ids.join(","));

  try {
    const json = (await fetchJson(url)) as Record<string, { usd?: unknown }> | null;
    for (const id of ids) {
      result.set(id, json && json[id] ? parseRateToMicro(json[id]!.usd) : null);
    }
  } catch {
    // Nguồn peg chết thì mọi token thành "chưa kiểm chứng được" — KHÔNG mặc định
    // coi là đạt peg, và cũng không chặn thanh toán.
    for (const id of ids) result.set(id, null);
  }

  return result;
}

type CachedPeg = Record<string, string | null>;

export async function getPegStatuses(network: CardanoNetwork): Promise<TokenPeg[]> {
  const tokens: PayToken[] = getStablecoins(network).filter((token) => token.pegged);
  if (tokens.length === 0) return [];

  const ids = [...new Set(tokens.map((t) => t.coingeckoId).filter((id): id is string => Boolean(id)))];

  let prices: Map<string, bigint | null>;

  const cached = isRedisConfigured() ? await cacheGetJson<CachedPeg>(PEG_CACHE_KEY) : null;
  if (cached && ids.every((id) => id in cached)) {
    prices = new Map(ids.map((id) => [id, cached[id] === null ? null : BigInt(cached[id]!)]));
  } else {
    prices = await fetchPegPrices(ids);
    if (isRedisConfigured()) {
      const payload: CachedPeg = {};
      for (const [id, price] of prices) payload[id] = price === null ? null : price.toString();
      await cacheSetJson(PEG_CACHE_KEY, payload, PEG_CACHE_SECONDS);
    }
  }

  const maxDeviation = pegMaxDeviationBps();

  return tokens.map((token) => {
    const status = token.coingeckoId
      ? evaluatePeg(prices.get(token.coingeckoId) ?? null, maxDeviation, "nguồn giá không trả về token này")
      : evaluatePeg(null, maxDeviation, "token chưa có id CoinGecko trong registry");

    return {
      symbol: token.symbol,
      unit: token.unit,
      status,
      // "unknown" vẫn cho thanh toán: token thử trên testnet không bao giờ có giá,
      // và chặn vì thiếu dữ liệu thì tính năng không dùng được. Chỉ "depegged" —
      // tức có bằng chứng rõ ràng là lệch — mới tắt token.
      acceptable: status.state !== "depegged",
    };
  });
}
