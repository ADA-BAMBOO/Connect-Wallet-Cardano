import "server-only";

import {
  type CardanoNetwork,
  networkFromBlockfrostKey,
  networkMeta,
} from "@/lib/network";
import type { TxInfo, TxMetadataEntry, TxOutput } from "@/lib/payment-verify";

/**
 * Client Blockfrost theo từng mạng.
 *
 * Chạy song song mainnet và preprod nghĩa là phải có HAI key, vì một project id của
 * Blockfrost chỉ nói chuyện được với đúng một mạng. Toàn bộ file này tồn tại để bảo
 * đảm một điều: đơn hàng của mạng nào thì chỉ được đối chiếu với chain của mạng đó.
 */

const ENV_BY_NETWORK: Record<CardanoNetwork, string> = {
  mainnet: "BLOCKFROST_API_KEY_MAINNET",
  preprod: "BLOCKFROST_API_KEY_PREPROD",
  preview: "BLOCKFROST_API_KEY_PREVIEW",
};

export type KeyResolution =
  | { ok: true; key: string; source: string }
  | { ok: false; error: string };

/**
 * Lấy key cho một mạng, kèm kiểm tra prefix.
 *
 * Đây là chốt chặn quan trọng nhất trong file. Đặt key preprod vào ô mainnet thì đơn
 * mainnet sẽ được xác minh trên chain preprod — mà ADA preprod xin miễn phí ở faucet.
 * Cấu hình sai kiểu đó phải hỏng ngay và ồn ào, tuyệt đối không được chạy tiếp.
 */
export function resolveBlockfrostKey(network: CardanoNetwork): KeyResolution {
  const envName = ENV_BY_NETWORK[network];
  const specific = process.env[envName]?.trim();

  if (specific) {
    const actual = networkFromBlockfrostKey(specific);
    if (actual !== network) {
      return {
        ok: false,
        error:
          `${envName} chứa key của mạng "${actual ?? "không nhận ra"}" chứ không phải "${network}". ` +
          `Project id của Blockfrost phải bắt đầu bằng "${network}".`,
      };
    }
    return { ok: true, key: specific, source: envName };
  }

  // Tương thích ngược: dự án vốn chỉ có một BLOCKFROST_API_KEY dùng cho /api/assets.
  // Vẫn nhận, nhưng chỉ cho đúng mạng mà chính prefix của nó khai.
  const legacy = process.env.BLOCKFROST_API_KEY?.trim();
  if (legacy && networkFromBlockfrostKey(legacy) === network) {
    return { ok: true, key: legacy, source: "BLOCKFROST_API_KEY" };
  }

  return { ok: false, error: `Chưa cấu hình ${envName}.` };
}

export function isBlockfrostConfigured(network: CardanoNetwork): boolean {
  return resolveBlockfrostKey(network).ok;
}

export class BlockfrostError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "BlockfrostError";
  }
}

type FetchOptions = {
  /** Số lần thử lại khi gặp 429/5xx (mặc định 3). */
  retries?: number;
  /** Truyền thẳng cho `fetch` — dùng cho `next: { revalidate }`. */
  init?: RequestInit;
};

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Gọi Blockfrost. Trả về null khi 404 (tài nguyên chưa tồn tại — giao dịch chưa lên
 * chain là chuyện bình thường, không phải lỗi), ném BlockfrostError với các lỗi khác.
 */
export async function blockfrostFetch<T>(
  network: CardanoNetwork,
  path: string,
  options: FetchOptions = {},
): Promise<T | null> {
  const resolution = resolveBlockfrostKey(network);
  if (!resolution.ok) throw new BlockfrostError(0, path, resolution.error);

  const { retries = 3, init } = options;
  const url = `${networkMeta(network).blockfrostUrl}${path}`;

  let lastError = "";

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      // Lùi dần 300ms, 600ms, 1200ms… Free tier của Blockfrost giới hạn 10 req/s
      // với burst, nên gặp 429 thì chờ mới là cách đúng, không phải thử lại ngay.
      await sleep(300 * 2 ** (attempt - 1));
    }

    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: { project_id: resolution.key, ...init?.headers },
      });
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      continue; // lỗi mạng — thử lại
    }

    if (response.status === 404) return null;
    if (response.ok) return (await response.json()) as T;

    lastError = `HTTP ${response.status} ${await response.text().catch(() => "")}`.trim();
    if (!RETRYABLE_STATUS.has(response.status)) {
      throw new BlockfrostError(response.status, path, lastError);
    }
  }

  throw new BlockfrostError(0, path, `Thất bại sau ${retries + 1} lần thử: ${lastError}`);
}

