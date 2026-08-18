/**
 * Nguồn giá và phép gộp — phần THUẦN, không gọi mạng.
 *
 * Tách ra khỏi price.ts để test được bằng dữ liệu mẫu. Parser của từng sàn chính là
 * thứ hỏng âm thầm nhất: API đổi hình dạng response một chút là giá trả về `null`
 * hoặc tệ hơn là một số vô nghĩa, mà không có gì báo.
 *
 * Không import gì để script kiểm thử nạp thẳng file này được.
 */

/** Tỷ giá lưu dạng micro-USD cho 1 ADA — cùng thang với money.ts. */
export const RATE_DECIMALS = 6;

/**
 * Chặn trên/dưới cho tỷ giá ADA/USD.
 *
 * Không phải để dự đoán thị trường mà để bắt rác: nguồn trả về 0, trả về giá của
 * tài sản khác (BTC ~100.000 USD), hay trả về chuỗi lỗi parse ra số lạ.
 */
export const RATE_SANITY_MIN = 100n; // 0.0001 USD
export const RATE_SANITY_MAX = 1_000_000_000n; // 1.000 USD

/** Cần ít nhất bấy nhiêu nguồn đồng ý thì mới dám báo giá. */
export const MIN_SOURCES = 2;

/** Các nguồn lệch nhau quá ngưỡng này thì coi như có nguồn hỏng — từ chối báo giá. */
export const MAX_SPREAD_BPS = 300; // 3%

/**
 * Đổi giá dạng thập phân sang micro-USD, KHÔNG đi qua phép tính dấu phẩy động.
 *
 * Nhận `number` vì CoinGecko trả JSON number (`0.17304511`) chứ không phải chuỗi.
 * `String(n)` trong JS cho ra chuỗi ngắn nhất round-trip đúng lại số đó, nên chữ số
 * thập phân gốc được giữ nguyên vẹn; từ đó trở đi mọi phép tính đều là số nguyên.
 *
 * Phần lẻ vượt 6 chữ số bị CẮT chứ không làm tròn. Sai số dưới 1e-6 USD/ADA, và cắt
 * làm tỷ giá thấp đi một chút, tức người trả trả nhiều ADA hơn một chút — lệch về
 * phía an toàn cho merchant.
 */
export function parseRateToMicro(value: unknown): bigint | null {
  let text: string;

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    text = String(value);
  } else if (typeof value === "string") {
    text = value.trim();
  } else {
    return null;
  }

  // Cố tình từ chối ký hiệu mũ ("1e-7"): giá thật không bao giờ ở dạng đó, còn thứ
  // đến ở dạng đó thì gần như chắc chắn là rác.
  if (!/^\d+(\.\d+)?$/.test(text)) return null;

  const [whole, fraction = ""] = text.split(".");
  const scaled =
    BigInt(whole) * 10n ** BigInt(RATE_DECIMALS) +
    BigInt(fraction.padEnd(RATE_DECIMALS, "0").slice(0, RATE_DECIMALS) || "0");

  return scaled;
}

export function isSaneRate(rate: bigint): boolean {
  return rate >= RATE_SANITY_MIN && rate <= RATE_SANITY_MAX;
}

/** Trung vị. Số lượng chẵn thì lấy trung bình hai giá trị giữa (làm tròn xuống). */
export function median(values: readonly bigint[]): bigint {
  if (values.length === 0) throw new RangeError("Không có giá trị nào để lấy trung vị.");

  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = sorted.length >> 1;

  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2n;
}

/** Độ lệch giữa nguồn cao nhất và thấp nhất, tính theo basis point của trung vị. */
export function spreadBps(values: readonly bigint[]): number {
  if (values.length < 2) return 0;

  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const low = sorted[0]!;
  const high = sorted[sorted.length - 1]!;
  const mid = median(sorted);
  if (mid <= 0n) return Number.MAX_SAFE_INTEGER;

  return Number(((high - low) * 10_000n) / mid);
}

/* ------------------------------------------------------------------ */
/* Định nghĩa nguồn                                                    */
/* ------------------------------------------------------------------ */

export type RateSource = {
  name: string;
  url: string;
  /** Bóc tỷ giá ra khỏi response. Trả null nếu hình dạng không như mong đợi. */
  parse: (json: unknown) => bigint | null;
};

type Json = Record<string, unknown>;

const asObject = (value: unknown): Json | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;

/**
 * Ba nguồn độc lập nhau về hạ tầng lẫn cách lấy giá: một trang tổng hợp và hai sàn.
 * Cùng chết một lúc là chuyện khó xảy ra, và nếu một nguồn báo sai thì trung vị của
 * ba giá trị sẽ bỏ qua nó.
 */
