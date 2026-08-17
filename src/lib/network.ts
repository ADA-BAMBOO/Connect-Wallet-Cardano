/**
 * Nhận diện mạng Cardano từ networkId do ví trả về (CIP-30 `getNetworkId`).
 * 0 = testnet (preprod / preview), 1 = mainnet.
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
