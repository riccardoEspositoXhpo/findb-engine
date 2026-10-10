import pg from "pg";

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("[db] Missing DATABASE_URL environment variable.");
}

// Initialize the shared connection pool
export const pool = new Pool({
  connectionString,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
  max: 10, // Maximum active clients in pool
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Guard against unexpected errors on idle pool clients
pool.on("error", (err) => {
  console.error("[db] Unexpected error on idle Postgres client:", err);
});

/**
 * Executes a one-off query using an auto-released pool connection.
 * @param {string} text - SQL query string
 * @param {Array} [params] - Query parameters
 */
export async function query(text, params) {
  return pool.query(text, params);
}

/**
 * Executes a transactional callback with automatic BEGIN, COMMIT, ROLLBACK,
 * and guarantees connection release in the finally block.
 * @param {Function} callback - Async function receiving (client)
 */
export async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN;");
    const result = await callback(client);
    await client.query("COMMIT;");
    return result;
  } catch (err) {
    await client.query("ROLLBACK;");
    throw err;
  } finally {
    // Always return client back to pool, avoiding memory leaks
    client.release();
  }
}

/**
 * Closes the entire pool. Must be called at the end of dailyBatch.js.
 */
export async function closePool() {
  await pool.end();
  console.log("[db] Connection pool closed cleanly.");
}

/**
 * SELECT * - Fetches all records from a given table as an array of objects
 * Equivalent to legacy importDatabase() from databaseFunctions.gs
 *
 * @param {string} tableName - Database table name
 * @returns {Promise<Array<Object>>} Array of row objects
 */
export async function importDatabase(tableName) {
  const result = await pool.query(`SELECT * FROM ${tableName};`);
  return result.rows;
}
