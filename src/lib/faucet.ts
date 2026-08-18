import "server-only";

import {
  BlockfrostProvider,
  ForgeScript,
  hexToString,
  MeshWallet,
  resolveScriptHash,
  stringToHex,
  Transaction,
} from "@meshsdk/core";

import { resolveBlockfrostKey } from "@/lib/blockfrost";
import { isDatabaseConfigured } from "@/lib/db";
import { describeError } from "@/lib/errors";
import {
  type ClaimAsset,
  faucetUsage,
  insertPendingClaim,
  lastClaimAt,
  lastSentAt,
  markClaimFailed,
  markClaimSent,
  withFaucetLock,
} from "@/lib/faucet-claims";
import { formatAmount, parseAmount } from "@/lib/money";
import {
  addressMatchesCardanoNetwork,
  type CardanoNetwork,
  cardanoTxUrl,
  looksLikePaymentAddress,
} from "@/lib/network";
import { getStablecoins, type PayToken } from "@/lib/stablecoins";

/**
 * Faucet: người test tự lấy stablecoin thử để chạy hết luồng thanh toán.
 *
 * VÌ SAO CẦN
 * Trang /pay yêu cầu người trả có sẵn token trong ví. Trên testnet thì không có chỗ
 * nào mua được tUSDM — trước đây cách duy nhất là nhờ người giữ MINT_MNEMONIC chạy
 * `npm run mint:test-stablecoins -- --to <địa chỉ>` cho từng người. Faucet chính là
 * việc đó, mở thành một endpoint có cooldown và có ghi sổ.
 *
 * CHỈ PREPROD.
 * `FAUCET_NETWORK` là hằng số, không đọc từ biến môi trường và không nhận từ request.
 * Faucet trên mainnet nghĩa là phát tiền thật cho người lạ, nên nó không được phép
 * tồn tại ở dạng "chỉ cần đổi một biến là bật". Muốn thêm preview thì phải sửa dòng
 * dưới đây, tức là phải cố ý.
 *
 * PHÁT BẰNG CÁCH ĐÚC, KHÔNG PHẢI XUẤT KHO.
 * Ví faucet chính là ví giữ policy của bộ token thử (cùng `MINT_MNEMONIC` mà script
 * mint dùng), nên với token thuộc policy đó, faucet đúc mới ngay trong giao dịch phát
 * — không bao giờ "hết hàng", chỉ có thể hết ADA. Token KHÔNG thuộc policy này (ai đó
 * khai tay vào STABLECOINS_PREPROD) thì rơi về chế độ chuyển từ số dư sẵn có.
 */

export const FAUCET_NETWORK: CardanoNetwork = "preprod";

const ADA_DECIMALS = 6;

/** Mặc định phát mỗi loại 1.000 token — đủ tạo hàng chục đơn thử. */
const DEFAULT_TOKEN_AMOUNT = "1000";

/**
 * ADA kèm theo mỗi lượt phát.
 *
 * Không phải quà tặng: Cardano bắt mỗi output phải chứa min-ADA, và một output mang 4
 * native token cần khoảng 1,4 ADA. 2 ADA vừa đủ vượt ngưỡng đó, vừa để lại chút phí
 * cho người test gửi giao dịch trả tiền.
 */
const DEFAULT_ADA_AMOUNT = "2";

/** Dưới mức này thì output nhiều token gần như chắc chắn không đạt min-ADA. */
const MIN_DRIP_LOVELACE = 1_500_000n;

/** Phí + đệm phải chừa lại trong ví faucet sau mỗi lượt phát. */
const WALLET_RESERVE_LOVELACE = 2_000_000n;

