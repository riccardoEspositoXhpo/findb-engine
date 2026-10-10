import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runMigrations() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("[migrate] Missing DATABASE_URL environment variable.");
  }

  const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 5000,
  });

  const client = await pool.connect();
  const migrationsDir = path.join(__dirname, "../migrations");

  try {
    console.log(
      "[migrate] Connected to Postgres. Initializing migration ledger...",
    );

    // 1. Inizializza tabella tracciamento migrazioni
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 2. Lettura e ordinamento alfabetico/numerico dei file .sql
    if (!fs.existsSync(migrationsDir)) {
      throw new Error(
        `[migrate] Migrations folder not found at: ${migrationsDir}`,
      );
    }

    const files = fs
      .readdirSync(migrationsDir)
      .filter((file) => file.endsWith(".sql"))
      .sort();

    // 3. Estrazione migrazioni già applicate
    const { rows } = await client.query("SELECT name FROM schema_migrations;");
    const appliedMigrations = new Set(rows.map((r) => r.name));

    let executedCount = 0;

    // 4. Esecuzione ordinata e transazionale
    for (const file of files) {
      if (appliedMigrations.has(file)) {
        continue;
      }

      console.log(`[migrate] Applying: ${file}...`);
      const filePath = path.join(migrationsDir, file);
      const sqlContent = fs.readFileSync(filePath, "utf-8");

      await client.query("BEGIN;");
      try {
        await client.query(sqlContent);
        await client.query(
          "INSERT INTO schema_migrations (name) VALUES ($1);",
          [file],
        );
        await client.query("COMMIT;");
        console.log(`[migrate] Successfully applied: ${file}`);
        executedCount++;
      } catch (err) {
        await client.query("ROLLBACK;");
        console.error(`[migrate] Failed executing ${file}. Rolling back.`);
        throw err;
      }
    }

    if (executedCount === 0) {
      console.log(
        "[migrate] Database is already up to date. No new migrations found.",
      );
    } else {
      console.log(`[migrate] Finished. Applied ${executedCount} migration(s).`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

runMigrations().catch((err) => {
  console.error("[migrate] Fatal error:", err);
  process.exit(1);
});
