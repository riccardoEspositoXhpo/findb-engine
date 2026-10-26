// backend/utils.js
// Data conversion utilities and schema introspection (ESM)
import zlib from "zlib";
export const utils = {
  getTablePrimaryKey,
  getTableReplaceBlock,
  getTableColumns,
  dbToMap,
  mapToDb,
  formatDateToISO,
  addDays,
  daysBetween,
  fetchWithRetry,
  convertItalianFloat,
  doesItRunToday,
  readXls,
  readPdfText,
};

/**
 * ISO date + n calendar days (n can be negative). TZ is UTC (config.js), so no DST surprises.
 *
 * @param {Date|string} date
 * @param {number} days
 * @returns {string} ISO date
 */
function addDays(date, days) {
  const result = new Date(`${formatDateToISO(date)}T00:00:00Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

/**
 * Every ISO day from firstDay to lastDay, both included (empty if firstDay > lastDay).
 *
 * @param {Date|string} firstDay
 * @param {Date|string} lastDay
 * @returns {string[]} ISO dates
 */
function daysBetween(firstDay, lastDay) {
  const days = [];
  const last = formatDateToISO(lastDay);
  for (let day = formatDateToISO(firstDay); day <= last; day = addDays(day, 1)) days.push(day);
  return days;
}

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

// In-memory cache for table columns: Map<tableName, string[]>
const columnsCache = new Map();

/**
 * Queries PostgreSQL catalog for the table's column names (in table order), with RAM caching.
 * @param {Object} dbClient - pg pool or client instance
 * @param {string} tableName - Target table name
 * @returns {Promise<string[]>} Column names
 */
async function getTableColumns(dbClient, tableName) {
  if (columnsCache.has(tableName)) {
    return columnsCache.get(tableName);
  }

  const res = await dbClient.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position;`,
    [tableName],
  );
  const columns = res.rows.map((r) => r.column_name);
  if (columns.length === 0) {
    throw new Error(`[COLUMNS ERROR] Table "${tableName}" not found`);
  }

  columnsCache.set(tableName, columns);
  return columns;
}

// In-memory cache for replace blocks: Map<tableName, string[] | null>
const replaceBlockCache = new Map();

/**
 * Reads the table's replace block from its "smart comment" (migration 007), with RAM caching.
 * COMMENT ON TABLE positions IS '{"replace_block": ["date", "portfolio_id"]}'
 * Non-JSON comments or comments without replace_block mean no block (plain upsert).
 * Equivalent of SHEET_KEYS[sheet].replacement in // global.gs, but declared in the schema.
 *
 * @param {Object} dbClient - pg pool or client instance
 * @param {string} tableName - Target table name
 * @returns {Promise<string[]|null>} Block columns, or null if the table has no block
 */
