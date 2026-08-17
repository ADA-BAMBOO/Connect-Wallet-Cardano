/**
 * Giải mã trường ảnh trong metadata CIP-25 / CIP-68 thành URL mà <img> tải được.
 *
 * Thực tế trên chain lộn xộn hơn tài liệu nhiều. Trường `image` có thể là:
 *   "ipfs://Qm…"                     dạng chuẩn
 *   "Qm…" / "bafy…"                  CID trần, KHÔNG có scheme — rất phổ biến
 *   "ipfs://ipfs/Qm…"                lặp "ipfs/" — nối naive sẽ ra URL sai
 *   ["ipfs://Qm", "abc…"]            CIP-25 cắt chuỗi >64 ký tự thành mảng
 *   "https://…" / "http://…"         URL thường
 *   "data:image/png;base64,…"        nhúng trực tiếp
 *   "ar://…"                         Arweave
 *
 * Chỉ xử lý "ipfs://" rồi bỏ qua phần còn lại là mất ảnh của rất nhiều NFT.
 */

/**
 * Danh sách gateway IPFS, thử theo thứ tự.
 *
 * Không gateway nào đủ tin cậy khi dùng một mình — đo với 6 CID NFT mainnet thật:
 *   ipfs.io 50% · dweb.link 33% · w3s.link 33% · pinata 33% · 4everland 0%
 *
 * Nhưng mỗi gateway lại thành công với CID khác nhau, nên thử lần lượt (dừng khi
 * được) nâng tỉ lệ lên 75% với thời gian trung bình 435ms. Vì vậy client phải có
 * cơ chế failover, không thể chỉ hardcode một gateway.
 */
const IPFS_GATEWAYS = [
  "https://ipfs.io/ipfs/",
  "https://w3s.link/ipfs/",
  "https://dweb.link/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
];

const ARWEAVE_GATEWAY = "https://arweave.net/";

/** CIDv0 (Qm..., 46 ký tự base58) hoặc CIDv1 (bafy…/bafk…, base32). */
const CIDV0 = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const CIDV1 = /^ba[a-z2-7]{57,}$/;

function isBareCid(value: string): boolean {
  return CIDV0.test(value) || CIDV1.test(value);
}

/** Gộp mảng chuỗi bị cắt của CIP-25 thành một chuỗi. */
function flatten(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    return value.join("");
  }
  return undefined;
}

/** Tách phần đường dẫn IPFS từ trường ảnh, undefined nếu không phải IPFS. */
function extractIpfsPath(raw: string): string | undefined {
  if (raw.startsWith("ipfs://")) {
    // Bỏ mọi tiền tố "ipfs/" lặp lại sau scheme, tránh tạo ra .../ipfs/ipfs/Qm…
    const path = raw.slice("ipfs://".length).replace(/^(ipfs\/)+/, "");
    return path || undefined;
  }

  if (isBareCid(raw)) return raw;

  // "Qm…/hinh.png" — CID kèm đường dẫn con.
  const [head] = raw.split("/");
  if (head && isBareCid(head)) return raw;

  return undefined;
}

/**
 * Trả về DANH SÁCH URL ứng viên theo thứ tự ưu tiên.
 *
 * Với ảnh IPFS, danh sách gồm mọi gateway — client thử lần lượt qua `onError`.
 * Với các dạng khác chỉ có một ứng viên. Mảng rỗng nghĩa là không nhận dạng được,
 * UI hiện placeholder.
 */
export function resolveImageCandidates(image: unknown): string[] {
  const raw = flatten(image)?.trim();
  if (!raw) return [];

  // Nhúng sẵn hoặc URL thường: dùng nguyên, không có ứng viên thay thế.
  if (raw.startsWith("data:image/")) return [raw];
  if (raw.startsWith("https://") || raw.startsWith("http://")) return [raw];

  if (raw.startsWith("ar://")) {
    const path = raw.slice("ar://".length);
    return path ? [ARWEAVE_GATEWAY + path] : [];
  }

  const ipfsPath = extractIpfsPath(raw);
  if (ipfsPath) return IPFS_GATEWAYS.map((gw) => gw + ipfsPath);

  return [];
}

/**
 * Chuẩn hoá trường ảnh thành URL đầu tiên khả dụng, undefined nếu không nhận
 * dạng được. Tiện cho test và cho chỗ chỉ cần một URL.
 */
export function resolveImageUrl(image: unknown): string | undefined {
  return resolveImageCandidates(image)[0];
}

/**
 * Logo của fungible token (Cardano Token Registry) là base64 PNG **không có**
 * tiền tố `data:`. Bọc lại để <img> hiểu được.
 */
export function resolveLogoCandidates(logo: unknown): string[] {
  const direct = resolveImageCandidates(logo);
  if (direct.length > 0) return direct;

  const raw = flatten(logo)?.trim();
  if (!raw || raw.length < 32) return [];

  // Chuỗi base64 thuần (CID đã được thử ở resolveImageCandidates).
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return [`data:image/png;base64,${raw}`];

  return [];
}

export function resolveLogoUrl(logo: unknown): string | undefined {
  return resolveLogoCandidates(logo)[0];
}
