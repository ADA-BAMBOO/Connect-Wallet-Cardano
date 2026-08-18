import { NextResponse } from "next/server";

import { cooldownFor, getFaucetStatus } from "@/lib/faucet";
import { looksLikePaymentAddress } from "@/lib/network";
import { guardRequest } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/faucet[?address=addr_test1…]
 *
 * Trạng thái faucet: bật hay tắt, phát những gì, mỗi lượt bao nhiêu, ví còn bao nhiêu
 * ADA. Có `address` thì kèm luôn thời gian còn phải chờ của địa chỉ đó.
 *
 * Vì sao công khai được: mọi thứ trả về đều đã công khai sẵn — địa chỉ và số dư ví
 * faucet nằm trên chain, tên biến môi trường nằm trong .env.example đã commit, và đây
 * là faucet testnet. Nói thẳng "còn thiếu STABLECOINS_PREPROD" tiết kiệm cho người
 * test đúng vòng lặp đoán mò mà trang health sinh ra khi nó giấu chi tiết.
 */
export async function GET(request: Request) {
  // Mỗi lượt đọc trạng thái là một lời gọi Blockfrost để lấy số dư — hạn mức ở đây
  // bảo vệ hạn mức Blockfrost, không phải bảo vệ dữ liệu.
  const limit = await guardRequest(request, "faucet:status", 60, 60);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: `Quá nhiều yêu cầu. Thử lại sau ${limit.resetIn} giây.` },
      { status: 429, headers: { "retry-after": String(limit.resetIn) } },
    );
  }

  const status = await getFaucetStatus({ withBalance: true });

  const address = new URL(request.url).searchParams.get("address")?.trim();
  const cooldown =
    address && looksLikePaymentAddress(address) ? await cooldownFor(address).catch(() => null) : null;

  return NextResponse.json({
    ...status,
    // `null` = không hỏi hoặc không tra được; `0` = xin được ngay. Hai chuyện khác nhau.
    cooldownRemaining: cooldown,
  });
}
