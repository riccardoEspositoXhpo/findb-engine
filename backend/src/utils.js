// backend/utils.js
// Data conversion utilities and schema introspection (ESM)
export const utils = {
  getTablePrimaryKey,
  dbToMap,
  mapToDb,
  formatDateToISO,
  fetchWithRetry,
  convertItalianFloat,
  doesItRunToday,
};

/**
 * Evaluates whether a security or portfolio should be valued on targetDate.
 * Uses strict Postgres schema columns: valuation_frequency ('DLY','BIZ','WKL','MTH') and valuation_day (INT).
 */
function doesItRunToday(entity, targetDate = new Date()) {
  const dateObj =
    targetDate instanceof Date ? targetDate : new Date(targetDate);
  const freq = (entity.valuation_frequency || "").toUpperCase().trim();
  const valDay = Number(entity.valuation_day || null);

  switch (freq) {
    case "DLY":
      return true;
    case "BIZ": {
      const dow = dateObj.getUTCDay();
      return dow >= 1 && dow <= 5;
    }
    case "WKL":
      return dateObj.getUTCDay() === valDay;
    case "MTH":
      return dateObj.getUTCDate() === valDay;
    default:
      return false;
  }
}

/**
 * Custom parseFloat that parses Italian formatted numbers,
 * strips arbitrary prefixes (like 'EUR', '~', whitespace), and returns a standard float.
 *
 * Examples:
 * - "EUR 35.123,49" -> 35123.49
 * - " ~ 1.250,50 EUR " -> 1250.5
 * - "101,42" -> 101.42
 *
 * @param {string|number} rawStr - Raw input string or number
 * @returns {number} Standard floating-point number
 */
function convertItalianFloat(rawStr) {
  if (rawStr === null || rawStr === undefined) return NaN;
  if (typeof rawStr === "number") return rawStr;

  // Convert to string and clean up weird prefixes, symbols, and whitespace
  const cleaned = String(rawStr)
    .replace(/[a-zA-Z]/g, "") // remove currency symbols / text like EUR
    .replace(/[^0-9.,-]/g, "") // strip everything except digits, dots, commas, minus signs
    .trim();

  if (!cleaned) return NaN;

  // Detect Italian format: if both dot and comma exist, or if comma is used as decimal separator
  let normalized = cleaned;
  if (cleaned.includes(".") && cleaned.includes(",")) {
    // Assume European format: dots are thousand separators, comma is decimal
    normalized = cleaned.replace(/\./g, "").replace(",", ".");
  } else if (cleaned.includes(",")) {
    // Only comma exists, treat it as the decimal separator
    normalized = cleaned.replace(",", ".");
  } else {
    /**
     * Only dots or pure number: check if dot acts as thousand or decimal
     * Standard Italian single dot case like "12.573" without decimals could be ambiguous,
     * but typically European strings have decimals. If it's pure standard US or integer, parseFloat handles it.
     * If it has multiple dots (e.g. "1.250.500"), remove all but the last or replace them.
     */
    const lastDotIndex = cleaned.lastIndexOf(".");
    if (lastDotIndex !== -1 && cleaned.indexOf(".") !== lastDotIndex) {
      normalized = cleaned.replace(/\./g, (match, offset) =>
        offset === lastDotIndex ? "." : "",
      );
    }
  }

  return parseFloat(normalized);
}

// In-memory cache for primary keys: Map<tableName, string | string[]>
const pkCache = new Map();

/**
 * Queries PostgreSQL catalog for table primary key column(s) with RAM caching.
 * @param {Object} dbClient - pg pool or client instance
 * @param {string} tableName - Target table name
 * @returns {Promise<string|string[]>} Single column name or array of composite keys
 */
async function getTablePrimaryKey(dbClient, tableName) {
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
function dbToMap(records, keyDef) {
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
function mapToDb(mapOrObject) {
  if (mapOrObject instanceof Map) {
    return Array.from(mapOrObject.values());
  }
  if (mapOrObject && typeof mapOrObject === "object") {
    return Object.values(mapOrObject);
  }
  return [];
}

// utilities.gs

/**
 * Unified date formatter. Converts a Date object, timestamp, or date string
 * in various formats (e.g., 'DD/MM/YYYY', 'YYYY-MM-DD') into standard ISO 'YYYY-MM-DD'.
 * Optimized for PostgreSQL DATE column ingestion and immune to timezone shifts.
 *
 * @param {Date|string|number} [inputDate=new Date()] - Date to format
 * @param {string} [inputFormat="DD/MM/YYYY"] - Optional expected input format if parsing strings (e.g., "DD/MM/YYYY", "YYYY-MM-DD")
 * @returns {string|null} Formatted date string (YYYY-MM-DD) or null
 */
function formatDateToISO(inputDate = new Date(), inputFormat = "DD/MM/YYYY") {
  if (!inputDate) return null;

  // If it's already a Date object or timestamp, format it directly using UTC methods to avoid shifts
  if (inputDate instanceof Date || typeof inputDate === "number") {
    const d = new Date(inputDate);
    if (!isNaN(d.getTime())) {
      const year = d.getUTCFullYear();
      const month = String(d.getUTCMonth() + 1).padStart(2, "0");
      const day = String(d.getUTCDate()).padStart(2, "0");
      return `${year}-${month}-${day}`;
    }
  }

  // Otherwise, handle string-based parsing based on inputFormat
  const strDate = String(inputDate).trim();
  if (!strDate) return null;

  // Support alternative separators like hyphens or dots by normalizing to slashes
  const normalizedStrDate = strDate.replace(/[-.]/g, "/");
  const normalizedFormat = inputFormat.replace(/[-.]/g, "/");

  const dateParts = normalizedStrDate.split("/");
  const formatParts = normalizedFormat.split("/");

  if (dateParts.length !== 3 || formatParts.length !== 3) {
    // Fallback to standard JS parser if parts don't match
    const fallbackDate = new Date(strDate);
    if (!isNaN(fallbackDate.getTime())) {
      const year = fallbackDate.getFullYear();
      const month = String(fallbackDate.getMonth() + 1).padStart(2, "0");
      const day = String(fallbackDate.getDate()).padStart(2, "0");
      return `${year}-${month}-${day}`;
    }
    throw new Error(
      `[DATE ERROR] Invalid date or format provided: ${inputDate} with format ${inputFormat}`,
    );
  }

  const map = {};
  formatParts.forEach((part, idx) => {
    map[part[0].toUpperCase()] = parseInt(dateParts[idx], 10);
  });

  const year = map.Y >= 0 && map.Y <= 99 ? 2000 + map.Y : map.Y;
  const month = String(map.M).padStart(2, "0");
  const day = String(map.D).padStart(2, "0");

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
async function fetchWithRetry(
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