/**
 * Khoảng chờ giữa hai lượt phát, giây.
 *
 * Blockfrost chỉ thấy UTxO đã lên chain, không thấy mempool. Dựng giao dịch ngay sau
 * một lượt phát nghĩa là chọn lại đúng input vừa tiêu, và node từ chối với
 * `BadInputsUTxO`. Block trên Cardano cách nhau ~20 giây, nên chờ 45 giây là qua được
 * trường hợp thường gặp — và người dùng nhận được câu "chờ N giây" thay vì một lỗi
 * chọn UTxO khó hiểu.
 *
 * Advisory lock KHÔNG thay thế được chỗ này: nó đã nhả ngay sau khi submit xong.
 */
const CHAIN_SETTLE_SECONDS = 45;

/** Chặn trên cho cấu hình: gõ thừa một số 0 không được biến thành lượt phát khổng lồ. */
const MAX_TOKEN_AMOUNT_MINOR = 1_000_000n * 10n ** 6n;
const MAX_ADA_MINOR = 100n * 10n ** 6n;

/* ------------------------------------------------------------------ */
/* Cấu hình                                                            */
/* ------------------------------------------------------------------ */

function readInt(envName: string, fallback: number, min: number, max: number): number {
  const raw = process.env[envName]?.trim();
  if (!raw) return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    console.warn(`[faucet] ${envName}="${raw}" không hợp lệ (${min}..${max}), dùng ${fallback}.`);
    return fallback;
  }
  return value;
}

/** Đọc số tiền dạng hiển thị ("1000", "2.5") sang đơn vị nhỏ nhất. */
function readAmount(envName: string, fallback: string, decimals: number, max: bigint): bigint {
  const raw = process.env[envName]?.trim();
  const parsed = raw ? parseAmount(raw, decimals) : null;
  const valid = parsed !== null && parsed > 0n && parsed <= max;

  if (raw && !valid) {
    console.warn(`[faucet] ${envName}="${raw}" không hợp lệ, dùng ${fallback}.`);
  }

  // `fallback` là hằng số trong chính file này nên luôn parse được; `??` chỉ để chiều TS.
  return valid ? parsed : (parseAmount(fallback, decimals) ?? 0n);
}

export function faucetTokenAmount(decimals: number): bigint {
  return readAmount("FAUCET_AMOUNT", DEFAULT_TOKEN_AMOUNT, decimals, MAX_TOKEN_AMOUNT_MINOR);
}

export function faucetLovelace(): bigint {
  const configured = readAmount("FAUCET_ADA", DEFAULT_ADA_AMOUNT, ADA_DECIMALS, MAX_ADA_MINOR);
  // Cấu hình thấp hơn min-ADA thì giao dịch bị chain từ chối chứ không "phát ít hơn"
  // — nâng lên ngưỡng an toàn thay vì để nó hỏng lúc submit.
  return configured < MIN_DRIP_LOVELACE ? MIN_DRIP_LOVELACE : configured;
}

/**
 * Cooldown mỗi địa chỉ.
 *
 * Mặc định khác nhau theo môi trường, cùng lý do với hạn mức tạo đơn: bản deploy công
 * khai cần 24 giờ để một người không hút cạn ví; còn lúc đang code thì chính bộ kiểm
 * thử của mình mới là thứ bị chặn trước tiên.
 */
export function faucetCooldownSeconds(): number {
  const fallback = process.env.NODE_ENV === "production" ? 86_400 : 60;
  return readInt("FAUCET_COOLDOWN_SECONDS", fallback, 0, 30 * 86_400);
}

/** Số lượt xin tối đa mỗi IP mỗi giờ — tầng chặn trước cooldown, xem lib/rate-limit.ts. */
export function faucetClaimLimit(): number {
  const fallback = process.env.NODE_ENV === "production" ? 10 : 200;
  return readInt("FAUCET_CLAIM_RATE_LIMIT", fallback, 1, 100_000);
}

/**
 * Công tắc.
 *
 * Production PHẢI khai `FAUCET_ENABLED=true`. Chỉ vì máy chủ tình cờ có
 * `MINT_MNEMONIC` (để chạy script mint) mà tự mọc ra một endpoint phát tiền công khai
 * thì đó là hệ quả phụ, không phải quyết định — và ví testnet cũng cạn thật.
 */
