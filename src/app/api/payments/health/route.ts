import { NextResponse } from "next/server";

import { type BlockfrostHealth, checkBlockfrost } from "@/lib/blockfrost";
import { safeEqual } from "@/lib/constant-time";
import { appliedMigrations, checkDatabase } from "@/lib/db";
import { type CardanoNetwork } from "@/lib/network";
import { getAllNetworkStatus, getPaymentParams } from "@/lib/payment-config";
import { getAdaUsdRate, getPegStatuses } from "@/lib/price";
import { isProxyTrustConfigured, proxyTrustHops } from "@/lib/rate-limit";
import { checkRedis } from "@/lib/redis";
import { ADA, getStablecoinRegistry } from "@/lib/stablecoins";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Tình trạng hạ tầng thanh toán: Postgres, Redis, Blockfrost, cấu hình từng mạng.
 *
 * Đây là thứ `npm run verify:payment` gọi vào. Đi qua HTTP thay vì import trực tiếp
 * để kiểm tra đúng code chạy trong runtime Next thật — cùng cách `verify:api` đang làm.
 *
 * 200 = mọi thứ kiểm tra được đều ổn, 503 = có hỏng hóc. Hợp để cắm vào uptime monitor.
 */

/**
 * Ở production, chi tiết hạ tầng (thông báo lỗi Postgres, mạng nào đang bật) không
 * nên phơi công khai. Dev thì trả đầy đủ vì đó chính là lúc cần đọc.
 */
function isDetailAllowed(request: Request): boolean {
  if (process.env.NODE_ENV !== "production") return true;

  const token = process.env.PAYMENT_HEALTH_TOKEN?.trim();
  return Boolean(token) && safeEqual(request.headers.get("x-health-token"), token);
}

export async function GET(request: Request) {
  const [database, redis] = await Promise.all([checkDatabase(), checkRedis()]);
  const migrations = database.ok ? await appliedMigrations() : null;

  const networkStatus = getAllNetworkStatus();

  // Chỉ gọi Blockfrost cho mạng đã cấu hình key — tránh gọi thừa và tránh báo lỗi
  // cho mạng mà người dùng cố ý không dùng.
  const blockfrostChecks = await Promise.all(
    networkStatus.map(async (status): Promise<[CardanoNetwork, BlockfrostHealth | null]> => [
      status.network,
      status.blockfrostConfigured ? await checkBlockfrost(status.network) : null,
    ]),
  );
  const blockfrostByNetwork = new Map(blockfrostChecks);

  // Tỷ giá là toàn cục (ADA/USD không phụ thuộc mạng); peg thì theo từng mạng vì
  // danh mục token khác nhau.
  const [adaRate, pegByNetwork] = await Promise.all([
    getAdaUsdRate(),
    Promise.all(
      networkStatus.map(async (status) => [status.network, await getPegStatuses(status.network)] as const),
    ).then((entries) => new Map(entries)),
  ]);

  const networks = networkStatus.map((status) => {
    const blockfrost = blockfrostByNetwork.get(status.network) ?? null;
    const registry = getStablecoinRegistry(status.network);

    return {
      network: status.network,
      enabled: status.enabled,
      problems: status.problems,
      reason: status.reason,
      merchantAddress: status.merchant.ok ? status.merchant.address : null,
      merchantError: status.merchant.ok ? undefined : status.merchant.error,
      // Key chưa phân giải được thì không có gì để gọi — nhưng vẫn phải nói RÕ vì sao,
      // vì "key trỏ nhầm mạng" là lỗi nguy hiểm nhất trong khối cấu hình này.
      blockfrost: blockfrost ?? (status.blockfrostError ? { ok: false, detail: status.blockfrostError } : null),
      tokens: [ADA, ...registry.tokens].map((token) => ({
        symbol: token.symbol,
        unit: token.unit,
        decimals: token.decimals,
        pegged: token.pegged,
        source: token.source,
      })),
      registryIssues: registry.issues.map((issue) => `${issue.envName}: ${issue.message}`),
      // Env ghi đè một token dựng sẵn của mainnet nghĩa là đổi chính policy id được
      // coi là tiền thật. Hợp lệ, nhưng không bao giờ được im lặng.
      registryOverridesBuiltin: registry.overridesBuiltin,
      peg: (pegByNetwork.get(status.network) ?? []).map((entry) => ({
        symbol: entry.symbol,
        state: entry.status.state,
        acceptable: entry.acceptable,
        deviationBps: entry.status.state === "unknown" ? null : entry.status.deviationBps,
        reason: entry.status.state === "unknown" ? entry.status.reason : undefined,
      })),
    };
  });

  const enabled = networks.filter((entry) => entry.enabled);

  // `ok`  = hạ tầng dùng chung còn sống.
  // `ready` = thực sự nhận được thanh toán trên ít nhất một mạng.
  const ok = database.ok && redis.ok;
  const ready =
    ok &&
    migrations !== null &&
    migrations.length > 0 &&
    enabled.length > 0 &&
    enabled.every((entry) => entry.blockfrost?.ok);

  if (!isDetailAllowed(request)) {
    return NextResponse.json({ ok, ready }, { status: ok ? 200 : 503 });
  }

  return NextResponse.json(
    {
      ok,
      ready,
      checkedAt: new Date().toISOString(),
      database: { ...database, migrations },
      redis,
      params: getPaymentParams(),
      // Chưa khai proxy tin cậy thì `x-forwarded-for` là header client tự viết, và hạn
      // mức theo IP không định danh được ai. Hàng rào vẫn còn (một hạn mức tổng cho cả
      // endpoint), nhưng đây là thứ phải nhìn thấy chứ không im lặng.
      rateLimit: {
        trustedProxyHops: proxyTrustHops(),
        perClientTrusted: isProxyTrustConfigured(),
        note: isProxyTrustConfigured()
          ? undefined
          : "Chưa đặt TRUSTED_PROXY_HOPS — hạn mức theo IP không đáng tin, đang dùng thêm hạn mức tổng.",
      },
      // bigint không JSON hoá được — đưa ra dạng chuỗi micro-USD, kèm một bản đọc
      // được cho người xem.
      adaRate: adaRate.ok
        ? {
            ok: true,
            microUsdPerAda: adaRate.value.rate.toString(),
            usdPerAda: (Number(adaRate.value.rate) / 1e6).toFixed(6),
            sources: adaRate.value.sources,
            spreadBps: adaRate.value.spreadBps,
            cached: adaRate.value.cached,
            fetchedAt: new Date(adaRate.value.fetchedAt).toISOString(),
          }
        : {
            ok: false,
            error: adaRate.error,
            sources: adaRate.sources,
            rejected: adaRate.rejected.map((quote) => `${quote.name}: ${quote.error ?? "?"}`),
          },
      networks,
    },
    { status: ok ? 200 : 503 },
  );
}
