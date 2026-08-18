/**
 * Số học tiền tệ cho luồng thanh toán.
 *
 * QUY TẮC BẤT DI BẤT DỊCH: mọi số tiền đều là `bigint` ở đơn vị nhỏ nhất
 * (lovelace, hoặc 10^-decimals của token). KHÔNG dùng `number` cho tiền ở bất kỳ
 * đâu — `0.1 + 0.2 !== 0.3`, và một sai số 1e-16 nhân với tỷ giá rồi làm tròn
 * là đủ để lệch sổ.
 *
 * Không import gì để chạy được ở cả server, client lẫn script kiểm thử.
 */

/** USD lưu ở đơn vị 10^-6 (micro-USD). 10.50 USD = 10_500_000n. */
export const USD_DECIMALS = 6;

/** 1 ADA = 10^6 lovelace. */
export const ADA_DECIMALS = 6;

/**
 * Tỷ giá lưu dạng micro-USD cho 1 ADA. ADA = 0.45 USD  =>  450_000n.
 * Cùng thang với USD nên quy đổi chỉ là nhân/chia số nguyên.
 */
export const RATE_DECIMALS = 6;

/** Sai số chấp nhận khi đối chiếu số tiền nhận được, tính theo basis point (100 = 1%). */
export const DEFAULT_TOLERANCE_BPS = 100;

/** Chặn chuỗi đầu vào quá dài — đầu vào từ HTTP không được phép sinh BigInt khổng lồ. */
const MAX_INPUT_LENGTH = 30;

export function pow10(exponent: number): bigint {
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 38) {
    throw new RangeError(`Số thập phân không hợp lệ: ${exponent}`);
  }
  return 10n ** BigInt(exponent);
}

/** Chia làm tròn LÊN. Dùng khi tính số tiền người trả phải trả — không để hụt. */
export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError("Mẫu số phải dương.");
  if (numerator <= 0n) return numerator / denominator;
  return (numerator + denominator - 1n) / denominator;
}

/**
 * Đọc số người dùng nhập ("10", "10.5") sang đơn vị nhỏ nhất.
 * Trả về null nếu không hợp lệ — số âm, quá nhiều chữ số thập phân, hoặc rác.
 */
export function parseAmount(input: string, decimals: number): bigint | null {
  if (typeof input !== "string") return null;

  const trimmed = input.trim();
  if (trimmed === "" || trimmed === "." || trimmed.length > MAX_INPUT_LENGTH) return null;
  if (!/^\d*\.?\d*$/.test(trimmed)) return null;

  const [whole = "", fraction = ""] = trimmed.split(".");
  if (fraction.length > decimals) return null;

  return BigInt(whole || "0") * pow10(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

export type FormatAmountOptions = {
  /** Ngăn cách hàng nghìn (mặc định true). */
  group?: boolean;
  /** Bỏ số 0 thừa ở cuối phần thập phân (mặc định true). */
  trim?: boolean;
  /** Số chữ số thập phân tối đa muốn hiện (mặc định = decimals). */
  maxFractionDigits?: number;
};

/** Đổi đơn vị nhỏ nhất sang chuỗi người đọc được. Không đi qua `number`. */
export function formatAmount(
  value: bigint,
  decimals: number,
  options: FormatAmountOptions = {},
): string {
  const { group = true, trim = true, maxFractionDigits = decimals } = options;

  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const divisor = pow10(decimals);

  const wholePart = absolute / divisor;
  const whole = group ? wholePart.toLocaleString("en-US") : wholePart.toString();

  let fraction =
    decimals > 0
      ? (absolute % divisor).toString().padStart(decimals, "0").slice(0, maxFractionDigits)
      : "";
  if (trim) fraction = fraction.replace(/0+$/, "");

  const result = fraction ? `${whole}.${fraction}` : whole;
  return negative ? `-${result}` : result;
}

/** Nhân theo basis point, làm tròn XUỐNG. 10_000 bps = 100%. */
export function applyBps(value: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0) throw new RangeError(`bps không hợp lệ: ${bps}`);
  return (value * BigInt(bps)) / 10_000n;
}

/**
 * Ngưỡng tối thiểu coi là đã trả đủ.
 *
 * Sai số tồn tại để không đánh trượt người trả vì chênh lệch làm tròn, nên nó làm
 * tròn XUỐNG (rộng lượng hơn). Trả dưới ngưỡng này là `underpaid`, không phải `confirmed`.
 */
export function minAcceptable(required: bigint, toleranceBps = DEFAULT_TOLERANCE_BPS): bigint {
  if (toleranceBps >= 10_000) throw new RangeError("Sai số phải nhỏ hơn 100%.");
  return applyBps(required, 10_000 - toleranceBps);
}

/**
 * USD -> số lượng stablecoin, quy ước 1 token = 1 USD.
 *
 * Làm tròn LÊN: thà người trả nhiều hơn 0.000001 token còn hơn merchant nhận hụt
 * rồi đơn bị treo ở `underpaid`.
 */
export function usdToStablecoin(usdMinor: bigint, tokenDecimals: number): bigint {
  if (tokenDecimals >= USD_DECIMALS) {
    return usdMinor * pow10(tokenDecimals - USD_DECIMALS);
  }
  return ceilDiv(usdMinor, pow10(USD_DECIMALS - tokenDecimals));
}

/** Số lượng stablecoin -> USD, quy ước 1:1. Làm tròn XUỐNG. */
export function stablecoinToUsd(quantity: bigint, tokenDecimals: number): bigint {
  if (tokenDecimals >= USD_DECIMALS) {
    return quantity / pow10(tokenDecimals - USD_DECIMALS);
  }
  return quantity * pow10(USD_DECIMALS - tokenDecimals);
}

/**
 * USD -> lovelace theo tỷ giá (micro-USD cho 1 ADA). Làm tròn LÊN.
 *
 *   lovelace = usdMinor / rate * 10^6
 *
 * Kiểm thứ nguyên: [1e-6 USD] / [1e-6 USD/ADA] = [ADA], nhân 10^6 ra lovelace.
 */
export function usdToLovelace(usdMinor: bigint, rateMicroUsdPerAda: bigint): bigint {
  assertPositiveRate(rateMicroUsdPerAda);
  return ceilDiv(usdMinor * pow10(ADA_DECIMALS), rateMicroUsdPerAda);
}

/** lovelace -> USD theo tỷ giá. Làm tròn XUỐNG. */
export function lovelaceToUsd(lovelace: bigint, rateMicroUsdPerAda: bigint): bigint {
  assertPositiveRate(rateMicroUsdPerAda);
  return (lovelace * rateMicroUsdPerAda) / pow10(ADA_DECIMALS);
}

/**
 * Tỷ giá <= 0 là lỗi cấu hình hoặc nguồn giá hỏng, không phải lỗi người dùng nhập.
 * Ném lỗi thay vì trả null để không có đường nào âm thầm tạo đơn ở giá rác.
 */
function assertPositiveRate(rate: bigint): void {
  if (rate <= 0n) throw new RangeError(`Tỷ giá phải dương, nhận được ${rate}.`);
}

/**
 * pg trả cột `bigint` (int8) về dạng CHUỖI, không phải number — cố ý, vì int8 vượt
 * quá `Number.MAX_SAFE_INTEGER`. Đừng bao giờ `Number(row.amount_usd)`.
 */
export function toBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  throw new TypeError(`Không đọc được số nguyên từ ${JSON.stringify(value)}.`);
}
