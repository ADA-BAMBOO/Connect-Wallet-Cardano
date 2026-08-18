import type { CardanoNetwork } from "@/lib/network";

/**
 * Danh mục token nhận thanh toán, theo từng mạng.
 *
 * Không import gì (ngoài kiểu, vốn bị xoá lúc biên dịch) để script kiểm thử nạp
 * thẳng file này được.
 */

export type PayToken = {
  /** Ký hiệu hiển thị. */
  symbol: string;
  label: string;
  /** 'lovelace' cho ADA (đúng quy ước CIP-30/Mesh), ngược lại policyId + assetNameHex. */
  unit: string;
  decimals: number;
  /** true nếu quy ước 1 token = 1 USD; ADA thì false (quy đổi theo tỷ giá). */
  pegged: boolean;
  /**
   * Id trên CoinGecko, dùng để kiểm tra token có còn giữ peg không.
   *
   * Tra bằng CONTRACT ADDRESS (chính là `unit`), tuyệt đối không tra bằng ticker:
   * "USDA" trên CoinGecko trả về một token Binance Smart Chain hoàn toàn khác, còn
   * iUSD của Indigo thì không hiện ra trong kết quả tìm theo ticker.
   *
   * Không có id thì peg ở trạng thái "chưa kiểm chứng được" — không phải "đạt".
   */
  coingeckoId?: string;
  /** Từ đâu ra — hằng số trong code hay biến môi trường. */
  source: "builtin" | "env";
};

export const ADA: PayToken = {
  symbol: "ADA",
  label: "Cardano",
  unit: "lovelace",
  decimals: 6,
  pegged: false,
  source: "builtin",
};

/**
 * Mainnet — tra bằng `npm run resolve:stablecoins`, KHÔNG chép tay.
 *
 * Mỗi dòng đã được hai nguồn độc lập xác nhận: có mặt trong Cardano Token Registry
 * (repo có kiểm duyệt của Cardano Foundation) và tồn tại thật trên chain qua
 * Blockfrost, với ticker cùng decimals khớp nhau.
 *
 * Ai cũng mint được một token tên "USDM" và nó hiện trong ví y hệt hàng thật — thứ
 * duy nhất phân biệt được là policy id. Sửa những dòng này phải chạy lại script.
 *
 * Đối chiếu lần cuối: 2026-08-18.
 */
const MAINNET_STABLECOINS: readonly PayToken[] = [
  {
    symbol: "USDM",
    label: "Moneta USDM",
    // CIP-68: 0014df10 là nhãn 333 (fungible token) đứng trước "USDM".
    unit: "c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad0014df105553444d",
    decimals: 6,
    pegged: true,
    coingeckoId: "usdm-2",
    source: "builtin",
  },
  {
    symbol: "iUSD",
    label: "Indigo iUSD",
    unit: "f66d78b4a3cb3d37afa0ec36461e51ecbde00f26c8f0a68f94b6988069555344",
    decimals: 6,
    pegged: true,
    coingeckoId: "iusd",
    source: "builtin",
  },
  {
    symbol: "DJED",
    label: "Djed USD",
    // Asset name on-chain là "DjedMicroUSD", ticker trong registry là "DJED".
    unit: "8db269c3ec630e06ae29f74bc39edd1f87c819f1056206e879a1cd61446a65644d6963726f555344",
    decimals: 6,
    pegged: true,
    coingeckoId: "djed",
    source: "builtin",
  },
  {
    symbol: "USDA",
    label: "Anzens USDA",
    unit: "fe7c786ab321f41c654ef6c1af7b3250a613c24e4213e0425a7ae45655534441",
    decimals: 6,
    pegged: true,
    coingeckoId: "anzens-usda",
    source: "builtin",
  },
];

/**
 * Testnet không có stablecoin thật — không ai vận hành USDM trên preprod. Token
 * dùng để thử là hàng tự mint bằng `npm run mint:test-stablecoins`, và script đó in
 * ra sẵn dòng env để dán vào.
 */
const ENV_BY_NETWORK: Record<CardanoNetwork, string> = {
  mainnet: "STABLECOINS_MAINNET",
  preprod: "STABLECOINS_PREPROD",
  preview: "STABLECOINS_PREVIEW",
};

const BUILTIN: Record<CardanoNetwork, readonly PayToken[]> = {
  mainnet: MAINNET_STABLECOINS,
  preprod: [],
  preview: [],
};

export type RegistryIssue = { envName: string; message: string };

/** Kết quả đọc registry, kèm mọi vấn đề gặp phải — không nuốt lỗi im lặng. */
export type StablecoinRegistry = {
  tokens: PayToken[];
  issues: RegistryIssue[];
  /** true nếu env đã ghi đè một token dựng sẵn của mainnet. */
  overridesBuiltin: boolean;
};

function isValidUnit(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{56,}$/.test(value) && value.length % 2 === 0;
}