function faucetSwitch(): { ok: true } | { ok: false; error: string } {
  const raw = process.env.FAUCET_ENABLED?.trim().toLowerCase();

  if (raw === "true") return { ok: true };
  if (raw === "false") return { ok: false, error: "FAUCET_ENABLED=false — faucet đang tắt." };

  if (process.env.NODE_ENV === "production") {
    return { ok: false, error: "Faucet chưa bật — đặt FAUCET_ENABLED=true." };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Ví faucet                                                           */
/* ------------------------------------------------------------------ */

type FaucetWallet = {
  wallet: MeshWallet;
  address: string;
  forgeScript: string;
  policyId: string;
  /** Biến môi trường thật sự cấp seed — hiện ở trang trạng thái để khỏi phải đoán. */
  source: string;
};

type WalletResolution = { ok: true; value: FaucetWallet } | { ok: false; error: string };

/**
 * Cache trên globalThis, cùng lý do với pool Postgres: `next dev` nạp lại module mỗi
 * lần sửa file, và dựng lại MeshWallet mỗi lần vừa chậm vừa vô ích.
 */
const globalForFaucet = globalThis as unknown as { __faucetWallet?: FaucetWallet };

function loadFaucetWallet(): WalletResolution {
  if (globalForFaucet.__faucetWallet) return { ok: true, value: globalForFaucet.__faucetWallet };

  // FAUCET_MNEMONIC tách riêng để có thể dùng ví khác ví mint. Không khai thì dùng
  // chính ví mint — đó là trường hợp thường gặp, và cũng là ví DUY NHẤT đúc được
  // token thử, vì nó giữ policy.
  const source = process.env.FAUCET_MNEMONIC?.trim() ? "FAUCET_MNEMONIC" : "MINT_MNEMONIC";
  const words = process.env[source]?.trim().split(/\s+/).filter(Boolean) ?? [];

  if (words.length < 12) {
    return {
      ok: false,
      error:
        "Chưa cấu hình FAUCET_MNEMONIC (hoặc MINT_MNEMONIC). " +
        "Chạy `npm run mint:test-stablecoins` để sinh ví và xem hướng dẫn.",
    };
  }

  const key = resolveBlockfrostKey(FAUCET_NETWORK);
  if (!key.ok) return { ok: false, error: key.error };

  try {
    const provider = new BlockfrostProvider(key.key);
    const wallet = new MeshWallet({
      // 0 = testnet. Hằng số, không suy ra từ cấu hình: ví faucet không bao giờ được
      // phép là ví mainnet.
      networkId: 0,
      fetcher: provider,
      submitter: provider,
      key: { type: "mnemonic", words },
    });

    const address = wallet.getChangeAddress();
    if (!addressMatchesCardanoNetwork(address, FAUCET_NETWORK)) {
      return {
        ok: false,
        error: `Ví faucet cho ra địa chỉ "${address}" — không phải địa chỉ testnet.`,
      };
    }

    // Policy suy ra từ chính ví (native script "cần chữ ký của ví này"), giống hệt
    // script mint — nên policy id ở đây và ở script luôn khớp nhau.
    const forgeScript = ForgeScript.withOneSignature(address);
    const value: FaucetWallet = {
      wallet,
      address,
      forgeScript,
      policyId: resolveScriptHash(forgeScript),
      source,
    };

    globalForFaucet.__faucetWallet = value;
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: `Không dựng được ví faucet: ${describeError(error)}` };
  }
}

/* ------------------------------------------------------------------ */
/* Kế hoạch phát                                                       */
/* ------------------------------------------------------------------ */

export type DripMode = "mint" | "transfer";

export type DripItem = {
  token: PayToken;
  quantity: bigint;
  mode: DripMode;
  /** Tên asset dạng chữ, chỉ có ở chế độ đúc (Mesh nhận tên chữ rồi tự hex hoá). */
  assetName: string | null;
};

/**
 * Tên asset để đúc lại, hoặc null nếu token không thuộc policy của faucet.
 *
 * Kiểm tra khứ hồi hex → chữ → hex là bắt buộc: `mintAsset` nhận tên dạng CHỮ và tự
 * hex hoá, nên với asset name không phải UTF-8 sạch (ví dụ tiền tố CIP-68 `0014df10`),
 * chuỗi đi ra sẽ khác chuỗi đi vào và faucet sẽ đúc nhầm một token khác mang tên gần
 * giống. Không khớp thì coi như không đúc được, rơi về chuyển từ số dư.
 */
function mintableAssetName(unit: string, policyId: string): string | null {
  if (!unit.startsWith(policyId)) return null;

  const nameHex = unit.slice(policyId.length);
  if (!nameHex) return null;

  try {
    const name = hexToString(nameHex);
    return stringToHex(name) === nameHex ? name : null;
  } catch {
    return null;
  }
}

function planDrip(tokens: readonly PayToken[], policyId: string): DripItem[] {
  return tokens.map((token) => {
    const assetName = mintableAssetName(token.unit, policyId);
    return {
      token,
      quantity: faucetTokenAmount(token.decimals),
      mode: assetName ? "mint" : "transfer",
      assetName,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Trạng thái                                                          */
/* ------------------------------------------------------------------ */

export type FaucetTokenStatus = {
  symbol: string;
  label: string;
  unit: string;
  decimals: number;
  /** Số lượng mỗi lượt, dạng hiển thị. */
  amount: string;
  mode: DripMode;
  /** Số dư ví faucet đang giữ (chỉ có nghĩa với token phải chuyển). null = chưa đọc được. */
  balance: string | null;
  /** false khi token phải chuyển mà ví không đủ. null = chưa đọc được số dư. */
  available: boolean | null;
};

export type FaucetStatus = {
  network: CardanoNetwork;
  enabled: boolean;
  problems: string[];
  reason?: string;
  address: string | null;
  policyId: string | null;
  mnemonicSource: string | null;
  ada: string;
  cooldownSeconds: number;
  tokens: FaucetTokenStatus[];
  /** Số dư ADA của ví faucet — thứ duy nhất thật sự cạn được. */
  balanceAda: string | null;
  balanceLow: boolean;
  balanceError?: string;
  usage: { last24h: number; total: number } | null;
};

type WalletBalance = { lovelace: bigint; byUnit: Map<string, bigint> };

async function readBalance(wallet: MeshWallet): Promise<WalletBalance> {
  const assets = await wallet.getBalance();
  const byUnit = new Map<string, bigint>();

  let lovelace = 0n;
  for (const asset of assets) {
    const quantity = BigInt(asset.quantity);
    if (asset.unit === "lovelace") lovelace += quantity;
    else byUnit.set(asset.unit, (byUnit.get(asset.unit) ?? 0n) + quantity);
  }

  return { lovelace, byUnit };
}

export async function getFaucetStatus(
  options: { withBalance?: boolean } = {},
): Promise<FaucetStatus> {
  const problems: string[] = [];

  const on = faucetSwitch();
  if (!on.ok) problems.push(on.error);

  // Không có DB thì không có cooldown, và faucet không cooldown chỉ là một cái vòi mở
  // sẵn. Thiếu Postgres là lý do TỪ CHỐI phát, không phải cảnh báo.
  if (!isDatabaseConfigured()) {
    problems.push("Thiếu DATABASE_URL — không ghi được sổ phát nên không áp được cooldown.");
  }

  const resolution = loadFaucetWallet();
  if (!resolution.ok) problems.push(resolution.error);

  const tokens = getStablecoins(FAUCET_NETWORK);
  if (tokens.length === 0) {
    problems.push(
      `STABLECOINS_${FAUCET_NETWORK.toUpperCase()} chưa khai token nào — ` +
        "chạy `npm run mint:test-stablecoins` rồi dán dòng env mà nó in ra.",
    );
  }

  const lovelace = faucetLovelace();
  const wallet = resolution.ok ? resolution.value : null;
  const plan = wallet ? planDrip(tokens, wallet.policyId) : [];

  let balance: WalletBalance | null = null;
  let balanceError: string | undefined;

  if (wallet && options.withBalance) {
    try {
      balance = await readBalance(wallet.wallet);
    } catch (error) {
      // Không đọc được số dư KHÔNG làm faucet tắt: Blockfrost nấc một cái không có
      // nghĩa là ví hết tiền. Nói rõ là "chưa biết", thay vì đoán.
      balanceError = describeError(error);
    }
  }

  if (balance && balance.lovelace < lovelace + WALLET_RESERVE_LOVELACE) {
    problems.push(
      `Ví faucet chỉ còn ${formatAmount(balance.lovelace, ADA_DECIMALS)} ADA — không đủ cho ` +
        "một lượt phát. Xin thêm tại https://docs.cardano.org/cardano-testnets/tools/faucet/",
    );
  }

  const tokenStatus: FaucetTokenStatus[] = plan.map((item) => {
    const held = balance?.byUnit.get(item.token.unit) ?? null;
    return {
      symbol: item.token.symbol,
      label: item.token.label,
      unit: item.token.unit,
      decimals: item.token.decimals,
      amount: formatAmount(item.quantity, item.token.decimals),
      mode: item.mode,
      balance: held === null ? null : formatAmount(held, item.token.decimals),
      // Token đúc được thì không có khái niệm "hết hàng"; chỉ token phải chuyển mới
      // phụ thuộc số dư.
      available: item.mode === "mint" ? true : held === null ? null : held >= item.quantity,
    };
  });

  const unavailable = tokenStatus.filter((token) => token.available === false);
  if (unavailable.length > 0) {
    problems.push(
      `Ví faucet không đủ ${unavailable.map((token) => token.symbol).join(", ")} để phát ` +
        "(token này không thuộc policy của faucet nên phải có sẵn trong ví).",
    );
  }

  const usage = isDatabaseConfigured() ? await faucetUsage(FAUCET_NETWORK).catch(() => null) : null;

  return {
    network: FAUCET_NETWORK,
    enabled: problems.length === 0,
    problems,
    reason: problems.length > 0 ? problems.join(" ") : undefined,
    address: wallet?.address ?? null,
    policyId: wallet?.policyId ?? null,
    mnemonicSource: wallet?.source ?? null,
    ada: formatAmount(lovelace, ADA_DECIMALS),
    cooldownSeconds: faucetCooldownSeconds(),
    tokens: tokenStatus,
    balanceAda: balance ? formatAmount(balance.lovelace, ADA_DECIMALS) : null,
    balanceLow: balance ? balance.lovelace < lovelace + WALLET_RESERVE_LOVELACE : false,
    balanceError,
    usage,
  };
}

/** Còn bao nhiêu giây nữa địa chỉ này xin được tiếp. 0 = xin được ngay. */
export async function cooldownFor(address: string): Promise<number> {
  const cooldown = faucetCooldownSeconds();
  if (cooldown === 0 || !isDatabaseConfigured()) return 0;

  const last = await lastClaimAt(FAUCET_NETWORK, address);
  if (!last) return 0;

  const elapsed = (Date.now() - last.getTime()) / 1_000;
  return Math.max(0, Math.ceil(cooldown - elapsed));
}

/** Còn bao nhiêu giây nữa faucet dựng được giao dịch tiếp theo. 0 = dựng được ngay. */
async function settleWait(): Promise<number> {
  const last = await lastSentAt(FAUCET_NETWORK);
  if (!last) return 0;

  const elapsed = (Date.now() - last.getTime()) / 1_000;
  return Math.max(0, Math.ceil(CHAIN_SETTLE_SECONDS - elapsed));
}

/* ------------------------------------------------------------------ */
/* Phát                                                                */
/* ------------------------------------------------------------------ */

export type ClaimOutcome =
  | {
      ok: true;
      txHash: string;
      explorerUrl: string;
      address: string;
      assets: { symbol: string; amount: string; unit: string; mode: DripMode }[];
      ada: string;
      cooldownSeconds: number;
    }
  | { ok: false; status: 400 | 409 | 429 | 503; error: string; retryAfter?: number };

export type ClaimInput = {
  address: string;
  /** Chỉ phát những unit này; bỏ trống = phát tất cả token trong registry. */
  units?: string[];
  clientKey?: string | null;
};

export async function claimFaucet(input: ClaimInput): Promise<ClaimOutcome> {
  const address = input.address.trim();

  if (!looksLikePaymentAddress(address)) {
    return { ok: false, status: 400, error: "Địa chỉ không phải payment address bech32 hợp lệ." };
  }
  if (!addressMatchesCardanoNetwork(address, FAUCET_NETWORK)) {
    return {
      ok: false,
      status: 400,
      error: 'Faucet chỉ phát trên Preprod — địa chỉ phải bắt đầu bằng "addr_test1".',
    };
  }

  const status = await getFaucetStatus();
  if (!status.enabled) {
    return { ok: false, status: 503, error: status.reason ?? "Faucet chưa sẵn sàng." };
  }

  const resolution = loadFaucetWallet();
  // status.enabled đã bao hàm điều này; nhánh dưới chỉ để TS thu hẹp kiểu.
  if (!resolution.ok) return { ok: false, status: 503, error: resolution.error };
  const faucet = resolution.value;

  const registry = getStablecoins(FAUCET_NETWORK);
  let tokens = registry;

  if (input.units && input.units.length > 0) {
    const wanted = new Set(input.units);
    const unknown = [...wanted].filter((unit) => !registry.some((token) => token.unit === unit));
    if (unknown.length > 0) {
      return {
        ok: false,
        status: 400,
        error: `Token không nằm trong danh mục Preprod: ${unknown.join(", ")}.`,
      };
    }
    tokens = registry.filter((token) => wanted.has(token.unit));
  }

  if (tokens.length === 0) {
    return { ok: false, status: 400, error: "Không có token nào để phát." };
  }

  const plan = planDrip(tokens, faucet.policyId);
  const lovelace = faucetLovelace();
  const cooldown = faucetCooldownSeconds();

  const outcome = await withFaucetLock(async (): Promise<ClaimOutcome> => {
    // Lượt phát trước còn trong mempool thì ví chưa có UTxO mới để tiêu — xem
    // CHAIN_SETTLE_SECONDS.
    const settling = await settleWait();
    if (settling > 0) {
      return {
        ok: false,
        status: 409,
        error: `Faucet vừa phát cho người khác, đang chờ giao dịch vào block. Thử lại sau ${settling} giây.`,
        retryAfter: settling,
      };
    }

    // Cooldown được kiểm TRONG khoá, nên không có khe hở nào để hai request song song
    // cùng đọc "chưa từng xin" rồi cùng được phát.
    const waitFor = await cooldownFor(address);
    if (waitFor > 0) {
      return {
        ok: false,
        status: 429,
        error: `Địa chỉ này vừa nhận rồi. Xin lại sau ${formatDuration(waitFor)}.`,
        retryAfter: waitFor,
      };
    }

    // Đọc số dư ngay trước khi dựng giao dịch: nói "faucet hết ADA" rõ ràng hơn hẳn
    // việc để Mesh ném ra một lỗi chọn UTxO khó hiểu.
    let balance: WalletBalance;
    try {
      balance = await readBalance(faucet.wallet);
    } catch (error) {
      return {
        ok: false,
        status: 503,
        error: `Không đọc được số dư ví faucet: ${describeError(error)}`,
      };
    }

    if (balance.lovelace < lovelace + WALLET_RESERVE_LOVELACE) {
      return {
        ok: false,
        status: 503,
        error: `Ví faucet chỉ còn ${formatAmount(balance.lovelace, ADA_DECIMALS)} ADA, không đủ để phát.`,
      };
    }

    for (const item of plan) {
      if (item.mode !== "transfer") continue;
      const held = balance.byUnit.get(item.token.unit) ?? 0n;
      if (held < item.quantity) {
        return {
          ok: false,
          status: 503,
          error:
            `Ví faucet chỉ còn ${formatAmount(held, item.token.decimals)} ${item.token.symbol}, ` +
            `cần ${formatAmount(item.quantity, item.token.decimals)}.`,
        };
      }
    }

    const claimAssets: ClaimAsset[] = plan.map((item) => ({
      unit: item.token.unit,
      symbol: item.token.symbol,
      quantity: item.quantity.toString(),
      mode: item.mode,
    }));

    const claimId = await insertPendingClaim({
      network: FAUCET_NETWORK,
      address,
      clientKey: input.clientKey ?? null,
      assets: claimAssets,
      lovelace,
    });

    try {
      const tx = new Transaction({ initiator: faucet.wallet });

      for (const item of plan) {
        if (item.mode !== "mint" || !item.assetName) continue;
        // KHÔNG truyền `recipient` cho mintAsset: nó sẽ tạo thêm một output riêng cho
        // từng token, mà mỗi output lại phải tự đạt min-ADA — 4 token thành ~5 ADA mỗi
        // lượt phát. Token vừa đúc nằm trong giá trị của giao dịch, và output bên dưới
        // gom tất cả vào một chỗ.
        tx.mintAsset(faucet.forgeScript, {
          assetName: item.assetName,
          assetQuantity: item.quantity.toString(),
        });
      }

      tx.sendAssets(address, [
        { unit: "lovelace", quantity: lovelace.toString() },
        ...plan.map((item) => ({ unit: item.token.unit, quantity: item.quantity.toString() })),
      ]);

      // CIP-20: một dòng chữ để người đọc explorer biết đây là faucet chứ không phải
      // một khoản thanh toán. Giữ ASCII ngắn — metadata Cardano giới hạn 64 BYTE mỗi chuỗi.
      tx.setMetadata(674, { msg: ["cardano-pay testnet faucet"] });

      const unsigned = await tx.build();
      const signed = await faucet.wallet.signTx(unsigned);
      const txHash = await faucet.wallet.submitTx(signed);

      await markClaimSent(claimId, txHash);

      return {
        ok: true,
        txHash,
        explorerUrl: cardanoTxUrl(FAUCET_NETWORK, txHash),
        address,
        assets: plan.map((item) => ({
          symbol: item.token.symbol,
          amount: formatAmount(item.quantity, item.token.decimals),
          unit: item.token.unit,
          mode: item.mode,
        })),
        ada: formatAmount(lovelace, ADA_DECIMALS),
        cooldownSeconds: cooldown,
      };
    } catch (error) {
      const message = describeError(error, "Không dựng/gửi được giao dịch faucet.");
      await markClaimFailed(claimId, message).catch(() => {});
      console.error("[faucet] phát thất bại:", error);
      return { ok: false, status: 503, error: `Phát thất bại: ${message}` };
    }
  });

  if (outcome === null) {
    // Một ví chỉ dựng được một giao dịch tại một thời điểm — xem withFaucetLock.
    return {
      ok: false,
      status: 409,
      error: "Faucet đang phát cho người khác. Thử lại sau vài giây.",
      retryAfter: 5,
    };
  }

  return outcome;
}

/** "2 giờ 5 phút" — số giây trần trụi rất khó đọc khi cooldown là 24 giờ. */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} giây`;

  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} phút`;

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} giờ` : `${hours} giờ ${rest} phút`;
}
