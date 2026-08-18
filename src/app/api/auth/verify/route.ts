import { NextResponse } from "next/server";
import { checkSignature } from "@meshsdk/core";
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  consumeNonce,
  createSessionToken,
  getSessionSecretError,
  isValidLoginAddress,
} from "@/lib/auth-server";

export const runtime = "nodejs";

type Body = {
  address?: unknown;
  signature?: { signature?: unknown; key?: unknown };
};

export async function POST(request: Request) {
  // Kiểm tra cấu hình TRƯỚC khi làm gì khác, để lỗi thiếu env hiện ra thành thông
  // báo rõ ràng thay vì làm handler chết với body rỗng.
  const configError = getSessionSecretError();
  if (configError) {
    return NextResponse.json({ error: configError }, { status: 500 });
  }

  let body: Body;

  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Body không phải JSON hợp lệ." }, { status: 400 });
  }

  const { address, signature } = body;

  if (!isValidLoginAddress(address)) {
    return NextResponse.json({ error: "Địa chỉ không hợp lệ." }, { status: 400 });
  }

  if (typeof signature?.signature !== "string" || typeof signature?.key !== "string") {
    return NextResponse.json({ error: "Thiếu chữ ký (signature/key)." }, { status: 400 });
  }

  // Nonce dùng một lần: lấy ra là xoá, dù xác minh thành công hay không.
  const nonce = await consumeNonce(address);
  if (!nonce) {
    return NextResponse.json(
      { error: "Nonce đã hết hạn hoặc không tồn tại. Hãy thử đăng nhập lại." },
      { status: 400 },
    );
  }

  let valid = false;
  try {
    // BẮT BUỘC truyền address làm tham số thứ 3. Nếu bỏ, checkSignature chỉ kiểm
    // tra chữ ký hợp lệ về mặt toán học mà KHÔNG ràng buộc nó với địa chỉ — kẻ tấn
    // công có thể xin nonce của nạn nhân rồi ký bằng ví của chính mình.
    // scripts/verify-auth.mjs chứng minh cả hai chiều của điều này.
    valid = checkSignature(nonce, { signature: signature.signature, key: signature.key }, address);
  } catch {
    valid = false;
  }

  if (!valid) {
    return NextResponse.json({ error: "Chữ ký không hợp lệ." }, { status: 401 });
  }

  const token = createSessionToken(address);
  if (!token) {
    return NextResponse.json({ error: getSessionSecretError() }, { status: 500 });
  }

  // Chữ ký hợp lệ → cấp session. Cookie httpOnly để JS phía client không đọc được.
  const response = NextResponse.json({ ok: true, address });

  response.cookies.set({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });

  return response;
}
