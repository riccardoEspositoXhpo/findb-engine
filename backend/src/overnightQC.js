// overnightQC.js
import { query } from "../db.js";
import { utils } from "../utils.js";

/**
 * Generic, reusable engine to verify if an arbitrary table/pipeline has run for a target date.
 * Replaces the legacy `hasProductionRun` check from local.gs.
 *
 * @param {Object} options
 * @param {string} options.checkName - Unique identifier for the QC report
 * @param {string} options.tableName - Target DB table or view
 * @param {Date|string} options.targetDate - Valuation date
 * @param {string} [options.dateColumn='date'] - Date column name in the table
 * @param {string} [options.whereClause=''] - Optional additional SQL predicates (e.g. JOINs / filters)
 * @param {Array} [options.params=[]] - Query parameter bindings
 * @param {boolean} [options.isWeekdayOnly=false] - If true, auto-passes on weekends (Saturday & Sunday)
 * @param {string} [options.entityLabel='Records'] - Human-readable label for the summary
 * @param {number} [options.minThreshold=1] - Minimum row count required to pass
 * @returns {Promise<Object>} Standardized QC check payload
 */
export async function hasTableRunToday({
  checkName,
  tableName,
  targetDate = new Date(),
  dateColumn = "date",
  whereClause = "",
  params = [],
  isWeekdayOnly = false,
  entityLabel = "Records",
  minThreshold = 1,
}) {
  const dateObj =
    targetDate instanceof Date ? targetDate : new Date(targetDate);
  const dateStr = utils.toIsoDate(dateObj);
  const dayOfWeek = dateObj.getDay(); // 0 = Sunday, 6 = Saturday

  // If the check is weekday-only and today is a weekend session, bypass query and pass cleanly
  if (isWeekdayOnly && (dayOfWeek === 0 || dayOfWeek === 6)) {
    return {
      check: checkName,
      passed: true,
      severity: "WARNING",
      summary: `${entityLabel} market is closed on weekends. Check skipped.`,
      data: [],
      date: dateStr,
    };
  }

  // Construct parameterized query. $1 is always the target date
  const sql = `
    SELECT COUNT(*)::int AS count
    FROM ${tableName}
    ${whereClause}
  `;

  const queryParams = [dateStr, ...params];
  const { rows } = await query(sql, queryParams);
  const count = rows[0]?.count || 0;
  const passed = count >= minThreshold;

  return {
    check: checkName,
    passed,
    severity: "WARNING",
    summary: passed
      ? `${entityLabel} populated for today (${count} records found).`
      : `No ${entityLabel.toLowerCase()} found for today.`,
    data: passed
      ? []
      : [
          {
            table: tableName,
            date: dateStr,
            expected_min: minThreshold,
            actual_count: count,
          },
        ],
    date: dateStr,
  };
}

/**
 * Verifies that Crypto FX rates have been populated in fx_rates for targetDate.
 * Runs 24/7 (continuous crypto calendar).
 */
export async function hasCryptoRunToday(targetDate = new Date()) {
  return hasTableRunToday({
    checkName: "hasCryptoRunToday",
    tableName:
      "fx_rates f JOIN currencies c ON f.base_currency = c.currency_code",
    targetDate,
    whereClause: "WHERE f.date = $1::date AND c.type = 'CRYPTO'",
    isWeekdayOnly: false,
    entityLabel: "Crypto FX rates",
  });
}

/**
 * Verifies that Fiat FX rates have been populated in fx_rates for targetDate.
 * Runs strictly on weekdays (Monday - Friday). Bypasses execution on weekends.
 * Explicitly filters for c.type = 'FIAT' to isolate from CRYPTO and STABLECOIN.
 */
export async function hasFxRunToday(targetDate = new Date()) {
  return hasTableRunToday({
    checkName: "hasFxRunToday",
    tableName:
      "fx_rates f JOIN currencies c ON f.base_currency = c.currency_code",
    targetDate,
    whereClause: "WHERE f.date = $1::date AND c.type = 'FIAT'",
    isWeekdayOnly: true,
    entityLabel: "Fiat FX rates",
  });
}

export const overnightQC = {
  hasTableRunToday,
  hasCryptoRunToday,
  hasFxRunToday,
  runAll,
};

async function runAll(targetDate = new Date()) {
  const results = await Promise.all([
    hasCryptoRunToday(targetDate),
    hasFxRunToday(targetDate),
  ]);

  return { results };
}
