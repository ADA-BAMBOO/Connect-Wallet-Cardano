/**
 * Đối chiếu một giao dịch on-chain với một đơn hàng.
 *
 * File này THUẦN: nhận dữ liệu đã tải sẵn, không gọi mạng, không đụng database.
 * Nhờ vậy toàn bộ quy tắc "thế nào là đã trả tiền" test được bằng dữ liệu mẫu —
 * và đây đúng là chỗ không được phép sai.
 *
 * NGUYÊN TẮC: mọi kết luận đều rút ra từ dữ liệu chain. `txHash` do client gửi lên
 * chỉ là GỢI Ý để khỏi phải chờ watcher quét; bỏ hẳn nó đi thì hệ thống vẫn đúng,
 * chỉ chậm hơn. Đó là phép thử xem một thiết kế thanh toán có chắc hay không.
 *
 * Không import gì để script kiểm thử nạp thẳng file này được.
 */

/** Nhãn metadata CIP-20 (transaction message) — ví hiển thị được cho người dùng đọc. */
export const PAYMENT_METADATA_LABEL = 674;

/** Nội dung nhúng vào metadata để buộc giao dịch với đơn hàng. */
export function paymentMemo(ref: string): string {
  return `pay:${ref}`;
}

export type TxAmount = { unit: string; quantity: string };

export type TxOutput = {
  address: string;
  amount: TxAmount[];
  output_index?: number;
  /** true nếu đây là output hoàn collateral của giao dịch Plutus — KHÔNG phải tiền trả. */
  collateral?: boolean;
  inline_datum?: string | null;
};

export type TxInfo = {
  block_height: number | null;
  /** Thời điểm block chứa giao dịch, unix giây. Đây là mốc "tiền về lúc nào" theo chain. */
  block_time?: number | null;
  /** false nghĩa là script validation thất bại: chỉ collateral bị tiêu, không có thanh toán nào. */
  valid_contract?: boolean;
};

export type TxMetadataEntry = { label: string | number; json_metadata: unknown };

export type VerifyInput = {
  ref: string;
  merchantAddress: string;
  /** 'lovelace' cho ADA, ngược lại policyId + assetNameHex. */
  payUnit: string;
  requiredQuantity: bigint;
  /** Ngưỡng tối thiểu coi là đã trả đủ (đã tính sẵn sai số). */
  minQuantity: bigint;
  requiredConfirmations: number;

  /**
   * Hạn của tỷ giá đã khoá, ms epoch. `null` khi số phải trả không phụ thuộc tỷ giá
   * (stablecoin quy ước 1:1) — lúc đó không có gì để hết hạn.
   *
   * Thiếu trường này thì `pay_quantity` khoá lúc t=0 vẫn được chấp nhận ở t=24h, và
   * người trả có trong tay một quyền chọn ADA miễn phí đúng bằng hạn của cả đơn.
   */
  quoteExpiresAtMs: number | null;
  /** "Bây giờ" truyền từ ngoài vào để hàm này vẫn thuần và test được. */
  nowMs: number;

  /** null nếu Blockfrost trả 404 — giao dịch chưa vào block. */
  tx: TxInfo | null;
  outputs: TxOutput[] | null;
  metadata: TxMetadataEntry[] | null;
  latestBlockHeight: number | null;
};

export type VerifyVerdict =
  /** Chưa thấy giao dịch trên chain. Bình thường trong 20–60 giây đầu. */
  | { state: "not_found" }
  /** Có giao dịch nhưng không thoả điều kiện — KHÔNG được gắn vào đơn. */
  | { state: "rejected"; reason: string }
  | { state: "underpaid"; received: bigint; shortfall: bigint; confirmations: number; blockHeight: number | null }
  /**
   * Đủ số lượng đã khoá, nhưng tiền về SAU khi tỷ giá hết hạn.
   *
   * Tiền đã nằm trong ví merchant nên tuyệt đối không được từ chối và bỏ qua — nhưng
   * cũng không được coi là đã trả đủ, vì số ADA đó khoá theo giá cũ và giờ có thể chỉ
   * còn đáng một phần giá trị đơn hàng. Cần người quyết định, giống `underpaid`.
   */
  | {
      state: "stale_quote";
      received: bigint;
      confirmations: number;
      blockHeight: number | null;
      quoteExpiredAtMs: number;
      paidAtMs: number;
    }
  | { state: "seen"; received: bigint; confirmations: number; blockHeight: number | null }
  | { state: "confirmed"; received: bigint; confirmations: number; blockHeight: number };

/**
 * Bóc các mã đơn nhúng trong metadata CIP-20.
 *
 * Hình dạng chuẩn là `{ msg: ["pay:ABC"] }`, nhưng ví và thư viện ngoài kia ghi mỗi
 * nơi một kiểu, nên chấp nhận cả chuỗi trần lẫn `msg` không phải mảng. Nới ở khâu
 * ĐỌC thì an toàn — nó chỉ giúp nhận ra khoản thanh toán hợp lệ; phần siết chặt nằm
 * ở chỗ khác (đúng địa chỉ, đúng token, đủ số lượng).
 */
export function extractPaymentRefs(metadata: readonly TxMetadataEntry[] | null): string[] {
  if (!metadata) return [];

  const refs: string[] = [];

  for (const entry of metadata) {
    if (String(entry.label) !== String(PAYMENT_METADATA_LABEL)) continue;

    const raw = entry.json_metadata;
    const lines: unknown[] =
      typeof raw === "string"
        ? [raw]
        : Array.isArray((raw as { msg?: unknown })?.msg)
          ? ((raw as { msg: unknown[] }).msg)
          : typeof (raw as { msg?: unknown })?.msg === "string"
            ? [(raw as { msg: string }).msg]
            : [];

    for (const line of lines) {
      if (typeof line !== "string") continue;
      const match = /^pay:([0-9A-HJ-NP-Za-km-z]{6,32})$/.exec(line.trim());
      if (match) refs.push(match[1]!);
    }
  }

  return refs;
}

