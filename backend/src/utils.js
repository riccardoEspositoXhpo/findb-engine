// backend/utils.js
// Data conversion utilities and schema introspection (ESM)

// In-memory cache for primary keys: Map<tableName, string | string[]>
const pkCache = new Map();

/**
 * Queries PostgreSQL catalog for table primary key column(s) with RAM caching.
 * @param {Object} dbClient - pg pool or client instance
 * @param {string} tableName - Target table name
 * @returns {Promise<string|string[]>} Single column name or array of composite keys
 */
export async function getTablePrimaryKey(dbClient, tableName) {
  if (pkCache.has(tableName)) {
    return pkCache.get(tableName);
  }

  const queryText = `
    SELECT kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    WHERE tc.constraint_type = 'PRIMARY KEY'
      AND tc.table_name = $1
    ORDER BY kcu.ordinal_position;
  `;

  const res = await dbClient.query(queryText, [tableName]);
  const pkColumns = res.rows.map((r) => r.column_name);

  if (pkColumns.length === 0) {
    throw new Error(`[PK ERROR] No primary key found for table "${tableName}"`);
  }

  // Unwrap single column for simplicity, keep array for composite keys
  const pkDef = pkColumns.length === 1 ? pkColumns[0] : pkColumns;
  pkCache.set(tableName, pkDef);
  return pkDef;
}

/**
 * Converts an array of database record objects into an in-memory Map keyed by PK.
 * Supports both single keys and composite primary keys (using '___' delimiter).
 *
 * @param {Array<Object>} records - Array of row objects from DB
 * @param {string|string[]} keyDef - Column name string or array of column names
 * @returns {Map<string, Object>} Fast O(1) in-memory lookup map
 */
export function dbToMap(records, keyDef) {
  const map = new Map();
  if (!Array.isArray(records)) return map;

  const isComposite = Array.isArray(keyDef);

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    // Replicate composite key format from databaseFunctions.gs replaceDataInSheet
    const key = isComposite
      ? keyDef.map((col) => String(record[col] ?? "")).join("___")
      : String(record[keyDef] ?? "");

    map.set(key, record);
  }

  return map;
}

/**
 * Converts an in-memory Map (or dictionary object) back to an arrayOfObjects for DB ingestion.
 *
 * @param {Map<string, Object>|Object} mapOrObject - Source Map or Key-Value dictionary
 * @returns {Array<Object>} Clean array of objects ready for database queries/bulk inserts
 */
export function mapToDb(mapOrObject) {
  if (mapOrObject instanceof Map) {
    return Array.from(mapOrObject.values());
  }
  if (mapOrObject && typeof mapOrObject === "object") {
    return Object.values(mapOrObject);
  }
  return [];
}

/**
 * Formats a Date object, timestamp, or date string into standard ISO 'YYYY-MM-DD'.
 * Immune to UTC midnight shifts and optimized for PostgreSQL DATE column ingestion.
 *
 * @param {Date|string|number} [date=new Date()] - Date to format
 * @returns {string} Formatted date string (YYYY-MM-DD)
 */
export function formatDate(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);

  if (isNaN(d.getTime())) {
    throw new Error(`[DATE ERROR] Invalid date provided: ${date}`);
  }

  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

/**
 * Universal fetch wrapper with automatic exponential backoff retry.
 * Handles transient network/DNS drops (EAI_AGAIN, ETIMEDOUT) and 5xx/429 HTTP statuses.
 *
 * @param {string} url - Target URL
 * @param {RequestInit} [options={}] - Standard fetch options
 * @param {Object} [retryConfig={}] - Retry settings
 * @param {number} [retryConfig.retries=3] - Maximum retry attempts
 * @param {number} [retryConfig.delayMs=2000] - Initial delay in milliseconds
 * @returns {Promise<Response>} Resolves with standard fetch Response
 */
export async function fetchWithRetry(
  url,
  options = {},
  { retries = 3, delayMs = 2000 } = {},
) {
  let attempt = 0;

  while (attempt <= retries) {
    try {
      const response = await fetch(url, options);

      // Retry on rate limit (429) or transient server errors (500, 502, 503, 504)
      if (
        !response.ok &&
        (response.status === 429 || response.status >= 500) &&
        attempt < retries
      ) {
        attempt++;
        const backoff = delayMs * Math.pow(2, attempt - 1);
        console.warn(
          `[FETCH RETRY] Server error ${response.status} from ${url}. Retrying attempt ${attempt}/${retries} in ${backoff}ms...`,
        );
        await new Promise((resolve) => setTimeout(resolve, backoff));
        continue;
      }

      return response;
    } catch (err) {
      attempt++;
      if (attempt > retries) {
        throw err;
      }
      const backoff = delayMs * Math.pow(2, attempt - 1);
      const errorCode = err.cause?.code || err.code || err.message;
      console.warn(
        `[FETCH RETRY] Network drop (${errorCode}) connecting to ${url}. Retrying attempt ${attempt}/${retries} in ${backoff}ms...`,
      );
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }
}
