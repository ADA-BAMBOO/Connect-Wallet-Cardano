import "server-only";

import { getPool, query, queryOne } from "@/lib/db";
import type { CardanoNetwork } from "@/lib/network";

/**
 * Sổ phát của faucet: ai đã xin, xin gì, tx nào.
 *
 * Postgres chứ không phải Redis, vì đây là thứ duy nhất áp được cooldown theo địa chỉ
 * và trả lời được "faucet đi đâu hết ADA rồi" sau vài ngày người ta test.
 */

export type ClaimStatus = "pending" | "sent" | "failed";

export type ClaimAsset = {
  unit: string;
  symbol: string;
  /** Số nguyên ở đơn vị nhỏ nhất, dạng chuỗi — giữ nguyên quy ước tiền tệ của dự án. */
  quantity: string;
  mode: "mint" | "transfer";
};

/* ------------------------------------------------------------------ */
/* Khoá tuần tự hoá                                                    */
/* ------------------------------------------------------------------ */

/**
 * Một ví, một tập UTxO — hai lượt phát chạy song song là hai giao dịch cùng tiêu một
 * UTxO, và cái tới sau bị chain từ chối ("ValueNotConserved"/"BadInputs") sau khi
 * người dùng đã tưởng mình xin xong.
 *
 * Advisory lock của Postgres giải quyết đúng chuyện đó và không cần thêm hạ tầng:
 * nó gắn với PHIÊN kết nối, nên tiến trình chết giữa chừng thì khoá tự rơi ra — khác
 * hẳn một dòng "locked=true" trong bảng, vốn sẽ kẹt mãi mãi.
 *
 * `pg_try_advisory_lock` chứ không phải `pg_advisory_lock`: xếp hàng chờ nghĩa là giữ
 * request HTTP treo cho tới khi giao dịch trước lên chain. Thà trả 409 "đang bận" ngay.
 */
const FAUCET_LOCK_ID = 8_140_777;

/** Chạy `fn` khi giành được khoá; trả về null nếu faucet đang bận. */
export async function withFaucetLock<T>(fn: () => Promise<T>): Promise<T | null> {
  const client = await getPool().connect();

  try {
    const locked = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [FAUCET_LOCK_ID],
    );
    if (!locked.rows[0]?.locked) return null;

    try {
      return await fn();
    } finally {
      // Phải nhả trên ĐÚNG client đã giành — advisory lock thuộc về phiên kết nối,
      // nhả từ client khác trong pool là no-op và khoá sẽ ở lại tới hết phiên.
      await client.query("SELECT pg_advisory_unlock($1)", [FAUCET_LOCK_ID]).catch((error) => {
        console.error("[faucet] không nhả được advisory lock:", error);
      });
    }
  } finally {
    client.release();
  }
}

/* ------------------------------------------------------------------ */
/* Cooldown                                                            */
/* ------------------------------------------------------------------ */

/**
 * Lần xin gần nhất còn được tính vào cooldown, hoặc null nếu chưa từng.
 *
 * Đơn `failed` KHÔNG tính: giao dịch không dựng được thì người test chưa nhận gì cả,
 * bắt họ chờ 24 giờ vì lỗi của faucet là vô lý.
 *
 * Đơn `pending` chỉ tính trong 5 phút đầu. Nó là trạng thái của một lượt phát đang dở
 * (hoặc tiến trình chết ngay sau khi submit — giao dịch RẤT có thể đã lên chain), nên
 * trong ngắn hạn phải chặn để không phát hai lần; nhưng một dòng pending mắc kẹt không
 * được phép khoá địa chỉ đó vĩnh viễn.
 */
export async function lastClaimAt(
  network: CardanoNetwork,
  address: string,
): Promise<Date | null> {
  const row = await queryOne<{ created_at: Date }>(
    `SELECT created_at
       FROM faucet_claims
      WHERE network = $1
        AND address = $2
        AND (status = 'sent' OR (status = 'pending' AND created_at > now() - interval '5 minutes'))
      ORDER BY created_at DESC
      LIMIT 1`,
    [network, address],
  );
  return row?.created_at ?? null;
}

/**
 * Thời điểm faucet phát thành công gần nhất, bất kể cho ai.
 *
 * Dùng để chờ giao dịch trước kịp vào block. Blockfrost trả về UTxO đã lên chain, KHÔNG
 * biết gì về mempool: dựng giao dịch mới ngay sau một lượt phát nghĩa là chọn lại đúng
 * input vừa tiêu, và node từ chối với `BadInputsUTxO` — sau khi người dùng đã tưởng
 * mình xin xong. Advisory lock không cứu được chuyện này vì lượt trước đã nhả khoá từ
 * lúc submit xong.
 */
export async function lastSentAt(network: CardanoNetwork): Promise<Date | null> {
  const row = await queryOne<{ sent_at: Date | null }>(
    `SELECT sent_at
       FROM faucet_claims
      WHERE network = $1 AND status = 'sent' AND sent_at IS NOT NULL
      ORDER BY sent_at DESC
      LIMIT 1`,
    [network],
  );
  return row?.sent_at ?? null;
}

/* ------------------------------------------------------------------ */
/* Ghi sổ                                                              */
/* ------------------------------------------------------------------ */

/**
 * Ghi dòng `pending` TRƯỚC khi gửi giao dịch.
 *
 * Thứ tự này là cố ý: ghi sau khi submit thành công thì một lần crash giữa hai bước
 * sẽ để lại giao dịch trên chain mà không có dòng nào trong sổ — faucet mất tiền và
 * không ai biết vì sao.
 */
export async function insertPendingClaim(input: {
  network: CardanoNetwork;
  address: string;
  clientKey: string | null;
  assets: ClaimAsset[];
  lovelace: bigint;
}): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO faucet_claims (network, address, client_key, assets, lovelace)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     RETURNING id`,
    [
      input.network,
      input.address,
      input.clientKey,
      JSON.stringify(input.assets),
      input.lovelace.toString(),
    ],
  );

  if (!row) throw new Error("Không ghi được dòng faucet_claims.");
  return row.id;
}

export async function markClaimSent(id: string, txHash: string): Promise<void> {
  await query(
    `UPDATE faucet_claims
        SET status = 'sent', tx_hash = $2, sent_at = now()
      WHERE id = $1`,
    [id, txHash],
  );
}

/** Giữ nguyên câu lỗi nhưng cắt ngắn — thông điệp lỗi của Mesh/Blockfrost có thể rất dài. */
export async function markClaimFailed(id: string, error: string): Promise<void> {
  await query(`UPDATE faucet_claims SET status = 'failed', error = $2 WHERE id = $1`, [
    id,
    error.slice(0, 500),
  ]);
}

/* ------------------------------------------------------------------ */
/* Thống kê cho trang trạng thái                                       */
/* ------------------------------------------------------------------ */

export type FaucetUsage = { last24h: number; total: number };

export async function faucetUsage(network: CardanoNetwork): Promise<FaucetUsage> {
  const row = await queryOne<{ last_24h: string; total: string }>(
    `SELECT count(*) FILTER (WHERE created_at > now() - interval '24 hours') AS last_24h,
            count(*)                                                        AS total
       FROM faucet_claims
      WHERE network = $1 AND status = 'sent'`,
    [network],
  );

  return {
    last24h: Number(row?.last_24h ?? 0),
    total: Number(row?.total ?? 0),
  };
}