/**
 * Cộng số lượng của một token trong các output trả về địa chỉ merchant.
 *
 * Cộng TẤT CẢ output khớp địa chỉ, không chỉ output đầu: chia tiền thành nhiều output
 * là hợp lệ, và chỉ nhìn output đầu tiên sẽ kết luận nhầm là trả thiếu.
 *
 * Bỏ qua output collateral — trong giao dịch Plutus thất bại, phần collateral hoàn
 * lại có thể trỏ về bất kỳ đâu và không phải là tiền thanh toán.
 */
export function sumToAddress(
  outputs: readonly TxOutput[] | null,
  address: string,
  unit: string,
): bigint {
  if (!outputs) return 0n;

  let total = 0n;
  for (const output of outputs) {
    if (output.collateral === true) continue;
    if (output.address !== address) continue;

    for (const amount of output.amount) {
      if (amount.unit !== unit) continue;
      try {
        total += BigInt(amount.quantity);
      } catch {
        // Số lượng không đọc được là dữ liệu hỏng — bỏ qua, tuyệt đối không đoán.
      }
    }
  }
  return total;
}

/**
 * Số xác nhận. Giao dịch nằm trong block mới nhất được tính là 1.
 *
 * Quy ước này phải nhất quán ở mọi nơi, vì nó quyết định lúc nào đơn chuyển sang
 * `confirmed` — lệch một block là lệch cả ngưỡng chống reorg.
 */
export function confirmationsFor(blockHeight: number | null, latestHeight: number | null): number {
  if (blockHeight === null || latestHeight === null) return 0;
  return Math.max(0, latestHeight - blockHeight + 1);
}

/**
 * Bốn điều kiện, đọc hết từ chain:
 *
 *   1. metadata mang đúng `pay:<ref>` của đơn này
 *   2. có output trả về đúng địa chỉ merchant đã snapshot trong đơn
 *   3. output đó chứa đúng token, số lượng >= ngưỡng tối thiểu
 *   4. tiền về TRƯỚC khi tỷ giá đã khoá hết hạn
 *   5. giao dịch đã vào block và đủ số xác nhận
 */
export function verifyPayment(input: VerifyInput): VerifyVerdict {
  const { tx, ref, merchantAddress, payUnit, requiredQuantity, minQuantity } = input;

  if (!tx) return { state: "not_found" };

  // Script validation thất bại: chain chỉ tiêu collateral, không có khoản trả nào.
  if (tx.valid_contract === false) {
    return { state: "rejected", reason: "Giao dịch thất bại ở khâu kiểm tra script." };
  }

  // (1) Không có mã đơn trong metadata thì không có gì buộc giao dịch này với đơn này.
  // Thiếu bước này, kẻ tấn công chỉ cần khai lại txHash của một khoản trả cho đơn khác.
  const refs = extractPaymentRefs(input.metadata);
  if (!refs.includes(ref)) {
    return {
      state: "rejected",
      reason: refs.length
        ? `Metadata mang mã đơn khác (${refs.join(", ")}), không phải ${ref}.`
        : `Giao dịch không có metadata "pay:${ref}".`,
    };
  }

  // (2) + (3)
  const received = sumToAddress(input.outputs, merchantAddress, payUnit);

  if (received === 0n) {
    return {
      state: "rejected",
      reason: `Không có output nào trả ${payUnit === "lovelace" ? "ADA" : "token"} về địa chỉ merchant.`,
    };
  }

  const blockHeight = tx.block_height;
  const confirmations = confirmationsFor(blockHeight, input.latestBlockHeight);

  if (received < minQuantity) {
    return {
      state: "underpaid",
      received,
      shortfall: requiredQuantity - received,
      confirmations,
      blockHeight,
    };
  }

  // (4) Tỷ giá đã khoá phải còn hạn tại thời điểm tiền về.
  //
  // Mốc so sánh là `block_time` — thời điểm chain ghi nhận, không phải lúc server xử
  // lý. Watcher có thể quét muộn hàng giờ sau khi giao dịch vào block, và lấy `now()`
  // sẽ đánh trượt oan những khoản trả đúng hạn.
  //
  // Giao dịch đã vào block mà Blockfrost không trả `block_time` thì rơi về `nowMs`:
  // không biết chính xác lúc nào thì phải nghiêng về phía nghi ngờ, vì bỏ qua ở đây
  // đồng nghĩa với mở lại đúng lỗ hổng mà nhánh này sinh ra để bịt.
  const paidAtMs =
    typeof tx.block_time === "number" && Number.isFinite(tx.block_time)
      ? tx.block_time * 1_000
      : blockHeight !== null
        ? input.nowMs
        : null;

  if (
    typeof input.quoteExpiresAtMs === "number" &&
    paidAtMs !== null &&
    paidAtMs > input.quoteExpiresAtMs
  ) {
    return {
      state: "stale_quote",
      received,
      confirmations,
      blockHeight,
      quoteExpiredAtMs: input.quoteExpiresAtMs,
      paidAtMs,
    };
  }

  // (5) Chưa vào block thì chưa có gì chắc chắn — reorg vẫn xoá được giao dịch.
  if (blockHeight === null || confirmations < input.requiredConfirmations) {
    return { state: "seen", received, confirmations, blockHeight };
  }

  return { state: "confirmed", received, confirmations, blockHeight };
}
