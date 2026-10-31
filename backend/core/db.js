// PostgreSQL connection pool, transaction orchestrator, and data access layer (ESM)
import { config } from "#config";
import { utils } from "#core/utils.js";
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

let savepointCounter = 0;

/**
 * Runs callback all-or-nothing without touching the outer flow: inside an active transaction (dry run) it uses a
 * SAVEPOINT, so a failure rolls back only this callback and the outer transaction stays usable; outside one (prod)
 * it opens its own transaction. Used e.g. per event, so a half-processed event never leaves rows behind.
 *
 * @param {Function} callback - async work to run atomically
 * @returns {Promise<any>} callback result
 */
export async function withSavepoint(callback) {
  const executor = getDbExecutor();
  if (executor === pool) return withTransaction(callback);

  const name = `sp_${++savepointCounter}`;
  await executor.query(`SAVEPOINT ${name};`);
  try {
    const result = await callback();
    await executor.query(`RELEASE SAVEPOINT ${name};`);
    return result;
  } catch (error) {
    await executor.query(`ROLLBACK TO SAVEPOINT ${name};`);
    throw error;
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
  // Route through the active transaction client (if any) so dry-runs see uncommitted writes
  const dbExecutor = getDbExecutor();
  const result = await dbExecutor.query(`SELECT * FROM ${tableName};`);
  const rows = result.rows;

  if (!asMap) {
    return rows;
  }

  // Resolve PK dynamically from information_schema (cached in RAM)
  const pk = await utils.getTablePrimaryKey(dbExecutor, tableName);
  return utils.dbToMap(rows, pk);
}

/**
 * Universal block replace.
 * If the table declares a replace block (smart comment, migration 007), every existing row of each block present in
 * the incoming data is deleted first (e.g. a security sold off a portfolio-day disappears), then rows are inserted.
 * Without a block, the block is the PK itself: plain UPSERT (insert or update on PK conflict).
 * Automatically hooks into the active AsyncLocalStorage transaction client when running; a block replace outside a
 * transaction opens its own, so the DELETE never commits without its INSERT.
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

  // 3. Discover Primary Key and replace block dynamically via cached metadata
  const pkDef = await utils.getTablePrimaryKey(dbExecutor, tableName);
  const pkColumns = Array.isArray(pkDef) ? pkDef : [pkDef];
  const replaceBlock = await utils.getTableReplaceBlock(dbExecutor, tableName);

  if (replaceBlock) {
    // DELETE + INSERT must be atomic: re-enter inside our own transaction if none is active
    if (dbExecutor === pool) {
      return withTransaction(() => replaceDataInDb(rows, tableName));
    }

    // Distinct blocks in the incoming data, e.g. PROFOND @ 2026-10-01
    const blocks = [
      ...new Map(
        rows.map((row) => {
          const block = Object.fromEntries(
            replaceBlock.map((col) => [col, row[col] ?? null]),
          );
          return [JSON.stringify(block), block];
        }),
      ).values(),
    ];
    const blockColumns = replaceBlock.join(", ");
    const deleted = await dbExecutor.query(
      `
      DELETE FROM ${tableName}
      WHERE (${blockColumns}) IN (
        SELECT ${blockColumns} FROM json_populate_recordset(NULL::${tableName}, $1)
      );`,
      [JSON.stringify(blocks)],
    );
    console.log(
      `[DB REPLACE] Cleared ${blocks.length} block(s) of (${blockColumns}) in "${tableName}": ${deleted.rowCount} rows deleted.`,
    );
  }

  // 4. Columns come from the table schema: every key in the data must be a real column (typos fail loudly), and
  // only the columns present in the data are written, so identity / default / untouched columns are left alone.
  // A row missing a column that other rows have gets NULL for it.
  const tableColumns = await utils.getTableColumns(dbExecutor, tableName);
  const dataKeys = new Set(rows.flatMap((row) => Object.keys(row)));
  const unknownKeys = [...dataKeys].filter(
    (key) => !tableColumns.includes(key),
  );
  if (unknownKeys.length > 0) {
    throw new Error(
      `[DB UPSERT] "${tableName}" has no column(s): ${unknownKeys.join(", ")}`,
    );
  }
  const columns = tableColumns.filter((col) => dataKeys.has(col));
  const nonPkColumns = columns.filter((col) => !pkColumns.includes(col));

  // 5. Build conflict resolution clause
  const conflictTarget = pkColumns.join(", ");
  let conflictAction = "";

  if (nonPkColumns.length > 0) {
    const updateAssignments = nonPkColumns
      .map((col) => `${col} = EXCLUDED.${col}`)
      .join(", ");
    conflictAction = `DO UPDATE SET ${updateAssignments}`;
    // created_at = when the row was last written (ROLL start-date trigger): refreshed only when a value really changes,
    // so re-saving identical rows (e.g. tonight's prices again) doesn't look like a revision
    if (tableColumns.includes("created_at") && !dataKeys.has("created_at")) {
      const current = nonPkColumns.map((col) => `${tableName}.${col}`).join(", ");
      const incoming = nonPkColumns.map((col) => `EXCLUDED.${col}`).join(", ");
      conflictAction += `, created_at = NOW() WHERE (${current}) IS DISTINCT FROM (${incoming})`;
    }
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
