/**
 * Chạy migration Postgres cho phần thanh toán.
 *
 *   npm run migrate            áp dụng các migration chưa chạy
 *   npm run migrate -- --status  chỉ liệt kê, không đụng vào DB
 *
 * Mỗi file trong migrations/ chạy trong MỘT transaction riêng: hỏng giữa chừng thì
 * file đó rollback sạch, các file trước vẫn giữ nguyên. Không có migration nào bị
 * áp dụng một nửa.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// @next/env là CommonJS và không khai báo named export cho Node ESM.
import nextEnv from "@next/env";
import pg from "pg";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Script chạy ngoài runtime Next nên phải tự nạp .env.local — dùng đúng loader của
// Next để thứ tự ưu tiên biến môi trường giống hệt lúc `next dev`.
nextEnv.loadEnvConfig(projectDir, false, { info: () => {}, error: console.error });

const MIGRATIONS_DIR = path.join(projectDir, "migrations");
const statusOnly = process.argv.includes("--status");

/** Khoá tư vấn cấp DB: hai lần deploy chạy song song không cùng lúc migrate. */
const ADVISORY_LOCK_ID = 8_140_233;

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) {
  console.error(
    "Thiếu DATABASE_URL.\n" +
      "  Chạy Postgres tại máy:  docker compose up -d\n" +
      "  Rồi thêm vào .env.local: DATABASE_URL=postgres://cardano:cardano@localhost:5432/cardano_pay",
  );
  process.exit(1);
}

const ssl = /[?&]sslmode=(require|verify-ca|verify-full)/.test(connectionString)
  ? { rejectUnauthorized: /sslmode=verify-full/.test(connectionString) }
  : undefined;

const client = new pg.Client({ connectionString, ssl });

try {
  await client.connect();
} catch (error) {
  console.error(`Không kết nối được Postgres: ${error.message}`);
  process.exit(1);
}

let exitCode = 0;

try {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text        PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith(".sql")).sort();

  const { rows } = await client.query("SELECT version FROM schema_migrations");
  const applied = new Set(rows.map((row) => row.version));

  const pending = files.filter((file) => !applied.has(file));

  console.log(`Migration: ${files.length} file, đã áp dụng ${applied.size}, còn ${pending.length}`);
  for (const file of files) {
    console.log(`  ${applied.has(file) ? "✓" : "·"} ${file}`);
  }

  if (statusOnly || pending.length === 0) {
    if (!statusOnly) console.log("\nDatabase đã ở phiên bản mới nhất.");
  } else {
    await client.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_ID]);
    try {
      for (const file of pending) {
        const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
        process.stdout.write(`\nÁp dụng ${file}… `);

        await client.query("BEGIN");
        try {
          await client.query(sql);
          await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
          await client.query("COMMIT");
          console.log("xong");
        } catch (error) {
          await client.query("ROLLBACK");
          console.log("THẤT BẠI");
          throw error;
        }
      }
      console.log("\nHoàn tất.");
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_ID]);
    }
  }
} catch (error) {
  console.error(`\nLỗi migration: ${error.message}`);
  exitCode = 1;
} finally {
  await client.end();
}

process.exit(exitCode);
