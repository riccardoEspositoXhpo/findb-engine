import pg from "pg";

const { Pool } = pg;

export async function runTestQuery() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("Missing DATABASE_URL in environment variables.");
  }

  const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 5000
  });

  const client = await pool.connect();
  const targetDate = "2026-10-07";

  try {
    console.log(`[testQuery] Checking row for date: ${targetDate}...`);

    // 1. Lettura preliminare
    const selectSql = `
      SELECT id, date, value, created_at 
      FROM test 
      WHERE date = $1;
    `;
    const beforeResult = await client.query(selectSql, [targetDate]);

    if (beforeResult.rows.length === 0) {
      console.log(`[testQuery] No existing row found for ${targetDate}.`);
    } else {
      console.log(`[testQuery] Current value:`, beforeResult.rows[0].value);
    }

    // 2. Generazione random (1 - 100)
    const randomValue = Math.floor(Math.random() * 100) + 1;
    console.log(`[testQuery] Generated random value: ${randomValue}`);

    // 3. Atomic UPSERT: se la data esiste aggiorna il valore, altrimenti inserisce
    const upsertSql = `
      INSERT INTO test (date, value)
      VALUES ($1, $2)
      ON CONFLICT (date)
      DO UPDATE SET value = EXCLUDED.value
      RETURNING id, date, value, created_at;
    `;
    const upsertResult = await client.query(upsertSql, [targetDate, randomValue]);
    console.log("[testQuery] UPSERT applied successfully:", upsertResult.rows[0]);

  } finally {
    // Rilascio garantito della connessione al pool
    client.release();
    await pool.end();
  }
}