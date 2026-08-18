import "server-only";

import { Pool, type PoolClient, type QueryResultRow } from "pg";

/**
 * Kết nối Postgres cho phần thanh toán.
 *
 * Postgres là nguồn sự thật của đơn hàng: dữ liệu tài chính cần lưu lâu, truy vấn
 * được lịch sử, và quan trọng nhất là có ràng buộc UNIQUE trên `tx_hash` để một
 * giao dịch không bao giờ thanh toán được cho hai đơn.
 */

/**
 * Cache pool trên globalThis.
 *
 * `next dev` nạp lại module mỗi lần sửa file. Tạo Pool ở phạm vi module mà không
 * cache thì mỗi lần hot-reload lại mở thêm một pool, và Postgres đạt trần
 * max_connections sau vài chục lần lưu file — biểu hiện là "too many clients already"
 * xuất hiện lúc đang code chứ không phải lúc chịu tải.
 */
const globalForDb = globalThis as unknown as { __paymentPool?: Pool };

export function isDatabaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}

/**
 * Postgres có host (Neon, Supabase, RDS…) gần như luôn bắt buộc TLS, còn Postgres
 * chạy trong Docker ở máy thì không có chứng chỉ. Không đoán mò: bật khi chuỗi kết
 * nối tự khai `sslmode`, hoặc khi có DATABASE_SSL=true.
 */
function resolveSsl(connectionString: string) {
  const declaresSsl = /[?&]sslmode=(require|verify-ca|verify-full)/.test(connectionString);
  if (!declaresSsl && process.env.DATABASE_SSL !== "true") return undefined;

  // `sslmode=verify-full` cần CA thật; các mức còn lại chỉ cần kênh mã hoá.
  return { rejectUnauthorized: /sslmode=verify-full/.test(connectionString) };
}

export function getPool(): Pool {
  const connectionString = process.env.DATABASE_URL?.trim();

  if (!connectionString) {
    throw new Error(
      "Thiếu DATABASE_URL. Chạy Postgres bằng `docker compose up -d` rồi đặt " +
        "DATABASE_URL trong .env.local — xem .env.example.",
    );
  }

  if (!globalForDb.__paymentPool) {
    const pool = new Pool({
      connectionString,
      ssl: resolveSsl(connectionString),
      max: Number(process.env.DATABASE_POOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });

    // BẮT BUỘC phải có. pg phát sự kiện 'error' trên client đang rảnh khi Postgres
    // restart hoặc mạng đứt; 'error' không có listener trên EventEmitter sẽ làm
    // sập cả tiến trình Node. Ở đây chỉ ghi log — pool tự loại client hỏng ra.
    pool.on("error", (err) => {
      console.error("[db] client rảnh gặp lỗi:", err.message);
    });

    globalForDb.__paymentPool = pool;
  }

  return globalForDb.__paymentPool;
}

/** Truy vấn đơn lẻ, trả về mảng row. Luôn dùng tham số hoá — không nối chuỗi SQL. */
export async function query<T extends QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const result = await getPool().query<T>(text, params as unknown[]);
  return result.rows;
}

/** Như `query` nhưng chỉ lấy row đầu, không có thì null. */
export async function queryOne<T extends QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/**
 * Chạy một khối trong transaction. Ném lỗi thì ROLLBACK, xong thì COMMIT,
 * và client luôn được trả về pool kể cả khi ROLLBACK cũng lỗi.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      // Nuốt lỗi rollback nhưng vẫn ghi lại: ném nó ra sẽ che mất lỗi gốc,
      // mà lỗi gốc mới là thứ cần đọc.
      console.error("[db] ROLLBACK thất bại:", rollbackError);
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Kiểm tra kết nối. Trả về mô tả lỗi thay vì ném, để trang health đọc được. */
export async function checkDatabase(): Promise<{ ok: boolean; detail: string }> {
  if (!isDatabaseConfigured()) return { ok: false, detail: "Chưa đặt DATABASE_URL." };

  try {
    const rows = await query<{ version: string }>("SELECT version() AS version");
    const version = rows[0]?.version ?? "";
    return { ok: true, detail: version.split(",")[0] || "kết nối được" };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/** Danh sách migration đã áp dụng. Trả về null nếu bảng chưa tồn tại. */
export async function appliedMigrations(): Promise<string[] | null> {
  try {
    const rows = await query<{ version: string }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    return rows.map((row) => row.version);
  } catch {
    return null;
  }
}
