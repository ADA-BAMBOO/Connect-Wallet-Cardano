/**
 * Nhận diện mạng Cardano. File này có HAI lớp, đừng lẫn lộn:
 *
 *  Lớp 1 — phía client, từ ví: CIP-30 `getNetworkId()` chỉ trả 0 hoặc 1.
 *          Ví KHÔNG cho biết đang ở preprod hay preview. Dùng `NetworkInfo`.
 *
 *  Lớp 2 — phía server, từ cấu hình: server biết chính xác nó phục vụ mạng nào
 *          vì chính nó cầm Blockfrost key. Dùng `CardanoNetwork`.
 *
 * Không import gì để chạy được ở cả server, client lẫn script kiểm thử.
 */

export type NetworkInfo = {
  id: 0 | 1;
  /** Tên hiển thị */
  label: string;
  /** true nếu là mạng thật, tiền thật */
  isMainnet: boolean;
  /** Prefix bech32 của địa chỉ trên mạng này */
  addressPrefix: "addr" | "addr_test";
  /** Base URL của explorer để tra cứu tx/địa chỉ */
  explorerUrl: string;
};

const MAINNET: NetworkInfo = {
  id: 1,
  label: "Mainnet",
  isMainnet: true,
  addressPrefix: "addr",
  explorerUrl: "https://cardanoscan.io",
};

const TESTNET: NetworkInfo = {
  id: 0,
  // Ví chỉ trả về 0 cho mọi testnet, không phân biệt được preprod/preview qua CIP-30.
  label: "Testnet (Preprod/Preview)",
  isMainnet: false,
  addressPrefix: "addr_test",
  explorerUrl: "https://preprod.cardanoscan.io",
};

export function getNetworkInfo(networkId: number | undefined): NetworkInfo | null {
  if (networkId === 1) return MAINNET;
  if (networkId === 0) return TESTNET;
  return null;
}

export function txUrl(network: NetworkInfo, txHash: string): string {
  return `${network.explorerUrl}/transaction/${txHash}`;
}

export function addressUrl(network: NetworkInfo, address: string): string {
  return `${network.explorerUrl}/address/${address}`;
}

/**
 * Kiểm tra địa chỉ nhận có khớp mạng đang kết nối không.
 * Đây là lỗi thường gặp nhất khi test: gửi ADA testnet tới địa chỉ mainnet.
 */
export function addressMatchesNetwork(address: string, network: NetworkInfo): boolean {
  const trimmed = address.trim();
  if (network.isMainnet) return trimmed.startsWith("addr1");
  return trimmed.startsWith("addr_test1");
}

/* ------------------------------------------------------------------ */
/* Lớp 2 — mạng theo cấu hình server                                   */
/* ------------------------------------------------------------------ */

export const CARDANO_NETWORKS = ["mainnet", "preprod", "preview"] as const;

export type CardanoNetwork = (typeof CARDANO_NETWORKS)[number];

export function isCardanoNetwork(value: unknown): value is CardanoNetwork {
  return typeof value === "string" && (CARDANO_NETWORKS as readonly string[]).includes(value);
}

type CardanoNetworkMeta = {
  label: string;
  isMainnet: boolean;
  addressPrefix: "addr" | "addr_test";
  explorerUrl: string;
  blockfrostUrl: string;
  /**
   * networkMagic của chính chain đó, đọc được qua `/genesis`.
   *
   * Prefix của Blockfrost key chỉ là chuỗi người ta tự đặt tên; networkMagic là do
   * chain trả về. Đối chiếu số này là cách duy nhất xác nhận key thật sự đang nói
   * chuyện với mạng mình nghĩ.
   */
  networkMagic: number;
};

const NETWORK_META: Record<CardanoNetwork, CardanoNetworkMeta> = {
  mainnet: {
    label: "Mainnet",
    isMainnet: true,
    addressPrefix: "addr",
    explorerUrl: "https://cardanoscan.io",
    blockfrostUrl: "https://cardano-mainnet.blockfrost.io/api/v0",
    networkMagic: 764824073,
  },
  preprod: {
    label: "Preprod",
    isMainnet: false,
    addressPrefix: "addr_test",
    explorerUrl: "https://preprod.cardanoscan.io",
    blockfrostUrl: "https://cardano-preprod.blockfrost.io/api/v0",
    networkMagic: 1,
  },
  preview: {
    label: "Preview",
    isMainnet: false,
    addressPrefix: "addr_test",
    explorerUrl: "https://preview.cardanoscan.io",
    blockfrostUrl: "https://cardano-preview.blockfrost.io/api/v0",
    networkMagic: 2,
  },
};

export function networkMeta(network: CardanoNetwork): CardanoNetworkMeta {
  return NETWORK_META[network];
}

/**
 * Blockfrost project id mã hoá network ngay ở prefix: mainnetXXX / preprodXXX / previewXXX.
 *
 * Đây là nguồn sự thật để biết một key thuộc mạng nào — và là lý do phải kiểm tra
 * key có nằm đúng ô cấu hình không. Nhét key preprod vào ô mainnet nghĩa là đơn hàng
 * mainnet sẽ được đối chiếu với chain preprod: kẻ tấn công trả bằng ADA testnet
 * (xin miễn phí ở faucet) vẫn được ghi nhận đã thanh toán.
 */
export function networkFromBlockfrostKey(key: string): CardanoNetwork | null {
  const trimmed = key.trim();
  for (const network of CARDANO_NETWORKS) {
    if (trimmed.startsWith(network)) return network;
  }
  return null;
}

/**
 * Kiểm tra địa chỉ có thuộc mạng đang xét không.
 *
 * GIỚI HẠN: preprod và preview dùng CHUNG prefix `addr_test1`, nên hàm này chỉ phân
 * biệt được mainnet với testnet. Lẫn preprod/preview phải chặn bằng Blockfrost key,
 * không có cách nào phát hiện qua địa chỉ.
 */
export function addressMatchesCardanoNetwork(address: string, network: CardanoNetwork): boolean {
  const trimmed = address.trim();
  return NETWORK_META[network].isMainnet
    ? trimmed.startsWith("addr1")
    : trimmed.startsWith("addr_test1");
}

/** Địa chỉ payment bech32 hợp lệ về mặt hình thức (chưa kiểm checksum). */
export function looksLikePaymentAddress(value: unknown): value is string {
  return typeof value === "string" && /^addr(_test)?1[02-9ac-hj-np-z]{20,}$/.test(value.trim());
}

export function cardanoTxUrl(network: CardanoNetwork, txHash: string): string {
  return `${NETWORK_META[network].explorerUrl}/transaction/${txHash}`;
}

export function cardanoAddressUrl(network: CardanoNetwork, address: string): string {
  return `${NETWORK_META[network].explorerUrl}/address/${address}`;
}
