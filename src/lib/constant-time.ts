import "server-only";

import { timingSafeEqual } from "node:crypto";

/**
 * So sánh hai chuỗi bí mật mà không thoát sớm ở byte đầu khác nhau.
 *
 * `a === b` trên chuỗi dừng ngay tại ký tự lệch đầu tiên, nên thời gian chạy tỉ lệ với
 * số ký tự đầu ĐÚNG. Về lý thuyết, kẻ tấn công đo đủ nhiều lần có thể dò ra bí mật
 * từng ký tự một.
 *
 * Qua mạng thì độ nhiễu lớn hơn chênh lệch đó nhiều bậc, nên khai thác thật gần như
 * không khả thi — đây là chuyện nhất quán chứ không phải khẩn cấp. Nhưng khi trong dự
 * án đã có một chỗ làm đúng (`readSessionToken`), mọi chỗ còn lại nên dùng chung một
 * hàm, thay vì để người đọc sau phải đoán xem chỗ nào cố ý và chỗ nào bỏ sót.
 *
 * LƯU Ý: độ dài vẫn rò rỉ. Không tránh được, và cũng không đáng lo — biết độ dài của
 * một bí mật 32 byte ngẫu nhiên không giúp đoán được nó.
 */
export function safeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;

  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");

  // `timingSafeEqual` ném lỗi nếu hai buffer khác độ dài, nên phải chặn trước.
  if (left.length !== right.length) return false;

  return timingSafeEqual(left, right);
}
