import { NextResponse } from "next/server";

import { claimFaucet, faucetClaimLimit } from "@/lib/faucet";
import { clientKey, guardRequest } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CLAIM_WINDOW_SECONDS = 3_600;

/**
 * POST /api/faucet/claim
 *
 * Body: { address: "addr_test1…", units?: ["<policyId><assetNameHex>", …] }
 *
 * Hai tầng chặn, cố ý khác nhau:
 *   - tầng này  — theo IP, chặn vòng lặp curl trước khi nó đụng tới Blockfrost và ví;
 *   - tầng dưới — theo ĐỊA CHỈ nhận (cooldown trong Postgres), chặn đúng thứ mà đổi IP
 *     không lách được.
 *
 * Địa chỉ nhận đến từ body ở đây, ngược hẳn với luồng thanh toán. Điều đó an toàn vì
 * hướng tiền ngược lại: faucet chỉ CHO đi token thử không có giá trị, còn đơn hàng thì
 * NHẬN tiền — ở đó, để client tự khai địa chỉ nhận là mở đường cho họ tự trả tiền cho
 * chính mình. Xem payment-config.ts.
 */
export async function POST(request: Request) {
  const limit = await guardRequest(request, "faucet:claim", faucetClaimLimit(), CLAIM_WINDOW_SECONDS);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: `Quá nhiều lượt xin. Thử lại sau ${limit.resetIn} giây.` },
      { status: 429, headers: { "retry-after": String(limit.resetIn) } },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body không phải JSON hợp lệ." }, { status: 400 });
  }

  const { address, units } = (body ?? {}) as Record<string, unknown>;

  if (typeof address !== "string" || !address.trim()) {
    return NextResponse.json({ error: 'Thiếu "address".' }, { status: 400 });
  }

  if (units !== undefined && (!Array.isArray(units) || units.some((unit) => typeof unit !== "string"))) {
    return NextResponse.json({ error: '"units" phải là mảng chuỗi.' }, { status: 400 });
  }

  const result = await claimFaucet({
    address,
    units: units as string[] | undefined,
    clientKey: clientKey(request),
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, retryAfter: result.retryAfter },
      {
        status: result.status,
        headers: result.retryAfter ? { "retry-after": String(result.retryAfter) } : undefined,
      },
    );
  }

  return NextResponse.json(result, { status: 201 });
}