/* ------------------------------------------------------------------ */
/* Truy vấn dùng cho việc đối chiếu thanh toán                         */
/* ------------------------------------------------------------------ */

/**
 * Blockfrost trả 404 cho giao dịch chưa vào block — kể cả khi nó đang nằm trong
 * mempool. Đó là trạng thái BÌNH THƯỜNG trong 20–60 giây đầu, không phải lỗi, nên
 * mọi hàm dưới đây trả `null` thay vì ném.
 */

export async function getTx(network: CardanoNetwork, txHash: string): Promise<TxInfo | null> {
  return blockfrostFetch<TxInfo>(network, `/txs/${txHash}`);
}

export async function getTxOutputs(
  network: CardanoNetwork,
  txHash: string,
): Promise<TxOutput[] | null> {
  const utxos = await blockfrostFetch<{ outputs: TxOutput[] }>(network, `/txs/${txHash}/utxos`);
  return utxos?.outputs ?? null;
}

export async function getTxMetadata(
  network: CardanoNetwork,
  txHash: string,
): Promise<TxMetadataEntry[] | null> {
  return blockfrostFetch<TxMetadataEntry[]>(network, `/txs/${txHash}/metadata`);
}

export async function getLatestBlockHeight(network: CardanoNetwork): Promise<number | null> {
  const block = await blockfrostFetch<{ height: number }>(network, "/blocks/latest");
  return block?.height ?? null;
}

export type AddressTx = { tx_hash: string; block_height: number; block_time: number };

/**
 * Giao dịch gần nhất tới một địa chỉ, mới nhất trước.
 *
 * Đây là đường quét dự phòng cho những đơn mà người trả không báo được `txHash` —
 * đóng tab ngay sau khi ký, hoặc trả qua QR từ máy khác.
 *
 * `page` bắt đầu từ 1 (quy ước của Blockfrost). Cần phân trang vì một cửa sổ cố định
 * là một khoảng mù im lặng: watcher chết vài giờ, hoặc merchant nhận nhiều giao dịch
 * hơn `count` giữa hai lượt quét, thì những khoản trả cũ rơi ra ngoài và không bao giờ
 * được ghép lại với đơn.
 */
export async function getAddressTransactions(
  network: CardanoNetwork,
  address: string,
  count = 20,
  page = 1,
): Promise<AddressTx[]> {
  const rows = await blockfrostFetch<AddressTx[]>(
    network,
    `/addresses/${address}/transactions?order=desc` +
      `&count=${Math.min(Math.max(count, 1), 100)}&page=${Math.max(page, 1)}`,
  );
  return rows ?? [];
}

/* ------------------------------------------------------------------ */
/* Health                                                              */
/* ------------------------------------------------------------------ */

export type BlockfrostHealth = {
  ok: boolean;
  detail: string;
  source?: string;
  /** networkMagic chain trả về — bằng chứng key nói chuyện đúng mạng. */
  networkMagic?: number;
  latestBlock?: number;
};

/**
 * Kiểm tra key: gọi `/genesis` và đối chiếu networkMagic với mạng mong đợi.
 *
 * Đây là bước xác minh THẬT, khác với kiểm tra prefix ở `resolveBlockfrostKey`.
 * Prefix là chuỗi tự khai, networkMagic là do chain trả về.
 */
export async function checkBlockfrost(network: CardanoNetwork): Promise<BlockfrostHealth> {
  const resolution = resolveBlockfrostKey(network);
  if (!resolution.ok) return { ok: false, detail: resolution.error };

  try {
    const genesis = await blockfrostFetch<{ network_magic: number }>(network, "/genesis");
    if (!genesis) return { ok: false, detail: "/genesis trả về 404.", source: resolution.source };

    const expected = networkMeta(network).networkMagic;
    if (genesis.network_magic !== expected) {
      return {
        ok: false,
        source: resolution.source,
        networkMagic: genesis.network_magic,
        detail:
          `Key nối tới chain có networkMagic ${genesis.network_magic}, nhưng "${network}" ` +
          `phải là ${expected}. Key đang trỏ nhầm mạng.`,
      };
    }

    const block = await blockfrostFetch<{ height: number }>(network, "/blocks/latest");

    return {
      ok: true,
      source: resolution.source,
      networkMagic: genesis.network_magic,
      latestBlock: block?.height,
      detail: `networkMagic ${genesis.network_magic}, block mới nhất ${block?.height ?? "?"}`,
    };
  } catch (error) {
    return {
      ok: false,
      source: resolution.source,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