async function getTableReplaceBlock(dbClient, tableName) {
  if (replaceBlockCache.has(tableName)) {
    return replaceBlockCache.get(tableName);
  }

  const res = await dbClient.query(
    `SELECT obj_description(to_regclass($1), 'pg_class') AS comment;`,
    [tableName],
  );

  let replaceBlock = null;
  try {
    const parsed = JSON.parse(res.rows[0]?.comment ?? "null");
    if (
      Array.isArray(parsed?.replace_block) &&
      parsed.replace_block.length > 0
    ) {
      replaceBlock = parsed.replace_block;
    }
  } catch {
    // Plain-text comment (e.g. 'test'): not a smart comment, no block
  }

  replaceBlockCache.set(tableName, replaceBlock);
  return replaceBlock;
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

  // Already ISO (YYYY-MM-DD...): pass through, otherwise the default DD/MM/YYYY mapping scrambles it
  if (/^\d{4}-\d{2}-\d{2}/.test(strDate)) return strDate.slice(0, 10);

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

/**
 * Minimal reader for old Excel files (.xls, BIFF8 inside an OLE container), no dependency: enough for the broker exports
 * we parse (Allianz). Reads text (shared strings, labels) and numbers (NUMBER, RK, MULRK) cells; dates stay Excel
 * serial numbers (excelSerialToISO). No formulas, formats or merged cells.
 *
 * @param {Buffer} buffer - The .xls file
 * @returns {Object<string, Array<Array<string|number>>>} sheet name -> rows of cells ("" when empty)
 */
function readXls(buffer) {
  // OLE compound file: FAT chains of sectors; the "Workbook" stream holds the BIFF records
  const sectorSize = 1 << buffer.readUInt16LE(30);
  const fatSectors = [];
  for (let i = 0; i < buffer.readUInt32LE(44) && i < 109; i++) fatSectors.push(buffer.readUInt32LE(76 + i * 4));
  const sector = (i) => buffer.subarray(512 + i * sectorSize, 512 + (i + 1) * sectorSize);
  const fat = [];
  for (const s of fatSectors) for (let o = 0; o < sectorSize; o += 4) fat.push(sector(s).readUInt32LE(o));
  const chain = (start) => {
    const parts = [];
    for (let i = start; i < 0xfffffffa; i = fat[i]) parts.push(sector(i));
    return Buffer.concat(parts);
  };
  const directory = chain(buffer.readUInt32LE(48));
  let workbook = null;
  for (let o = 0; o < directory.length; o += 128) {
    const nameLength = directory.readUInt16LE(o + 64);
    const name = directory.subarray(o, o + Math.max(nameLength - 2, 0)).toString("utf16le");
    if (name === "Workbook" || name === "Book") workbook = chain(directory.readUInt32LE(o + 116)).subarray(0, directory.readUInt32LE(o + 120));
  }
  if (!workbook) throw new Error("readXls: no Workbook stream (not a BIFF8 .xls?)");

  const records = [];
  for (let p = 0; p + 4 <= workbook.length; ) {
    const length = workbook.readUInt16LE(p + 2);
    records.push([workbook.readUInt16LE(p), workbook.subarray(p + 4, p + 4 + length)]);
    p += 4 + length;
  }
  const readString = (buf, pos, chars, flags) =>
    flags & 1 ? [buf.toString("utf16le", pos, pos + 2 * chars), pos + 2 * chars] : [buf.toString("latin1", pos, pos + chars), pos + chars];
  const rk = (value) => {
    const n = value & 2 ? value >> 2 : new DataView(new Uint32Array([0, value & 0xfffffffc]).buffer).getFloat64(0, true);
    return value & 1 ? n / 100 : n;
  };

  const sheetNames = [];
  const sst = [];
  const cells = [];
  let current = -1;
  for (let i = 0; i < records.length; i++) {
    const [type, b] = records[i];
    if (type === 0x85) sheetNames.push(readString(b, 8, b[6], b[7])[0]);
    else if (type === 0xfc) {
      // Shared strings, possibly split over CONTINUE records (each continuation restarts with a flags byte)
      const parts = [b];
      while (i + 1 < records.length && records[i + 1][0] === 0x3c) parts.push(records[++i][1]);
      let part = 0;
      let buf = parts[0];
      let pos = 8;
      for (let k = 0, total = b.readUInt32LE(4); k < total; k++) {
        if (pos >= buf.length) { buf = parts[++part]; pos = 0; }
        let chars = buf.readUInt16LE(pos);
        let flags = buf[pos + 2];
        pos += 3;
        const richRuns = flags & 8 ? buf.readUInt16LE(pos) : 0;
        if (flags & 8) pos += 2;
        const extSize = flags & 4 ? buf.readUInt32LE(pos) : 0;
        if (flags & 4) pos += 4;
        let text = "";
        while (chars > 0) {
          const take = Math.min(chars, Math.floor((buf.length - pos) / (flags & 1 ? 2 : 1)));
          const [chunk, next] = readString(buf, pos, take, flags);
          text += chunk;
          pos = next;
          chars -= take;
          if (chars > 0) { buf = parts[++part]; flags = buf[0]; pos = 1; }
        }
        pos += richRuns * 4 + extSize;
        sst.push(text);
      }
    } else if (type === 0x809 && b.readUInt16LE(2) === 0x10) cells[++current] = new Map();
    else if (current >= 0) {
      const set = (row, col, value) => cells[current].set(`${row},${col}`, value);
      if (type === 0xfd) set(b.readUInt16LE(0), b.readUInt16LE(2), sst[b.readUInt32LE(6)]);
      else if (type === 0x203) set(b.readUInt16LE(0), b.readUInt16LE(2), b.readDoubleLE(6));
      else if (type === 0x27e) set(b.readUInt16LE(0), b.readUInt16LE(2), rk(b.readUInt32LE(6)));
      else if (type === 0xbd) {
        const row = b.readUInt16LE(0);
        const firstCol = b.readUInt16LE(2);
        for (let j = 0; j < Math.floor((b.length - 6) / 6); j++) set(row, firstCol + j, rk(b.readUInt32LE(4 + j * 6 + 2)));
      } else if (type === 0x204) set(b.readUInt16LE(0), b.readUInt16LE(2), readString(b, 9, b.readUInt16LE(6), b[8])[0]);
    }
  }

  const workbookSheets = {};
  sheetNames.forEach((name, index) => {
    const sheet = cells[index] ?? new Map();
    const keys = [...sheet.keys()].map((key) => key.split(",").map(Number));
    const rows = keys.length ? Math.max(...keys.map(([r]) => r)) + 1 : 0;
    const cols = keys.length ? Math.max(...keys.map(([, c]) => c)) + 1 : 0;
    workbookSheets[name] = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => sheet.get(`${r},${c}`) ?? ""));
  });
  return workbookSheets;
}

