import { randomInt } from "node:crypto";

/**
 * Sinh và kiểm tra mã đơn hàng (`ref`).
 *
 * `ref` được nhúng vào metadata CIP-20 của giao dịch ("pay:<ref>"), hiện trên màn
 * hình ví, in trên hoá đơn, đọc to qua điện thoại và gõ lại từ QR. Nên bảng chữ cái
 * bỏ hẳn những ký tự dễ nhìn nhầm.
 */

/**
 * Kiểu Base58: bỏ `I`, `O`, `l`; giữ lại `1`, `0`.
 *
 * Mỗi cặp dễ nhầm chỉ giữ MỘT đại diện — giữ chữ số, bỏ chữ cái. 59 ký tự.
 *
 * PHẢI khớp với ràng buộc CHECK trong migrations/001_payment_orders.sql
 * (`^[0-9A-HJ-NP-Za-km-z]{6,32}$`). Lệch nhau thì mã sinh ra bị Postgres từ chối —
 * verify:payment kiểm tra điều này.
 */
export const REF_ALPHABET = "0123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export const REF_LENGTH = 8;

/** Đúng biểu thức mà tầng dữ liệu dùng. */
const REF_PATTERN = /^[0-9A-HJ-NP-Za-km-z]{6,32}$/;

/**
 * Sinh mã đơn ngẫu nhiên.
 *
 * Dùng `randomInt` của node:crypto chứ không phải `Math.random()`: mã đơn nằm trong
 * URL trang thanh toán, nên đoán được mã là đọc được đơn của người khác. `randomInt`
 * vừa dùng nguồn ngẫu nhiên mật mã, vừa loại bỏ lệch do phép chia dư — 59 không chia
 * hết cho luỹ thừa của 2, nên `bytes[i] % 59` sẽ thiên vị các ký tự đầu bảng.
 *
 * 59^8 ≈ 1,5 × 10^14 tổ hợp.
 */
export function generateRef(length = REF_LENGTH): string {
  let ref = "";
  for (let i = 0; i < length; i++) {
    ref += REF_ALPHABET[randomInt(0, REF_ALPHABET.length)];
  }
  return ref;
}

export function isValidRef(value: unknown): value is string {
  return typeof value === "string" && REF_PATTERN.test(value);
}
