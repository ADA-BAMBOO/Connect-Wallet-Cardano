import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, readSessionToken } from "@/lib/auth-server";

export const runtime = "nodejs";

/** Trả về danh tính đang đăng nhập — nguồn sự thật là cookie httpOnly, không phải state ở client. */
export async function GET() {
  const store = await cookies();
  const session = readSessionToken(store.get(SESSION_COOKIE)?.value);

  if (!session) return NextResponse.json({ authenticated: false });

  return NextResponse.json({
    authenticated: true,
    address: session.address,
    isStakeAddress: session.isStakeAddress,
    expiresAt: session.expiresAt,
  });
}