export const ADA_USD_SOURCES: readonly RateSource[] = [
  {
    name: "coingecko",
    url: "https://api.coingecko.com/api/v3/simple/price?ids=cardano&vs_currencies=usd&precision=8",
    // {"cardano":{"usd":0.17304511}}
    parse: (json) => {
      const cardano = asObject(asObject(json)?.cardano);
      return cardano ? parseRateToMicro(cardano.usd) : null;
    },
  },
  {
    name: "kraken",
    url: "https://api.kraken.com/0/public/Ticker?pair=ADAUSD",
    // {"error":[],"result":{"ADAUSD":{"c":["0.172912","1445.8"],…}}}
    // `c` là giao dịch khớp gần nhất: [giá, khối lượng].
    parse: (json) => {
      const root = asObject(json);
      if (Array.isArray(root?.error) && root.error.length > 0) return null;

      const result = asObject(root?.result);
      if (!result) return null;

      // Kraken có lúc trả về "ADAUSD", có lúc trả tên chuẩn hoá khác — lấy cặp đầu
      // tiên thay vì phụ thuộc vào đúng một khoá.
      const first = asObject(Object.values(result)[0]);
      const last = first?.c;
      return Array.isArray(last) ? parseRateToMicro(last[0]) : null;
    },
  },
  {
    name: "coinbase",
    url: "https://api.coinbase.com/v2/prices/ADA-USD/spot",
    // {"data":{"amount":"0.17293","base":"ADA","currency":"USD"}}
    parse: (json) => {
      const data = asObject(asObject(json)?.data);
      if (!data) return null;
      // Bảo đảm đúng cặp tiền — đề phòng đổi endpoint mà quên đổi mã tiền tệ.
      if (data.currency !== undefined && data.currency !== "USD") return null;
      return parseRateToMicro(data.amount);
    },
  },
];

/* ------------------------------------------------------------------ */
/* Gộp kết quả                                                         */
/* ------------------------------------------------------------------ */

export type SourceQuote = { name: string; rate: bigint | null; error?: string };

export type Aggregated =
  | { ok: true; rate: bigint; sources: string[]; spreadBps: number; rejected: SourceQuote[] }
  | { ok: false; error: string; sources: string[]; rejected: SourceQuote[] };

/**
 * Gộp báo giá từ nhiều nguồn thành một tỷ giá.
 *
 * FAIL-CLOSED: dưới `MIN_SOURCES` nguồn hợp lệ, hoặc các nguồn lệch nhau quá
 * `MAX_SPREAD_BPS`, thì KHÔNG trả về giá nào cả. Thà không tạo được đơn còn hơn tạo
 * đơn ở một mức giá không kiểm chứng được — đơn đã khoá giá vẫn thanh toán bình thường,
 * nên hỏng ở đây chỉ chặn đơn mới.
 */
export function aggregateRates(
  quotes: readonly SourceQuote[],
  options: { minSources?: number; maxSpreadBps?: number } = {},
): Aggregated {
  const { minSources = MIN_SOURCES, maxSpreadBps = MAX_SPREAD_BPS } = options;

  const good: SourceQuote[] = [];
  const rejected: SourceQuote[] = [];

  for (const quote of quotes) {
    if (quote.rate === null) rejected.push(quote);
    else if (!isSaneRate(quote.rate)) {
      rejected.push({ ...quote, error: `giá ${quote.rate} nằm ngoài khoảng hợp lý` });
    } else good.push(quote);
  }

  const names = good.map((quote) => quote.name);

  if (good.length < minSources) {
    return {
      ok: false,
      error: `Chỉ có ${good.length}/${quotes.length} nguồn giá dùng được, cần tối thiểu ${minSources}.`,
      sources: names,
      rejected,
    };
  }

  const rates = good.map((quote) => quote.rate!);
  const spread = spreadBps(rates);

  if (spread > maxSpreadBps) {
    return {
      ok: false,
      error: `Các nguồn lệch nhau ${(spread / 100).toFixed(2)}% (ngưỡng ${(maxSpreadBps / 100).toFixed(2)}%) — có nguồn đang sai.`,
      sources: names,
      rejected,
    };
  }

  return { ok: true, rate: median(rates), sources: names, spreadBps: spread, rejected };
}

/* ------------------------------------------------------------------ */
/* Kiểm tra lệch peg                                                   */
/* ------------------------------------------------------------------ */

/** 1 USD ở thang micro-USD. */
export const ONE_USD = 1_000_000n;

/** Lệch quá ngưỡng này thì tắt token khỏi checkout. */
export const DEFAULT_PEG_MAX_DEVIATION_BPS = 200; // 2%

export type PegStatus =
  | { state: "ok"; priceMicroUsd: bigint; deviationBps: number }
  | { state: "depegged"; priceMicroUsd: bigint; deviationBps: number }
  /** Không có nguồn giá cho token này — nói thẳng, không im lặng coi như 1:1. */
  | { state: "unknown"; reason: string };

export function evaluatePeg(
  priceMicroUsd: bigint | null,
  maxDeviationBps = DEFAULT_PEG_MAX_DEVIATION_BPS,
  reasonIfMissing = "không có nguồn giá cho token này",
): PegStatus {
  if (priceMicroUsd === null) return { state: "unknown", reason: reasonIfMissing };
  if (priceMicroUsd <= 0n) return { state: "unknown", reason: "nguồn giá trả về giá trị không hợp lệ" };

  const diff = priceMicroUsd > ONE_USD ? priceMicroUsd - ONE_USD : ONE_USD - priceMicroUsd;
  const deviationBps = Number((diff * 10_000n) / ONE_USD);

  return deviationBps > maxDeviationBps
    ? { state: "depegged", priceMicroUsd, deviationBps }
    : { state: "ok", priceMicroUsd, deviationBps };
}
