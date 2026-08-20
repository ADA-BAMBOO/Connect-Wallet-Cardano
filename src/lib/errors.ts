/**
 * Chuẩn hoá lỗi từ ví CIP-30.
 *
 * Ví KHÔNG ném `Error`. Theo đặc tả CIP-30 chúng ném object thuần `{ code, info }`,
 * nên `String(err)` cho ra "[object Object]" và `err.message` là undefined.
 * Mọi chỗ hiển thị lỗi ví phải đi qua các hàm ở đây.
 *
 * Bảng mã lỗi (CIP-30):
 *   APIError      -1 InvalidRequest · -2 InternalError · -3 Refused · -4 AccountChange
 *   DataSignError  1 ProofGeneration ·  2 AddressNotPK ·  3 UserDeclined
 *   TxSignError    1 ProofGeneration ·  2 UserDeclined
 */

type WalletError = { code?: unknown; info?: unknown; message?: unknown };

function asWalletError(err: unknown): WalletError | null {
  return typeof err === "object" && err !== null ? (err as WalletError) : null;
}

/** Lấy mã lỗi số của CIP-30, null nếu không phải lỗi ví. */
export function walletErrorCode(err: unknown): number | null {
  const code = asWalletError(err)?.code;
  return typeof code === "number" ? code : null;
}

/** Chuyển lỗi bất kỳ thành câu tiếng Việt đọc được. */
export function describeError(err: unknown, fallback = "Đã xảy ra lỗi không xác định."): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err) return err;

  const walletError = asWalletError(err);
  if (walletError) {
    // `info` là mô tả người-đọc-được theo CIP-30.
    if (typeof walletError.info === "string" && walletError.info) return walletError.info;
    if (typeof walletError.message === "string" && walletError.message) return walletError.message;
    if (typeof walletError.code === "number") return `Ví trả về mã lỗi ${walletError.code}.`;
  }

  return fallback;
}

/** true nếu người dùng bấm huỷ/từ chối trong popup ví. */
export function isUserDeclined(err: unknown, kind: "data" | "tx"): boolean {
  const code = walletErrorCode(err);

  // DataSignError.UserDeclined = 3, TxSignError.UserDeclined = 2, APIError.Refused = -3
  if (code === -3) return true;
  if (kind === "data" && code === 3) return true;
  if (kind === "tx" && code === 2) return true;

  return /user declined|declined|denied|refused|rejected|cancel/i.test(describeError(err, ""));
}

/**
 * true nếu ví đang chặn vì bị gọi quá dày ("too many requests").
 *
 * Extension ví tự đặt rate limit cho API CIP-30 của mình — Eternl ném lỗi này từ
 * `getApiError` trong content script. Đây là lỗi TẠM THỜI: chờ một nhịp rồi gọi
 * lại là được, nên đừng hiển thị nó như lỗi cứng và đừng bắt người dùng thao tác
 * lại từ đầu.
 *
 * Không dựa vào mã lỗi: CIP-30 không có mã riêng cho rate limit, ví nhét nó vào
 * APIError.InternalError (-2) — mà -2 còn dùng cho đủ thứ lỗi khác nữa.
 */
export function isRateLimited(err: unknown): boolean {
  return /too many requests|rate.?limit|throttl|429/i.test(describeError(err, ""));
}

/**
 * true nếu ví không ký được bằng địa chỉ này (DataSignError.AddressNotPK = 2),
 * tức là nên thử fallback sang địa chỉ khác thay vì báo lỗi cho người dùng.
 */
export function isAddressNotSupported(err: unknown): boolean {
  if (walletErrorCode(err) === 2) return true;
  return /address.*(not|unsupported|does not)|reward address|stake address/i.test(
    describeError(err, ""),
  );
}

/**
 * true nếu ví báo không ký được dữ liệu (CIP-8), vd Eternl trả về
 * "This wallet doesn't support general data signing."
 *
 * CHỈ dùng để chọn thông điệp hiển thị, TUYỆT ĐỐI KHÔNG dùng để dừng vòng thử
 * địa chỉ. Câu lỗi này mơ hồ: có ví trả về nó khi cả tài khoản không ký được
 * (hardware/multi-sig/read-only), nhưng cũng có ví trả về nó khi chỉ riêng
 * *stake address* bị từ chối — lúc đó payment address vẫn ký bình thường.
 *
 * Từng có lúc code dừng sớm khi gặp lỗi này và làm mất fallback đang chạy được.
 * Đừng lặp lại: chi phí thử tiếp chỉ là một popup, chi phí đoán sai là hỏng hẳn
 * đăng nhập.
 */
export function isDataSigningUnsupported(err: unknown): boolean {
  return /(doesn'?t|does not|not) support.*(general )?data signing|data signing.*not support/i.test(
    describeError(err, ""),
  );
}

/**
 * Đọc JSON từ response một cách an toàn.
 * Route bị crash sẽ trả body rỗng — `res.json()` khi đó ném "Unexpected end of
 * JSON input", che mất lỗi thật. Hàm này đổi nó thành thông báo có ích.
 */
export async function readJsonResponse<T = Record<string, unknown>>(
  res: Response,
): Promise<T | { error: string }> {
  const text = await res.text();

  if (!text) {
    return {
      error: res.ok
        ? "Server trả về phản hồi rỗng."
        : `Server lỗi ${res.status}. Kiểm tra log server để biết chi tiết.`,
    };
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    return { error: `Server trả về phản hồi không hợp lệ (${res.status}).` };
  }
}
