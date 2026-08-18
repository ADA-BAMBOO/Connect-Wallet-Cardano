import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Thuật toán ký webhook — module THUẦN, không import gì ngoài `node:crypto`.
 *
 * Tách khỏi `webhook.ts` vì hai lý do:
 *
 *   1. Bản sao dành cho shop (`integration/cardano-pay-client.ts`) phải khớp từng byte
 *      với bản này. Có một module thuần thì `verify:integration` import được cả hai và
 *      chứng minh chúng đồng ý với nhau. Không có nó, cách duy nhất để phát hiện lệch
 *      là webhook trả 401 hàng loạt ở production — mà triệu chứng đó không hề chỉ về
 *      nguyên nhân.
 *   2. `webhook.ts` kéo theo Postgres và alias `@/`, nên không import được từ script
 *      Node chạy ngoài runtime Next.
 */

export const SIGNATURE_HEADER = "x-cardano-pay-signature";
export const EVENT_HEADER = "x-cardano-pay-event";
export const DELIVERY_HEADER = "x-cardano-pay-delivery";
export const ATTEMPT_HEADER = "x-cardano-pay-attempt";

/** Cửa sổ chấp nhận mặc định, giây. Đủ rộng cho lệch đồng hồ, đủ hẹp để chặn phát lại. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * Ký `<timestamp>.<body>`, không phải ký mỗi `<body>`.
 *
 * Ký mỗi thân request thì chữ ký hợp lệ vĩnh viễn: ai chặn được một gói tin "đã thanh
 * toán" có thể phát lại nó bất cứ lúc nào về sau. Gộp timestamp vào phần được ký khiến
 * bên nhận từ chối được gói tin quá cũ, vì sửa timestamp là hỏng chữ ký.
 *
 * Định dạng `t=<unix>,v1=<hex>` — có chỗ cho `v2` khi cần đổi thuật toán mà không phá
 * bên đang tích hợp.
 */
export function signPayload(secret: string, timestampSeconds: number, body: string): string {
  const mac = createHmac("sha256", secret).update(`${timestampSeconds}.${body}`).digest("hex");
  return `t=${timestampSeconds},v1=${mac}`;
}

/** Tách `t=…,v1=…` thành cặp khoá/giá trị. Bỏ qua thành phần lạ để `v2` sau này không phá bản cũ. */
export function parseSignatureHeader(header: string): Record<string, string> {
  const parts: Record<string, string> = {};
  for (const part of header.split(",")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    parts[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return parts;
}

export type SignatureCheck = { ok: true } | { ok: false; error: string };

/**
 * Kiểm chữ ký trên một thân request THÔ.
 *
 * `body` phải là đúng chuỗi đã được ký. `JSON.parse` rồi `stringify` lại sẽ đổi thứ tự
 * khoá và cách escape Unicode — chuỗi nhìn "tương đương" với mắt người nhưng băm ra
 * một giá trị khác.
 */
export function verifySignature(
  secret: string,
  header: string | null,
  body: string,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
  nowMs = Date.now(),
): SignatureCheck {
  if (!header) return { ok: false, error: "Thiếu header chữ ký." };
  if (!secret) return { ok: false, error: "Thiếu khoá ký." };

  const parts = parseSignatureHeader(header);
  const timestamp = Number(parts.t);
  const presented = parts.v1;

  if (!Number.isInteger(timestamp) || !presented) return { ok: false, error: "Header chữ ký sai định dạng." };

  const age = Math.abs(Math.floor(nowMs / 1_000) - timestamp);
  if (age > toleranceSeconds) return { ok: false, error: `Chữ ký quá cũ (${age}s).` };

  const expected = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest();
  const actual = Buffer.from(presented, "hex");

  // `timingSafeEqual` ném lỗi khi độ dài lệch, nên phải chặn trước — và so sánh không
  // được thoát sớm, để thời gian phản hồi không tiết lộ khớp được bao nhiêu byte.
  if (expected.length !== actual.length) return { ok: false, error: "Chữ ký không khớp." };
  if (!timingSafeEqual(expected, actual)) return { ok: false, error: "Chữ ký không khớp." };

  return { ok: true };
}
