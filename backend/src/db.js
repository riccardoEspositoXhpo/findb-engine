// PostgreSQL connection pool, transaction orchestrator, and data access layer (ESM)
import { config } from "../config.js";
import { utils } from "./utils.js";
import pg from "pg";
import { AsyncLocalStorage } from "node:async_hooks";

const { Pool } = pg;

// Dedicated execution context to track active transaction clients per async call stack
const asyncLocalStorage = new AsyncLocalStorage();

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Configure sensible defaults for batch processing
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

/**
 * Returns the contextual database executor.
 * If running inside a withTransaction() scope, returns the active transactional client;
 * otherwise, defaults to the shared connection pool.
 *
 * @returns {pg.Pool|pg.PoolClient}
 */
export function getDbExecutor() {
  return asyncLocalStorage.getStore() || pool;
}

/**
 * Universal query runner. Automatically routes to the transactional client if active.
 *
 * @param {string} text - SQL query string
 * @param {Array<any>} [params] - Query parameters
 * @returns {Promise<pg.QueryResult>}
 */
export async function query(text, params) {
  const executor = getDbExecutor();
  return executor.query(text, params);
}

/**
 * Executes a callback within an isolated database transaction.
 * Features an internal async mutex queue to serialize concurrent client.query() calls,
 * allowing Promise.all across the pipeline without TCP socket collisions.
 */
export async function withTransaction(callback, { rollback = false } = {}) {
  const client = await pool.connect();
  const originalQuery = client.query.bind(client);

  // Asynchronous queue chain to serialize concurrent queries on this half-duplex socket
  let queryQueue = Promise.resolve();

  // Intercept client.query to transparently pipeline overlapping calls
  client.query = (...args) => {
    const queuedQuery = queryQueue
      .catch(() => {
        // Prevent prior query rejections from terminating the execution chain
      })
      .then(() => originalQuery(...args));

    // Advance queue pointer
    queryQueue = queuedQuery;
    return queuedQuery;
  };

  try {
    await client.query("BEGIN;");

    // Run pipeline with the queued transactional client in async scope
    const result = await asyncLocalStorage.run(client, async () => {
      return await callback();
    });

    if (rollback) {
      await client.query("ROLLBACK;");
      console.log(
        "[DB TRANSACTION] Dry-run complete: Transaction successfully rolled back.",
      );
    } else {
      await client.query("COMMIT;");
      console.log("[DB TRANSACTION] Transaction successfully committed.");
    }

    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK;");
      console.error(
        "[DB TRANSACTION] Error encountered: Transaction rolled back.",
      );
    } catch (rollbackErr) {
      console.error(
        "[DB TRANSACTION] Failed to rollback transaction:",
        rollbackErr,
      );
    }
    throw error;
  } finally {
    // Restore original unmodified client query method before returning connection to pool
    client.query = originalQuery;
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
 * Automatically hooks into the active AsyncLocalStorage transaction client when running.
 *
 * @param {Array<Object>|Map<string, Object>} data - Records to persist
 * @param {string} tableName - Target PostgreSQL table name
 * @param {Object} [client=null] - Optional pg client override
 * @returns {Promise<number>} Total count of upserted rows
 */
export async function replaceDataInDb(data, tableName, client = null) {
  // 1. Resolve db executor: inherits active transactional client from AsyncLocalStorage, falls back to pool
  const dbExecutor = client || getDbExecutor();

  // 2. Normalize data input (Map -> Array of Objects)
  const rows = data instanceof Map ? utils.mapToDb(data) : data;
  if (!Array.isArray(rows) || rows.length === 0) {
    return 0;
  }

  // 3. Discover Primary Key columns dynamically via cached metadata
  const pkDef = await utils.getTablePrimaryKey(dbExecutor, tableName);
  const pkColumns = Array.isArray(pkDef) ? pkDef : [pkDef];

  // 4. Extract unique columns present across the incoming dataset
  const columns = Object.keys(rows[0]);
  const nonPkColumns = columns.filter((col) => !pkColumns.includes(col));

  // 5. Build conflict resolution clause
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

  // 6. Batch processing to avoid parameter overflow (PostgreSQL max: 65535)
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
