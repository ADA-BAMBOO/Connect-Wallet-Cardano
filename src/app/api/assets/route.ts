import { NextResponse } from "next/server";
import { resolveImageCandidates, resolveLogoCandidates } from "@/lib/nft";

export const runtime = "nodejs";

/**
 * Làm giàu metadata cho native asset (tên, ảnh, decimals) qua Blockfrost.
 *
 * Ví CIP-30 chỉ trả về `unit` + `quantity`; muốn có tên và ảnh NFT thì phải hỏi
 * một chain indexer. API key được giữ ở server, không lộ ra client.
 *
 * Không cấu hình key → trả về `enabled: false`, UI tự rơi về hiển thị asset name on-chain.
 */

type AssetMeta = {
  unit: string;
  name?: string;
  /** URL ảnh ứng viên theo thứ tự ưu tiên — client thử lần lượt khi tải lỗi. */
  images?: string[];
  decimals?: number;
};

/** Blockfrost project id đã mã hoá sẵn network ở prefix: mainnet.../preprod.../preview... */
function resolveBlockfrostBase(key: string): string | null {
  if (key.startsWith("mainnet")) return "https://cardano-mainnet.blockfrost.io/api/v0";
  if (key.startsWith("preprod")) return "https://cardano-preprod.blockfrost.io/api/v0";
  if (key.startsWith("preview")) return "https://cardano-preview.blockfrost.io/api/v0";
  return null;
}

// Logic chuẩn hoá URL ảnh nằm ở lib/nft.ts để test được độc lập —
// xem scripts/verify-nft-image.mjs cho các dạng dữ liệu thật trên chain.

export async function POST(request: Request) {
  const key = process.env.BLOCKFROST_API_KEY;
  const base = key ? resolveBlockfrostBase(key) : null;

  if (!key || !base) {
    return NextResponse.json({ enabled: false, assets: [] as AssetMeta[] });
  }

  let units: unknown;
  try {
    ({ units } = await request.json());
  } catch {
    return NextResponse.json({ error: "Body không phải JSON hợp lệ." }, { status: 400 });
  }

  if (!Array.isArray(units)) {
    return NextResponse.json({ error: "Thiếu mảng `units`." }, { status: 400 });
  }

  // Chặn số lượng để không đốt rate limit của Blockfrost.
  const wanted = units
    .filter((u): u is string => typeof u === "string" && /^[0-9a-fA-F]{56,}$/.test(u))
    .slice(0, 40);

  const results = await Promise.all(
    wanted.map(async (unit): Promise<AssetMeta> => {
      try {
        const res = await fetch(`${base}/assets/${unit}`, {
          headers: { project_id: key },
          // Metadata asset gần như bất biến → cache 1 giờ.
          next: { revalidate: 3600 },
        });

        if (!res.ok) return { unit };

        const data = await res.json();
        const onchain = data.onchain_metadata ?? {};
        const offchain = data.metadata ?? {};

        const name =
          (typeof onchain.name === "string" && onchain.name) ||
          (typeof offchain.name === "string" && offchain.name) ||
          undefined;

        const decimals = typeof offchain.decimals === "number" ? offchain.decimals : undefined;

        // NFT (CIP-25) dùng onchain_metadata.image; một số bộ dùng `files[0].src`.
        // Fungible token (Token Registry) dùng metadata.logo — base64 không tiền tố.
        const files = Array.isArray(onchain.files) ? onchain.files : [];
        const firstFileSrc = files.length > 0 ? (files[0] as { src?: unknown })?.src : undefined;

        // Trả về TẤT CẢ ứng viên: gateway IPFS đơn lẻ chỉ tải được ~50% ảnh,
        // client sẽ thử lần lượt qua onError. Xem chú thích ở lib/nft.ts.
        const first = resolveImageCandidates(onchain.image);
        const images =
          first.length > 0
            ? first
            : (() => {
                const fromFile = resolveImageCandidates(firstFileSrc);
                return fromFile.length > 0 ? fromFile : resolveLogoCandidates(offchain.logo);
              })();

        return { unit, name, images, decimals };
      } catch {
        return { unit };
      }
    }),
  );

  return NextResponse.json({ enabled: true, assets: results });
}