/**
 * Đọc danh sách token từ biến môi trường, dạng JSON:
 *
 *   STABLECOINS_PREPROD=[{"symbol":"tUSDM","label":"Test USDM","unit":"abc…","decimals":6}]
 *
 * Từng phần tử được kiểm riêng: một dòng hỏng bị loại và ghi lại lý do, chứ không
 * làm hỏng cả danh sách — nhưng cũng không bao giờ bị bỏ qua im lặng.
 */
function parseEnvTokens(envName: string, raw: string): { tokens: PayToken[]; issues: RegistryIssue[] } {
  const issues: RegistryIssue[] = [];
  const tokens: PayToken[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { tokens, issues: [{ envName, message: "không phải JSON hợp lệ." }] };
  }

  if (!Array.isArray(parsed)) {
    return { tokens, issues: [{ envName, message: "phải là một mảng JSON." }] };
  }

  parsed.forEach((entry, index) => {
    const at = `phần tử #${index}`;
    if (typeof entry !== "object" || entry === null) {
      issues.push({ envName, message: `${at}: không phải object.` });
      return;
    }

    const { symbol, label, unit, decimals, pegged, coingeckoId } = entry as Record<string, unknown>;

    if (typeof symbol !== "string" || !symbol.trim()) {
      issues.push({ envName, message: `${at}: thiếu "symbol".` });
      return;
    }
    if (!isValidUnit(unit)) {
      issues.push({
        envName,
        message: `${at} (${symbol}): "unit" phải là hex thường, tối thiểu 56 ký tự (policyId + assetNameHex).`,
      });
      return;
    }
    if (!Number.isInteger(decimals) || (decimals as number) < 0 || (decimals as number) > 18) {
      issues.push({ envName, message: `${at} (${symbol}): "decimals" phải là số nguyên 0..18.` });
      return;
    }

    tokens.push({
      symbol: symbol.trim(),
      label: typeof label === "string" && label.trim() ? label.trim() : symbol.trim(),
      unit,
      decimals: decimals as number,
      // Mặc định coi là stablecoin neo 1:1 — đó là lý do token có mặt ở đây.
      pegged: pegged === undefined ? true : Boolean(pegged),
      // Token thử tự mint thì không có trên CoinGecko — peg sẽ ở trạng thái
      // "chưa kiểm chứng được", đúng với thực tế.
      coingeckoId: typeof coingeckoId === "string" && coingeckoId.trim() ? coingeckoId.trim() : undefined,
      source: "env",
    });
  });

  return { tokens, issues };
}

/**
 * Danh sách stablecoin của một mạng: hằng số dựng sẵn, rồi env ghi đè theo `unit`.
 *
 * Ghi đè trên MAINNET là chuyện nghiêm trọng — nó đổi chính cái policy id mà hệ
 * thống coi là tiền thật. Cho phép, vì token có thể đổi hợp đồng, nhưng phải lộ ra:
 * `overridesBuiltin` được trang health hiển thị chứ không im lặng.
 */
export function getStablecoinRegistry(network: CardanoNetwork): StablecoinRegistry {
  const envName = ENV_BY_NETWORK[network];
  const raw = process.env[envName]?.trim();

  const builtin = BUILTIN[network];
  if (!raw) return { tokens: [...builtin], issues: [], overridesBuiltin: false };

  const { tokens: envTokens, issues } = parseEnvTokens(envName, raw);

  const bySymbol = new Map<string, PayToken>();
  for (const token of builtin) bySymbol.set(token.symbol, token);

  let overridesBuiltin = false;
  for (const token of envTokens) {
    const existing = bySymbol.get(token.symbol);
    if (existing && existing.unit !== token.unit) overridesBuiltin = true;
    bySymbol.set(token.symbol, token);
  }

  const tokens = [...bySymbol.values()];

  // Hai token khác ký hiệu mà cùng unit là cấu hình sai và sẽ làm việc đối chiếu
  // on-chain trở nên nhập nhằng — chặn ngay thay vì để nó nổ ở khâu xác minh.
  const seenUnits = new Map<string, string>();
  for (const token of tokens) {
    const owner = seenUnits.get(token.unit);
    if (owner) issues.push({ envName, message: `${token.symbol} và ${owner} trùng "unit".` });
    else seenUnits.set(token.unit, token.symbol);
  }

  return { tokens, issues, overridesBuiltin };
}

/** Chỉ danh sách token, bỏ qua chẩn đoán. */
export function getStablecoins(network: CardanoNetwork): PayToken[] {
  return getStablecoinRegistry(network).tokens;
}

/** Mọi thứ trả được: ADA luôn có, kể cả khi mạng chưa khai báo stablecoin nào. */
export function getPayableTokens(network: CardanoNetwork): PayToken[] {
  return [ADA, ...getStablecoins(network)];
}

/** Tra token theo `unit`. Trả về null nếu không nằm trong danh mục của mạng đó. */
export function findPayToken(network: CardanoNetwork, unit: string): PayToken | null {
  return getPayableTokens(network).find((token) => token.unit === unit) ?? null;
}

export function isAda(token: PayToken): boolean {
  return token.unit === "lovelace";
}
