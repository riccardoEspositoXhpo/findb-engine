// PostgreSQL connection pool, transaction orchestrator, and data access layer (ESM)
import { config } from "../config.js";
import pg from "pg";
import { utils } from "./utils.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.isProduction ? { rejectUnauthorized: false } : false,
});

/**
 * Direct query execution on the connection pool (best for standalone reads)
 * @param {string} text - SQL query string
 * @param {Array} [params] - Parameterized values
 * @returns {Promise<Object>} pg QueryResult object
 */
export const query = (text, params) => pool.query(text, params);

/**
 * Executes a callback within a managed ACID database transaction.
 * Automatically handles BEGIN, COMMIT, ROLLBACK, and connection release.
 *
 * @param {Function} callback - Async function receiving the isolated client: (client) => Promise<any>
 * @returns {Promise<any>} The result returned by callback
 */
export async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * SELECT * - Fetches all records from a table.
 * Replicates legacy importDatabase() behavior with optional O(1) Map hydration.
 *
 * @param {string} tableName - Database table name
 * @param {boolean} [asMap=false] - When true, resolves PK and returns an O(1) Map
 * @returns {Promise<Array<Object>|Map<string, Object>>}
 */
export async function importDatabase(tableName, asMap = false) {
  const result = await pool.query(`SELECT * FROM ${tableName};`);
  const rows = result.rows;

  if (!asMap) {
    return rows;
  }

  // Resolve PK dynamically from information_schema (cached in RAM)
  const pk = await utils.getTablePrimaryKey(pool, tableName);
  return utils.dbToMap(rows, pk);
}

/**
 * Universal UPSERT replacing legacy replaceDataInSheet.
 * Atomically inserts new records or updates existing rows on PK conflict.
 *
 * @param {Array<Object>|Map<string, Object>} data - Records to persist
 * @param {string} tableName - Target PostgreSQL table name
 * @param {Object} [client=null] - Optional pg transaction client
 * @returns {Promise<number>} Total count of upserted rows
 */
export async function replaceDataInDb(data, tableName, client = null) {
  const dbExecutor = client || pool;

  // Intercettazione di sicurezza globale
  if (config.dryRun) {
    console.log(
      `[DRY-RUN] Intercettata persistenza su "${tableName}" (${data.length} righe). Scrittura DB bloccata.`,
    );
    return data.length;
  }

  // 1. Normalize data input (Map -> Array of Objects)
  const rows = data instanceof Map ? mapToDb(data) : data;
  if (!Array.isArray(rows) || rows.length === 0) {
    return 0;
  }

  // 2. Discover Primary Key columns dynamically via cached metadata
  const pkDef = await utils.getTablePrimaryKey(dbExecutor, tableName);
  const pkColumns = Array.isArray(pkDef) ? pkDef : [pkDef];

  // 3. Extract unique columns present across the incoming dataset
  const columns = Object.keys(rows[0]);
  const nonPkColumns = columns.filter((col) => !pkColumns.includes(col));

  // 4. Build conflict resolution clause
  const conflictTarget = pkColumns.join(", ");
  let conflictAction = "";

  if (nonPkColumns.length > 0) {
    const updateAssignments = nonPkColumns
      .map((col) => `${col} = EXCLUDED.${col}`)
      .join(", ");
    conflictAction = `DO UPDATE SET ${updateAssignments}`;
  } else {
    // Pure junction tables containing only PK columns
    conflictAction = "DO NOTHING";
  }

  // 5. Batch processing to avoid parameter overflow (PostgreSQL max: 65535)
  const CHUNK_SIZE = 500;
  let totalProcessed = 0;

  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    const values = [];
    const valuePlaceholders = [];
    let paramIndex = 1;

    for (const row of chunk) {
      const rowPlaceholders = [];
      for (const col of columns) {
        rowPlaceholders.push(`$${paramIndex++}`);
        values.push(row[col] ?? null);
      }
      valuePlaceholders.push(`(${rowPlaceholders.join(", ")})`);
    }

    const sql = `
      INSERT INTO ${tableName} (${columns.join(", ")})
      VALUES ${valuePlaceholders.join(",\n")}
      ON CONFLICT (${conflictTarget})
      ${conflictAction};
    `;

    await dbExecutor.query(sql, values);
    totalProcessed += chunk.length;
  }

  console.log(
    `[DB UPSERT] Successfully upserted ${totalProcessed} records into "${tableName}".`,
  );
  return totalProcessed;
}
