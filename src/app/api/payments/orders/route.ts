import { NextResponse } from "next/server";

import { checkAdmin } from "@/lib/admin";
import { parseAmount, USD_DECIMALS } from "@/lib/money";
import { isCardanoNetwork } from "@/lib/network";
import { createOrder, listOrders, serializeOrder } from "@/lib/orders";
import { getEnabledNetworks, orderCreateLimit } from "@/lib/payment-config";
import { guardRequest } from "@/lib/rate-limit";
import { getDictionary } from "@/lib/i18n/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CREATE_WINDOW_SECONDS = 3_600;

/**
 * POST /api/payments/orders
 *
 * Body: { network, amountUsd: "10.50", description?: "..." }
 *
 * Địa chỉ nhận KHÔNG nằm trong body và không bao giờ được phép nằm ở đó — nó lấy từ
 * biến môi trường rồi sao vào đơn. Xem chú thích ở payment-config.ts.
 */
export async function POST(request: Request) {
  const t = await getDictionary();
  const limit = await guardRequest(request, "orders:create", orderCreateLimit(), CREATE_WINDOW_SECONDS);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: `Quá nhiều đơn được tạo. Thử lại sau ${limit.resetIn} giây.` },
      { status: 429, headers: { "retry-after": String(limit.resetIn) } },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: t.api.badJson }, { status: 400 });
  }

  const { network, amountUsd, description } = (body ?? {}) as Record<string, unknown>;

  if (!isCardanoNetwork(network)) {
    return NextResponse.json(
      { error: 'Trường "network" phải là mainnet, preprod hoặc preview.' },
      { status: 400 },
    );
  }

  // Nói rõ mạng nào đang dùng được thay vì chỉ báo "không khả dụng" — người gọi
  // không đọc được biến môi trường của server.
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
      { error: t.api.invalidAmount },
      { status: 400 },
    );
  }

  const result = await createOrder({
    network,
    amountUsd: micro,
    description: typeof description === "string" ? description : null,
  });

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  return NextResponse.json({ order: serializeOrder(result.order) }, { status: 201 });
}

/**
 * GET /api/payments/orders?network=preprod&limit=25
 *
 * Sổ đơn hàng để đối soát — CẦN QUYỀN QUẢN TRỊ.
 *
 * Danh sách này để lộ số tiền, địa chỉ merchant, địa chỉ người trả và txHash của mọi
 * đơn; biết được `ref` của người khác còn xem được cả trang thanh toán của họ. Đây là
 * sổ sách kinh doanh, không phải dữ liệu công khai. Xem lib/admin.ts.
 */
export async function GET(request: Request) {
  const t = await getDictionary();
  const admin = await checkAdmin();
  if (!admin.ok) return NextResponse.json({ error: admin.error }, { status: admin.status });

  const url = new URL(request.url);
  const networkParam = url.searchParams.get("network");
  const limitParam = Number(url.searchParams.get("limit") ?? 25);

  if (networkParam !== null && !isCardanoNetwork(networkParam)) {
    return NextResponse.json({ error: t.api.invalidNetwork }, { status: 400 });
  }

  const orders = await listOrders({
    network: networkParam ?? undefined,
    limit: Number.isFinite(limitParam) ? limitParam : 25,
  });

  return NextResponse.json({ orders: orders.map(serializeOrder) });
}
