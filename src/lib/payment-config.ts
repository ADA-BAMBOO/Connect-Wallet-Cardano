import "server-only";

import { isBlockfrostConfigured, resolveBlockfrostKey } from "@/lib/blockfrost";
import {
  addressMatchesCardanoNetwork,
  CARDANO_NETWORKS,
  type CardanoNetwork,
  looksLikePaymentAddress,
  networkMeta,
} from "@/lib/network";

/**
 * Cấu hình thanh toán đọc từ biến môi trường, kèm kiểm tra tính nhất quán.
 *
 * Nguyên tắc: sai cấu hình phải lộ ra ở đây, lúc khởi động hoặc lúc gọi /health —
 * chứ không phải lộ ra lúc có người vừa trả tiền xong.
 */

const MERCHANT_ENV: Record<CardanoNetwork, string> = {
  mainnet: "MERCHANT_ADDRESS_MAINNET",
  preprod: "MERCHANT_ADDRESS_PREPROD",
  preview: "MERCHANT_ADDRESS_PREVIEW",
};

export type MerchantResolution =
  | { ok: true; address: string; source: string }
  | { ok: false; error: string };

/**
 * Địa chỉ nhận tiền — CHỈ đến từ biến môi trường, không bao giờ từ request.
 *
 * Nếu client tự khai được địa chỉ nhận, kẻ tấn công tạo đơn trỏ về ví của chính họ,
 * tự trả, và hệ thống ghi nhận "đã thanh toán" trong khi tiền không hề về merchant.
 * Giá trị này được snapshot vào từng đơn lúc tạo, nên đổi env sau đó không làm sai
 * kết luận của các đơn cũ.
 */
export function resolveMerchantAddress(network: CardanoNetwork): MerchantResolution {
  const envName = MERCHANT_ENV[network];
  const raw = process.env[envName]?.trim();

  if (!raw) return { ok: false, error: `Chưa cấu hình ${envName}.` };

  if (!looksLikePaymentAddress(raw)) {
    return { ok: false, error: `${envName} không phải địa chỉ payment bech32 hợp lệ.` };
  }

  if (!addressMatchesCardanoNetwork(raw, network)) {
    const expected = networkMeta(network).addressPrefix;
    return {
      ok: false,
      error: `${envName} không thuộc mạng "${network}" — địa chỉ phải bắt đầu bằng "${expected}1".`,
    };
  }

  return { ok: true, address: raw, source: envName };
}

/* ------------------------------------------------------------------ */
/* Tham số vận hành                                                    */
/* ------------------------------------------------------------------ */

function readInt(envName: string, fallback: number, min: number, max: number): number {
  const raw = process.env[envName]?.trim();
  if (!raw) return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    // Không im lặng dùng giá trị rác: cảnh báo rồi rơi về mặc định an toàn.
    console.warn(`[payment] ${envName}="${raw}" không hợp lệ (${min}..${max}), dùng ${fallback}.`);
    return fallback;
  }
  return value;
}

export type PaymentParams = {
  /** Hạn khoá tỷ giá ADA, giây. */
  quoteTtlSeconds: number;
  /** Hạn sống của cả đơn/hoá đơn, giây. */
  orderTtlSeconds: number;
  /** Sai số chấp nhận khi đối chiếu số tiền, basis point. */
  toleranceBps: number;
  /** Số block xác nhận trước khi coi là đã thanh toán. */
  requiredConfirmations: number;
  /** Số đơn tối đa một IP tạo được trong một giờ. */
  orderRateLimit: number;
};

/**
 * Số đơn tối đa mỗi IP mỗi giờ.
 *
 * Mặc định khác nhau theo môi trường vì mối đe doạ khác nhau: ở production đây là
 * endpoint công khai có ghi database, một vòng lặp curl là đủ làm phình bảng. Ở dev
 * thì nó chỉ nghe localhost, và ngưỡng thấp chủ yếu chặn... chính bộ kiểm thử của
 * mình — `verify:payment` tạo cả chục đơn mỗi lần chạy.
 */
