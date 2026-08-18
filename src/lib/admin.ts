import "server-only";

import { cookies } from "next/headers";

import { readSessionToken, SESSION_COOKIE, type Session } from "@/lib/auth-server";

/**
 * Ai được xem sổ đơn hàng.
 *
 * Danh sách đơn để lộ số tiền, địa chỉ merchant, địa chỉ người trả và txHash — nó là
 * sổ sách kinh doanh, không phải dữ liệu công khai. Biết được `ref` của người khác
 * còn xem được cả trang thanh toán của họ.
 *
 * Quyền dựa trên phiên đăng nhập bằng ví (CIP-8) vốn đã có sẵn: chữ ký chứng minh
 * người dùng thật sự sở hữu địa chỉ đó. Nhưng "đăng nhập được" chưa phải "được xem" —
 * bất kỳ ví nào cũng đăng nhập được — nên phải có thêm danh sách địa chỉ quản trị.
 */

const ENV_NAME = "PAYMENT_ADMIN_ADDRESSES";

/** Danh sách địa chỉ quản trị, phân tách bằng dấu phẩy. Chấp nhận cả stake lẫn payment address. */
function adminAddresses(): string[] {
  return (process.env[ENV_NAME] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export type AdminCheck =
  | { ok: true; session: Session | null; reason: "dev-open" | "allowlisted" }
  | { ok: false; status: 401 | 403; error: string };

/**
 * Kiểm quyền xem sổ đơn hàng.
 *
 * Chưa cấu hình `PAYMENT_ADMIN_ADDRESSES`:
 *   - dev        → cho qua, vì bắt đăng nhập mới xem được sổ lúc đang code là phiền vô ích
 *   - production → CHẶN, không phải cho qua
 *
 * Fail-closed ở production là điều bắt buộc: quên cấu hình mà mặc định mở nghĩa là sổ
 * sách nằm công khai trên internet, và không có gì báo cho bạn biết.
 */
export async function checkAdmin(): Promise<AdminCheck> {
  const allowlist = adminAddresses();
  const store = await cookies();
  const session = readSessionToken(store.get(SESSION_COOKIE)?.value);

  if (allowlist.length === 0) {
    if (process.env.NODE_ENV !== "production") {
      return { ok: true, session, reason: "dev-open" };
    }
    return {
      ok: false,
      status: 403,
      error: `Chưa cấu hình ${ENV_NAME} nên sổ đơn hàng bị khoá. Thêm địa chỉ ví quản trị vào biến này.`,
    };
  }

  if (!session) {
    return { ok: false, status: 401, error: "Cần đăng nhập bằng ví để xem sổ đơn hàng." };
  }

  if (!allowlist.includes(session.address)) {
    return {
      ok: false,
      status: 403,
      error: "Địa chỉ này không nằm trong danh sách quản trị.",
    };
  }

  return { ok: true, session, reason: "allowlisted" };
}

/** true nếu đang ở chế độ mở của dev — trang dashboard hiện cảnh báo dựa vào cờ này. */
export function isAdminAllowlistConfigured(): boolean {
  return adminAddresses().length > 0;
}
