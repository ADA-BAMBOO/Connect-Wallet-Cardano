/**
 * Bắn một webhook `order.confirmed` GIẢ vào Kolo giả lập.
 *
 *   npm run demo:webhook -- KOLO-20260820-0001
 *
 * Dùng để diễn tập bước ③ khi chưa có giao dịch thật trên chain: kiểm tra rằng chữ ký
 * của bên GỬI (src/lib/webhook-signature.ts) được bên NHẬN (integration/cardano-pay-client.ts)
 * chấp nhận, và shop có giao hàng hay không. Đây là chỗ hay hỏng nhất khi deploy hai
 * repo lệch phiên bản.
 *
 * Không đụng gì tới database của cổng thanh toán — nó chỉ gửi một gói tin HTTP.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import nextEnv from "@next/env";

import { createCardanoPayClient } from "../../integration/cardano-pay-client.ts";
import { SIGNATURE_HEADER, signPayload } from "../../src/lib/webhook-signature.ts";

const gatewayRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
nextEnv.loadEnvConfig(gatewayRoot, true);

const shopOrderId = process.argv[2];
if (!shopOrderId) {
  console.error("Thiếu mã đơn. Ví dụ: npm run demo:webhook -- KOLO-20260820-0001");
  process.exit(1);
}

const url = process.env.MERCHANT_WEBHOOK_URL ?? "http://localhost:3100/api/webhooks/kolo-pay";
const secret = process.env.MERCHANT_WEBHOOK_SECRET ?? "";

if (!secret) {
  console.error("Thiếu MERCHANT_WEBHOOK_SECRET trong .env.local.");
  process.exit(1);
}

/*
 * Hỏi cổng thanh toán để lấy `ref` THẬT của đơn này. Shop từ chối webhook mang ref lệch
 * với ref nó đang giữ (xem server.ts), nên bịa một ref sẽ bị bỏ qua — đúng như mong muốn.
 */
const gateway = createCardanoPayClient({
  baseUrl: process.env.PAYMENT_PUBLIC_URL ?? "http://localhost:3000",
  apiKey: (process.env.MERCHANT_API_KEYS ?? "").split(",")[0]?.trim() ?? "",
  network: "preprod",
});

const { order: real } = await gateway.getPaymentByOrderId(shopOrderId).catch((error: unknown) => {
  console.error(`Không tra được đơn ${shopOrderId} ở cổng thanh toán: ${String(error)}`);
  process.exit(1);
});

const body = JSON.stringify({
  event: "order.confirmed",
  occurredAt: new Date().toISOString(),
  data: {
    // Mọi trường đều lấy từ đơn thật; CHỈ `status` bị bịa thành "confirmed" — đó là
    // đúng thứ đang được diễn tập.
    ...real,
    status: "confirmed",
    payment: real.payment ?? {
      unit: "lovelace",
      symbol: "tUSDM",
      decimals: 6,
      quantity: real.amountUsdMicro,
      quantityFormatted: real.amountUsd,
      adaRate: null,
      adaRateUsd: null,
      rateSources: null,
      quoteExpiresAt: null,
      quoteExpired: false,
    },
    tx: real.tx ?? {
      hash: "0".repeat(64),
      blockHeight: "1",
      confirmations: 3,
      receivedQuantity: real.amountUsdMicro,
      metadataOk: true,
    },
    confirmedAt: real.confirmedAt ?? new Date().toISOString(),
  },
});

const timestamp = Math.floor(Date.now() / 1_000);
const signature = signPayload(secret, timestamp, body);

const response = await fetch(url, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    [SIGNATURE_HEADER]: `t=${timestamp},v1=${signature}`,
  },
  body,
});

console.log(`${response.status} ${response.statusText}  ←  ${url}`);
console.log(await response.text());

// `process.exitCode` chứ không phải `process.exit()`: thoát ngay lập tức trong khi
// socket của fetch còn mở làm libuv assert trên Windows.
process.exitCode = response.ok ? 0 : 1;