/**
 * Minimal PDF text extractor, no dependency: inflates the content streams and returns the strings drawn with Tj / TJ,
 * one per line, in drawing order. Enough for machine-generated broker notes with standard fonts (Directa: Courier,
 * WinAnsi, one Tj per table row with the spacing inside the string). Not for scans, CID fonts or reordered layouts.
 *
 * @param {Buffer} buffer - The .pdf file
 * @returns {string} text, one drawn string per line
 */
function readPdfText(buffer) {
  const raw = buffer.toString("latin1");
  const lines = [];
  const escapes = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };
  // Literal string starting at content[i] === "(": balanced parentheses, backslash escapes (\n, \(, \ddd octal)
  const readLiteral = (content, i) => {
    let text = "";
    let depth = 0;
    for (i++; i < content.length; i++) {
      const char = content[i];
      if (char === "\\") {
        const octal = content.slice(i + 1).match(/^[0-7]{1,3}/)?.[0];
        if (octal) { text += String.fromCharCode(parseInt(octal, 8)); i += octal.length; }
        else { text += escapes[content[i + 1]] ?? content[i + 1]; i++; }
      } else if (char === "(") { depth++; text += char; }
      else if (char === ")") { if (depth === 0) return [text, i + 1]; depth--; text += char; }
      else text += char;
    }
    return [text, i];
  };
  const operatorAt = (content, i) => content.slice(i).match(/^\s*(\S{1,2})/)?.[1];

  for (const match of raw.matchAll(/stream\r?\n/g)) {
    const start = match.index + match[0].length;
    const end = raw.indexOf("endstream", start);
    if (end < 0) continue;
    let content = raw.slice(start, end);
    try {
      content = zlib.inflateSync(Buffer.from(content, "latin1")).toString("latin1");
    } catch {
      // not compressed: used as is
    }
    if (!content.includes("BT") || !(content.includes("Tj") || content.includes("TJ"))) continue; // fonts, images...
    // Text lives only inside BT ... ET blocks: scanning only there skips inline images (binary bytes, stray parentheses)
    for (const block of content.matchAll(/(?:^|\s)BT\s([\s\S]*?)\sET(?=\s|$)/g)) scanText(block[1]);
  }
  return lines.join("\n");

  function scanText(content) {
    for (let i = 0; i < content.length; i++) {
      if (content[i] === "(") {
        const [text, next] = readLiteral(content, i);
        if (operatorAt(content, next) === "Tj") lines.push(text);
        i = next - 1;
      } else if (content[i] === "[") {
        const parts = [];
        let j = i + 1;
        while (j < content.length && content[j] !== "]") {
          if (content[j] === "(") { const [text, next] = readLiteral(content, j); parts.push(text); j = next; }
          else j++;
        }
        if (operatorAt(content, j + 1) === "TJ") lines.push(parts.join(""));
        i = j;
      }
    }
  }
}
