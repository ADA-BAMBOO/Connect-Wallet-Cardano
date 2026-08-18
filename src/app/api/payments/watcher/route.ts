import { NextResponse } from "next/server";

import { safeEqual } from "@/lib/constant-time";
import { isCardanoNetwork } from "@/lib/network";
import { getEnabledNetworks } from "@/lib/payment-config";
import { sweepNetwork, type SweepReport } from "@/lib/watcher";
import { dispatchDueWebhooks } from "@/lib/webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Một lượt quét không được chạy quá lâu — cron nào cũng có hạn thời gian. */
export const maxDuration = 60;

/**
 * POST /api/payments/watcher?network=preprod
 *
 * Một lượt đối chiếu on-chain: đánh dấu đơn quá hạn, cập nhật số xác nhận, và tìm ra
 * những khoản đã trả mà người trả không báo lại được.
 *
 * Gọi định kỳ (cron 10–30 giây, hoặc Vercel Cron). Chạy chồng nhau cũng không sao:
 * mỗi đơn được bọc trong một khoá Redis, và ràng buộc ở tầng dữ liệu giữ cho kết quả
 * đúng ngay cả khi khoá hết hạn giữa chừng.
 *
 * VÌ SAO LÀ POLL CHỨ KHÔNG PHẢI WEBHOOK: giao dịch Cardano mất 20–60 giây để vào
 * block, rồi còn chờ đủ số xác nhận. Trong bối cảnh đó, poll mỗi 10 giây chậm hơn
 * webhook một cách không ai cảm nhận được — mà lại chạy được ở local, không cần
 * domain public, và tự quét bù sau khi server sập.
 */

/**
 * Endpoint này thay đổi trạng thái thanh toán nên không được để công khai ở
 * production: ai cũng gọi được nghĩa là ai cũng đốt được hạn mức Blockfrost của bạn.
 * Dev thì mở, vì lúc đó nó chỉ nghe localhost.
 */
function isAuthorized(request: Request): boolean {
  const secret = process.env.PAYMENT_WATCHER_SECRET?.trim();
  if (!secret) return process.env.NODE_ENV !== "production";

  return (
    safeEqual(request.headers.get("authorization"), `Bearer ${secret}`) ||
    safeEqual(request.headers.get("x-watcher-secret"), secret)
  );
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json(
      {
        error:
          "Không có quyền. Đặt PAYMENT_WATCHER_SECRET rồi gửi kèm header " +
          "`authorization: Bearer <secret>`.",
      },
      { status: 401 },
    );
  }

  const url = new URL(request.url);
  const requested = url.searchParams.get("network");

  if (requested !== null && !isCardanoNetwork(requested)) {
    return NextResponse.json({ error: "Tham số network không hợp lệ." }, { status: 400 });
  }

  const enabled = getEnabledNetworks();
  const networks = requested ? enabled.filter((n) => n === requested) : enabled;

  if (networks.length === 0) {
    return NextResponse.json(
      { error: "Không có mạng nào đang bật.", enabledNetworks: enabled },
      { status: 409 },
    );
  }

  const started = Date.now();
  const reports: SweepReport[] = [];

  // Tuần tự chứ không song song: các mạng dùng chung hạn mức Blockfrost, và một lượt
  // quét đã đủ tốn lời gọi rồi.
  for (const network of networks) {
    try {
      reports.push(await sweepNetwork(network));
    } catch (error) {
      // Một mạng hỏng không được kéo theo mạng còn lại.
      console.error(`[watcher] ${network} thất bại:`, error);
      reports.push({
        network,
        expired: 0,
        checked: 0,
        confirmed: 0,
        seen: 0,
        underpaid: 0,
        scannedTxs: 0,
        // Lượt quét hỏng giữa chừng thì theo định nghĩa là chưa xem hết.
        truncated: true,
      });
    }
  }

  // Gửi webhook NGAY TRONG lượt cron này, sau khi quét xong.
  //
  // Lượt quét vừa rồi là thứ đưa đơn sang `confirmed`, nên hàng đợi gần như chắc chắn
  // vừa có việc mới. Đây cũng là đường gửi ĐÁNG TIN CẬY duy nhất: mọi lời gọi cơ hội
  // khác (sau `submit`, sau khi trang thanh toán poll) đều có thể không xảy ra, còn
  // cron thì luôn chạy. Không có nó, một sự kiện thất bại lần đầu sẽ nằm lại mãi.
  let webhooks;
  try {
    webhooks = await dispatchDueWebhooks();
  } catch (error) {
    console.error("[watcher] Gửi webhook thất bại:", error);
    webhooks = { claimed: 0, delivered: 0, retrying: 0, failed: 0, skipped: String(error) };
  }

  return NextResponse.json({ tookMs: Date.now() - started, reports, webhooks });
}
