import { NextResponse } from "next/server";
import { generateNonce } from "@meshsdk/core";
import { isValidLoginAddress, saveNonce } from "@/lib/auth-server";
import { getDictionary } from "@/lib/i18n/server";

// checkSignature/generateNonce của Mesh cần Node runtime (WASM + node:crypto).
export const runtime = "nodejs";

/**
 * Payload ký PHẢI ngắn và phải là ASCII in được, để ký được trên Ledger.
 *
 * Lý do thật sự không phải "Ledger chặn ở 31 byte". Ledger ký được thông điệp dài,
 * nhưng khi thông điệp không hiển thị hết trên màn hình thiết bị thì ví buộc phải
 * gọi với `hashPayload: true` — lúc đó thứ nằm trong COSE payload là *hash* chứ
 * không còn là nonce gốc.
 *
 * Và `checkSignature` của Mesh so sánh trực tiếp:
 *     Buffer.from(data, "hex").compare(builder.getPayload())
 * nên payload đã hash sẽ KHÔNG khớp nonce → xác minh thất bại dù chữ ký hợp lệ.
 *
 * Vì vậy ràng buộc là: giữ thông điệp đủ ngắn để không ví nào cần hash nó.
 *
 * Ngưỡng hiển thị của thư viện Ledger (ledgerjs-cardano-shelley):
 *   MAX_CIP8_MSG_FIRST_CHUNK_ASCII_SIZE = 198  (thông điệp ASCII in được)
 *   MAX_CIP8_MSG_FIRST_CHUNK_HEX_SIZE   =  99  (phải hiện dạng hex)
 *
 * Giữ ASCII in được vừa được ngưỡng rộng hơn (198 thay vì 99), vừa để người dùng
 * đọc được thông điệp trên màn hình thiết bị thay vì một dãy hex vô nghĩa.
 * Tránh dấu tiếng Việt: UTF-8 đa byte vừa đội kích thước vừa mất tính ASCII.
 *
 * 30 byte ở đây nằm sâu dưới mọi ngưỡng nói trên, kể cả con số 31 byte từng được
 * nhắc tới trong vụ Midnight Glacier Drop.
 *
 * 19 ký tự ngẫu nhiên từ bảng 62 ký tự ≈ 2^113 khả năng — thừa sức cho một nonce.
 *
 * LABEL mang tên thương hiệu để người dùng đọc trên màn hình ví biết mình đang
 * đăng nhập vào đâu. Đổi LABEL thì phải bù lại RANDOM_LENGTH cho tổng ≤ 31 byte —
 * hai kiểm tra ngay dưới đây chặn sẵn nếu quên.
 */
const MAX_PAYLOAD_BYTES = 31;
const LABEL = "Kolo login ";
const RANDOM_LENGTH = 19; // 11 + 19 = 30 byte

export async function POST(request: Request) {
  const t = await getDictionary();
  let address: unknown;

  try {
    ({ address } = await request.json());
  } catch {
    return NextResponse.json({ error: t.api.badJson }, { status: 400 });
  }

  if (!isValidLoginAddress(address)) {
    return NextResponse.json(
      { error: t.api.invalidLoginAddress },
      { status: 400 },
    );
  }

  // generateNonce trả về chuỗi HEX của `label + random`.
  // signData của ví nhận hex và giữ nguyên, nên payload hai bên khớp nhau.
  const nonce = generateNonce(LABEL, RANDOM_LENGTH);

  // Chặn ngay tại nguồn: đổi LABEL/RANDOM_LENGTH mà quên hai ràng buộc dưới đây
  // sẽ âm thầm làm hỏng đăng nhập trên ví cứng — rất khó truy ngược.
  const payload = Buffer.from(nonce, "hex");

  if (payload.length > MAX_PAYLOAD_BYTES) {
    return NextResponse.json(
      {
        error: t.api.payloadTooLong(payload.length, MAX_PAYLOAD_BYTES),
      },
      { status: 500 },
    );
  }

  // ASCII in được (0x20–0x7E): Ledger hiển thị thành chữ đọc được thay vì hex.
  const isPrintableAscii = payload.every((byte) => byte >= 0x20 && byte <= 0x7e);
  if (!isPrintableAscii) {
    return NextResponse.json(
      {
        error: t.api.payloadNotAscii,
      },
      { status: 500 },
    );
  }

  await saveNonce(address, nonce);

  return NextResponse.json({ nonce });
}
