/**
 * Đọc IP người gọi từ `x-forwarded-for` — phần THUẦN, không đụng môi trường.
 *
 * Tách ra khỏi rate-limit.ts để test được bằng dữ liệu mẫu. Đây là loại code sai một
 * cách âm thầm: viết nhầm vẫn chạy, vẫn trả về một chuỗi trông như IP, và hạn mức vẫn
 * "hoạt động" — chỉ là không chặn ai cả.
 *
 * Không import gì để script kiểm thử nạp thẳng file này được.
 */

/** Nhiều hơn ngần này thì gần như chắc chắn là gõ nhầm chứ không phải kiến trúc thật. */
export const MAX_PROXY_HOPS = 10;

/**
 * Đọc số proxy tin cậy từ chuỗi cấu hình.
 *
 * Trả về `null` khi giá trị không dùng được, để nơi gọi cảnh báo rồi rơi về 0 — im lặng
 * coi như 0 thì một biến gõ sai sẽ vô hiệu hoá hạn mức mà không ai biết.
 */
export function parseProxyHops(raw: string | undefined | null): number | null {
  const trimmed = raw?.trim();
  if (!trimmed) return 0;

  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 0 || value > MAX_PROXY_HOPS) return null;

  return value;
}

/**
 * IP thật của người gọi, đọc từ chuỗi `x-forwarded-for`.
 *
 * Header này là một DANH SÁCH `client, proxy1, proxy2…`: mỗi proxy nối thêm địa chỉ mà
 * CHÍNH NÓ nhìn thấy vào cuối. Với `hops` proxy tin cậy đứng trước ứng dụng, phần tử do
 * proxy ngoài cùng ghi nằm ở `chain[chain.length - hops]` — và mọi thứ bên TRÁI vị trí
 * đó đều do client tự viết ra.
 *
 * Vì sao không lấy phần tử đầu (cách viết phổ biến nhất): nó chỉ đúng khi có đúng một
 * proxy VÀ client không gửi sẵn header. Client gửi `x-forwarded-for: <ngẫu nhiên>` mỗi
 * request thì mỗi request rơi vào một bucket khác nhau, và hạn mức biến mất hoàn toàn.
 *
 * Trả về `null` khi không kết luận được: chưa khai proxy nào, không có header, hoặc
 * chuỗi ngắn hơn số hop đã khai (cấu hình sai, hoặc có ai đó cắt bớt header). Đoán bừa
 * một phần tử trong những trường hợp đó là tự nhận một giá trị do client kiểm soát.
 */
export function clientIpFromForwarded(header: string | null | undefined, hops: number): string | null {
  if (!Number.isInteger(hops) || hops <= 0) return null;
  if (!header) return null;

  const chain = header
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  const index = chain.length - hops;
  if (index < 0) return null;

  return chain[index] ?? null;
}