export function orderCreateLimit(): number {
  const fallback = process.env.NODE_ENV === "production" ? 30 : 500;
  return readInt("PAYMENT_ORDER_RATE_LIMIT", fallback, 1, 100_000);
}

export function getPaymentParams(): PaymentParams {
  return {
    quoteTtlSeconds: readInt("PAYMENT_QUOTE_TTL_SECONDS", 900, 60, 3_600),
    orderTtlSeconds: readInt("PAYMENT_ORDER_TTL_SECONDS", 86_400, 300, 30 * 86_400),
    toleranceBps: readInt("PAYMENT_TOLERANCE_BPS", 100, 0, 1_000),
    requiredConfirmations: readInt("PAYMENT_CONFIRMATIONS", 3, 1, 20),
    orderRateLimit: orderCreateLimit(),
  };
}

/* ------------------------------------------------------------------ */
/* Trạng thái từng mạng                                                */
/* ------------------------------------------------------------------ */

export type NetworkStatus = {
  network: CardanoNetwork;
  /** Đủ điều kiện nhận thanh toán: có merchant, có Blockfrost, và được phép bật. */
  enabled: boolean;
  merchant: MerchantResolution;
  blockfrostConfigured: boolean;
  blockfrostSource?: string;
  /** Lỗi khi phân giải Blockfrost key — quan trọng nhất là trường hợp key sai mạng. */
  blockfrostError?: string;
  /**
   * TẤT CẢ lý do khiến mạng này chưa nhận được thanh toán, không chỉ cái đầu tiên.
   *
   * Dừng ở lỗi đầu tiên từng che mất chuyện nghiêm trọng hơn: thiếu MERCHANT_ADDRESS
   * là chuyện vặt, nhưng "key trỏ nhầm mạng" nằm ngay dưới nó thì lại là lỗi có thể
   * làm mất tiền. Cả hai phải cùng hiện ra.
   */
  problems: string[];
  /** `problems` gộp thành một câu, để hiển thị nhanh. */
  reason?: string;
};

/**
 * Mainnet mặc định TẮT.
 *
 * Có key và có địa chỉ không đồng nghĩa với "sẵn sàng nhận tiền thật". Bật mainnet
 * phải là một hành động cố ý, không phải hệ quả phụ của việc điền đủ biến môi trường.
 */
function isMainnetAllowed(): boolean {
  return process.env.PAYMENT_ENABLED_MAINNET === "true";
}

export function getNetworkStatus(network: CardanoNetwork): NetworkStatus {
  const merchant = resolveMerchantAddress(network);
  const keyResolution = resolveBlockfrostKey(network);

  const problems: string[] = [];
  if (!merchant.ok) problems.push(merchant.error);
  if (!keyResolution.ok) problems.push(keyResolution.error);
  if (network === "mainnet" && !isMainnetAllowed()) {
    problems.push("Mainnet chưa bật — đặt PAYMENT_ENABLED_MAINNET=true.");
  }

  return {
    network,
    enabled: problems.length === 0,
    merchant,
    blockfrostConfigured: keyResolution.ok,
    blockfrostSource: keyResolution.ok ? keyResolution.source : undefined,
    blockfrostError: keyResolution.ok ? undefined : keyResolution.error,
    problems,
    reason: problems.length > 0 ? problems.join(" ") : undefined,
  };
}

export function getAllNetworkStatus(): NetworkStatus[] {
  return CARDANO_NETWORKS.map(getNetworkStatus);
}

export function getEnabledNetworks(): CardanoNetwork[] {
  return CARDANO_NETWORKS.filter((network) => getNetworkStatus(network).enabled);
}

/** Dùng ở đường nóng: trả về địa chỉ merchant hoặc ném lỗi rõ nghĩa. */
export function requireMerchantAddress(network: CardanoNetwork): string {
  const status = getNetworkStatus(network);
  if (!status.enabled) {
    throw new Error(`Mạng "${network}" chưa sẵn sàng nhận thanh toán: ${status.reason}`);
  }
  // enabled === true đảm bảo merchant.ok, nhưng TS không suy ra được từ NetworkStatus.
  if (!status.merchant.ok) throw new Error(status.merchant.error);
  return status.merchant.address;
}

export { isBlockfrostConfigured };
