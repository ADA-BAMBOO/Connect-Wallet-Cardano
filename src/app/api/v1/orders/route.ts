import { NextResponse } from "next/server";

import { checkApiKey } from "@/lib/api-key";
import { parseAmount, USD_DECIMALS } from "@/lib/money";
import { isCardanoNetwork } from "@/lib/network";
import { createOrder, getOrderByExternalId, serializeOrder } from "@/lib/orders";
import { getEnabledNetworks } from "@/lib/payment-config";
import { payUrlFor } from "@/lib/public-url";
import { validateReturnUrl } from "@/lib/return-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * API tích hợp dành cho dự án bán hàng (server-to-server).
 *
 * KHÁC GÌ `/api/payments/orders`:
 *   `/api/payments/orders`  — endpoint công khai của trang demo, chặn bằng rate-limit IP
 *   `/api/v1/orders`        — cần khoá API, và cho khai `externalOrderId` + `returnUrl`
 *
 * Hai đường tách riêng vì rào chắn của chúng khác nhau về bản chất. Gộp làm một thì
 * hoặc trang demo phải mang theo khoá API (khoá lộ ra bundle trình duyệt), hoặc
 * `externalOrderId` trở thành thứ trình duyệt bất kỳ khai được — mà đó chính là mã
 * shop dùng để quyết định giao hàng cho ai.
 *
 * ĐỊA CHỈ NHẬN TIỀN vẫn chỉ đến từ biến môi trường, kể cả ở đây. Có khoá API cũng
 * không khai được nơi tiền chảy về.
 */

type CreateBody = {
  network?: unknown;
  amountUsd?: unknown;
  description?: unknown;
  externalOrderId?: unknown;
  returnUrl?: unknown;
};

function unauthorized(check: Extract<ReturnType<typeof checkApiKey>, { ok: false }>) {
  return NextResponse.json({ error: check.error }, { status: check.status });
}

/**
 * POST /api/v1/orders
 *
 * Body:
 *   {
 *     "network":         "preprod",
 *     "amountUsd":       "42.00",
 *     "externalOrderId": "DH-2026-0042",
 *     "description":     "Gói Pro 1 năm",
 *     "returnUrl":       "https://shop.com/don-hang/DH-2026-0042"
 *   }
 *
 * Trả về `{ order, payUrl, reused }`. Redirect khách sang `payUrl`.
 *
 * IDEMPOTENT theo `externalOrderId`: gọi lại với cùng mã đơn trả về đúng đơn cũ và
 * `reused: true` (HTTP 200) thay vì tạo đơn thứ hai (HTTP 201). Nhờ vậy retry sau
 * timeout, khách bấm hai lần, hay job chạy lại đều an toàn.
 */
export async function POST(request: Request) {
  const auth = checkApiKey(request);
  if (!auth.ok) return unauthorized(auth);

  let body: CreateBody;
  try {
    body = (await request.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: "Body không phải JSON hợp lệ." }, { status: 400 });
  }

  const { network, amountUsd, description, externalOrderId, returnUrl } = body ?? {};

  if (!isCardanoNetwork(network)) {
    return NextResponse.json(
      { error: 'Trường "network" phải là mainnet, preprod hoặc preview.' },
      { status: 400 },
    );
  }

  const enabled = getEnabledNetworks();
  if (!enabled.includes(network)) {
    return NextResponse.json(
      {
        error: `Mạng "${network}" chưa sẵn sàng nhận thanh toán.`,
        enabledNetworks: enabled,
        hint: "Xem /api/payments/health để biết còn thiếu cấu hình gì.",
      },
      { status: 409 },
    );
  }

  if (typeof amountUsd !== "string" && typeof amountUsd !== "number") {
    return NextResponse.json({ error: 'Thiếu "amountUsd".' }, { status: 400 });
  }

  const micro = parseAmount(String(amountUsd), USD_DECIMALS);
  if (micro === null) {
    return NextResponse.json(
      { error: "Số tiền không hợp lệ (tối đa 6 chữ số thập phân, không âm)." },
      { status: 400 },
    );
  }

  // Duyệt returnUrl TRƯỚC khi ghi. Vào được cột `return_url` nghĩa là đã qua allowlist,
  // và trang thanh toán dựa hẳn vào bất biến đó thay vì kiểm lại lúc hiển thị.
  const checkedReturn = validateReturnUrl(returnUrl);
  if (!checkedReturn.ok) return NextResponse.json({ error: checkedReturn.error }, { status: 400 });

  const result = await createOrder({
    network,
    amountUsd: micro,
    description: typeof description === "string" ? description : null,
    externalOrderId: typeof externalOrderId === "string" ? externalOrderId : null,
    returnUrl: checkedReturn.url || null,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.code ?? 400 });
  }

  return NextResponse.json(
    {
      order: serializeOrder(result.order),
      payUrl: payUrlFor(result.order.ref, request),
      reused: result.reused,
    },
    { status: result.reused ? 200 : 201 },
  );
}

/**
 * GET /api/v1/orders?network=preprod&externalOrderId=DH-2026-0042
 *
 * Tra ngược từ mã đơn của shop. Dùng khi shop mất `ref` (webhook chưa tới, DB shop
 * rollback…) và cần biết đơn đó rốt cuộc đã trả tiền hay chưa.
 */
export async function GET(request: Request) {
  const auth = checkApiKey(request);
  if (!auth.ok) return unauthorized(auth);

  const url = new URL(request.url);
  const network = url.searchParams.get("network");
  const externalOrderId = url.searchParams.get("externalOrderId");

  if (!isCardanoNetwork(network)) {
    return NextResponse.json({ error: 'Thiếu hoặc sai tham số "network".' }, { status: 400 });
  }
  if (!externalOrderId) {
    return NextResponse.json({ error: 'Thiếu tham số "externalOrderId".' }, { status: 400 });
  }

  const order = await getOrderByExternalId(network, externalOrderId);
  if (!order) return NextResponse.json({ error: "Không tìm thấy đơn hàng." }, { status: 404 });

  return NextResponse.json({
    order: serializeOrder(order),
    payUrl: payUrlFor(order.ref, request),
  });
}
