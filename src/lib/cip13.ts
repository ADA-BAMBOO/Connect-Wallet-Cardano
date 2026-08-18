/**
 * URI thanh toán theo [CIP-13](https://cips.cardano.org/cip/CIP-13).
 *
 * GIỚI HẠN QUAN TRỌNG: CIP-13 chỉ mô tả được **số ADA**, không mô tả được native
 * asset. Nghĩa là không có cách nào nhét "trả 10 USDM" vào một URI cho ví quét.
 *
 * Nên QR của trang thanh toán đi theo hai đường:
 *
 *   QR chính = URL trang /pay/<ref>. Quét bằng điện thoại rồi mở trong dApp browser
 *              của Eternl/Vespr/Lace — đó là đường DUY NHẤT chạy được cho stablecoin.
 *   QR phụ   = URI CIP-13, chỉ hiện khi đơn trả bằng ADA, cho ví nào hỗ trợ.
 *
 * Không import gì để script kiểm thử nạp thẳng file này được.
 */

const LOVELACE_PER_ADA = 1_000_000n;

/**
 * Sinh URI CIP-13 cho một khoản trả bằng ADA.
 *
 * Trả về null khi không dùng được: địa chỉ rỗng, số tiền không dương, hoặc — quan
 * trọng nhất — khi khoản trả là native token. Trả null thay vì sinh một URI thiếu
 * số tiền, vì URI đó sẽ khiến người dùng gửi nhầm số.
 */
export function cip13PaymentUri(address: string, lovelace: bigint): string | null {
  const trimmed = address.trim();
  if (!trimmed.startsWith("addr") || lovelace <= 0n) return null;

  // Số tiền trong CIP-13 tính bằng ADA. Format thủ công từ bigint để không đi qua
  // số dấu phẩy động — 7,211095 ADA mà lệch một chữ số là trả sai.
  const whole = lovelace / LOVELACE_PER_ADA;
  const fraction = (lovelace % LOVELACE_PER_ADA).toString().padStart(6, "0").replace(/0+$/, "");
  const amount = fraction ? `${whole}.${fraction}` : `${whole}`;

  return `web+cardano:${trimmed}?amount=${amount}`;
}
