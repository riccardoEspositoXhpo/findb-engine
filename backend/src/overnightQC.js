// src/overnightQC.js
import { query } from "./db.js";
import { utils } from "./utils.js";

/**
 * Generic Engine: Verifies whether target table has populated rows for targetDate.
 */
export async function hasTableRunToday({
  checkName,
  fromClause,
  displayTable = "fx_rates",
  targetDate = new Date(),
  whereClause = "",
  params = [],
  isWeekdayOnly = false,
  entityLabel = "Records",
  minThreshold = 1,
  severity = "WARNING",
  failureType = "DETERMINISTIC",
}) {
  const dateStr = utils.formatDateToISO(targetDate);
  const dateObj = new Date(dateStr);
  const dayOfWeek = dateObj.getDay();

  if (isWeekdayOnly && (dayOfWeek === 0 || dayOfWeek === 6)) {
    return {
      check: checkName,
      passed: true,
      severity,
      failureType,
      summary: `${entityLabel} market is closed on weekends. Check skipped.`,
      data: [],
      date: dateStr,
    };
  }

  const sql = `SELECT COUNT(*)::int AS count FROM ${fromClause} ${whereClause}`;
  const { rows } = await query(sql, [dateStr, ...params]);
  const count = rows[0]?.count || 0;
  const passed = count >= minThreshold;

  return {
    check: checkName,
    passed,
    severity,
    failureType,
    summary: passed
      ? `${entityLabel} populated for today (${count} records found).`
      : `No ${entityLabel.toLowerCase()} found for today.`,
    message: passed
      ? ""
      : `Expected at least ${minThreshold} ${entityLabel.toLowerCase()}, but found ${count}.`,
    data: passed
      ? []
      : [
          {
            table: displayTable,
            date: dateStr,
            expected_min: minThreshold,
            actual_count: count,
          },
        ],
    date: dateStr,
  };
}

/**
 * Generic Engine: Detects frozen/stale data points comparing target date with prior sessions.
 */
export async function checkStaleData({
  checkName,
  fromClause,
  targetDate = new Date(),
  dateColumn = "f.date",
  valueColumn = "f.rate",
  partitionColumns = "f.base_currency, f.quote_currency",
  entityDisplay = "f.base_currency || '/' || f.quote_currency",
  whereClause = "",
  params = [],
  isWeekdayOnly = false,
  entityLabel = "Pairs",
  severity = "WARNING",
  failureType = "DETERMINISTIC",
}) {
  const dateStr = utils.formatDateToISO(targetDate);
  const dateObj = new Date(dateStr);
  const dayOfWeek = dateObj.getDay();

  if (isWeekdayOnly && (dayOfWeek === 0 || dayOfWeek === 6)) {
    return {
      check: checkName,
      passed: true,
      severity,
      failureType,
      summary: `${entityLabel} market closed on weekends. Staleness check skipped.`,
      data: [],
      date: dateStr,
    };
  }

  const sql = `
    WITH ordered_series AS (
      SELECT 
        ${entityDisplay} AS entity,
        ${dateColumn} AS record_date,
        ${valueColumn} AS current_value,
        LAG(${valueColumn}, 1) OVER (PARTITION BY ${partitionColumns} ORDER BY ${dateColumn}) AS previous_value,
        LAG(${dateColumn}, 1) OVER (PARTITION BY ${partitionColumns} ORDER BY ${dateColumn}) AS previous_date
      FROM ${fromClause}
      ${whereClause}
    )
    SELECT 
      entity,
      record_date::text AS date,
      current_value,
      previous_value,
      previous_date::text AS previous_date
    FROM ordered_series
    WHERE record_date = $1::date
      AND previous_value IS NOT NULL
      AND current_value = previous_value
    ORDER BY entity ASC;
  `;

  const { rows } = await query(sql, [dateStr, ...params]);
  const passed = rows.length === 0;

  return {
    check: checkName,
    passed,
    severity,
    failureType,
    summary: passed
      ? `All ${entityLabel.toLowerCase()} show active rate movement.`
      : `Found ${rows.length} stale ${entityLabel.toLowerCase()} with identical consecutive prices.`,
    message: passed
      ? ""
      : `The following ${entityLabel.toLowerCase()} have frozen values identical to the previous session:`,
    data: rows,
    date: dateStr,
  };
}

/**
 * Generic Engine: Detects anomalous spikes/crashes using Fixed Percentage or Rolling Standard Deviation.
 */
export async function checkOutOfBounds({
  checkName,
  fromClause,
  targetDate = new Date(),
  dateColumn = "f.date",
  valueColumn = "f.rate",
  partitionColumns = "f.base_currency, f.quote_currency",
  entityDisplay = "f.base_currency || '/' || f.quote_currency",
  thresholdPct = 10,
  stdevMultiplier = null,
  lookbackDays = 30,
  whereClause = "",
  params = [],
  isWeekdayOnly = false,
  entityLabel = "Pairs",
  severity = "WARNING",
  failureType = "PROBABILISTIC",
}) {
  const dateStr = utils.formatDateToISO(targetDate);
  const dateObj = new Date(dateStr);
  const dayOfWeek = dateObj.getDay();

  if (isWeekdayOnly && (dayOfWeek === 0 || dayOfWeek === 6)) {
    return {
      check: checkName,
      passed: true,
      severity,
      failureType,
      summary: `${entityLabel} market closed on weekends. Out of bounds check skipped.`,
      data: [],
      date: dateStr,
    };
  }

  const sql = `
    WITH daily_moves AS (
      SELECT 
        ${entityDisplay} AS entity,
        ${dateColumn} AS record_date,
        ${valueColumn} AS current_val,
        LAG(${valueColumn}, 1) OVER (PARTITION BY ${partitionColumns} ORDER BY ${dateColumn}) AS prev_val
      FROM ${fromClause}
      ${whereClause}
    ),
    metrics AS (
      SELECT 
        entity,
        record_date,
        current_val,
        prev_val,
        ROUND(ABS((current_val - prev_val) / NULLIF(prev_val, 0) * 100)::numeric, 4) AS change_pct,
        ${
          stdevMultiplier
            ? `STDDEV_SAMP(ABS((current_val - prev_val) / NULLIF(prev_val, 0) * 100)) OVER (
                 PARTITION BY entity 
                 ORDER BY record_date 
                 ROWS BETWEEN ${lookbackDays} PRECEDING AND 1 PRECEDING
               ) AS rolling_stdev`
            : "NULL::numeric AS rolling_stdev"
        }
      FROM daily_moves
      WHERE prev_val IS NOT NULL
    )
    SELECT 
      entity,
      record_date::text AS date,
      current_val,
      prev_val,
      change_pct,
      ${stdevMultiplier ? "ROUND(rolling_stdev::numeric, 4)" : "NULL"} AS rolling_stdev,
      ${
        stdevMultiplier
          ? `ROUND((rolling_stdev * ${stdevMultiplier})::numeric, 4)`
          : `${thresholdPct}`
      } AS threshold_pct
    FROM metrics
    WHERE record_date = $1::date
      AND (
        ${
          stdevMultiplier
            ? `change_pct > (rolling_stdev * ${stdevMultiplier})`
            : `change_pct > ${thresholdPct}`
        }
      )
    ORDER BY change_pct DESC;
  `;

  const { rows } = await query(sql, [dateStr, ...params]);
  const passed = rows.length === 0;

  return {
    check: checkName,
    passed,
    severity,
    failureType,
    summary: passed
      ? `All ${entityLabel.toLowerCase()} day-over-day movements within limits.`
      : `Found ${rows.length} ${entityLabel.toLowerCase()} with excessive price movement.`,
    message: passed
      ? ""
      : `The following ${entityLabel.toLowerCase()} breached threshold limits:`,
    data: rows,
    date: dateStr,
  };
}

/**
 * Generic Engine: Detects missing calendar dates in historical time series.
 * Option A (Day-level Invariant): Verifies that the daily ingestion batch executed
 * and populated records for every expected calendar day without pipeline blackouts.
 */
export async function isTimeSeriesContinuous({
  checkName,
  fromClause,
  startDate,
  endDate = new Date(),
  dateColumn = "f.date",
  whereClause = "",
  params = [],
  isWeekdayOnly = false,
  entityLabel = "Time Series",
  severity = "WARNING",
  failureType = "DETERMINISTIC",
}) {
  const startStr = utils.formatDateToISO(startDate);
  const endStr = utils.formatDateToISO(endDate);

  const sql = `
    WITH calendar AS (
      SELECT d::date AS expected_date
      FROM generate_series($1::date, $2::date, '1 day'::interval) d
      ${isWeekdayOnly ? "WHERE EXTRACT(ISODOW FROM d) < 6" : ""}
    ),
    daily_counts AS (
      SELECT 
        ${dateColumn}::date AS record_date,
        COUNT(*)::int AS records_count
      FROM ${fromClause}
      ${whereClause}
      GROUP BY ${dateColumn}::date
    ),
    eval_matrix AS (
      SELECT 
        c.expected_date,
        COALESCE(dc.records_count, 0) AS records_count,
        LAG(COALESCE(dc.records_count, 0), 1) OVER (ORDER BY c.expected_date ASC) AS prev_records_count
      FROM calendar c
      LEFT JOIN daily_counts dc ON c.expected_date = dc.record_date
    )
    SELECT 
      expected_date::text AS missing_date,
      TRIM(TO_CHAR(expected_date, 'Day')) AS day_of_week,
      records_count,
      CASE 
        WHEN records_count = 0 THEN 'PIPELINE BLACKOUT (0 records inserted)'
        ELSE 'DROP DETECTED (' || records_count || ' vs prev ' || prev_records_count || ')'
      END AS status
    FROM eval_matrix
    WHERE records_count = 0
    ORDER BY expected_date ASC;
  `;

  const { rows } = await query(sql, [startStr, endStr, ...params]);
  const passed = rows.length === 0;

  return {
    check: checkName,
    passed,
    severity,
    failureType,
    summary: passed
      ? `${entityLabel} pipeline is continuous between ${startStr} and ${endStr}.`
      : `Detected ${rows.length} missing session(s) in ${entityLabel}.`,
    message: passed
      ? ""
      : `Identified missing calendar dates in historical feed:`,
    data: rows,
    date: endStr,
  };
}

// ============================================================================
// FX & CRYPTO SPECIALIZATIONS
// ============================================================================

const FX_FROM = `
  fx_rates f
  JOIN currencies c_base ON f.base_currency = c_base.currency_code
  JOIN currencies c_quote ON f.quote_currency = c_quote.currency_code
`;

export async function hasCryptoRunToday(targetDate = new Date()) {
  return hasTableRunToday({
    checkName: "hasCryptoRunToday",
    fromClause: FX_FROM,
    displayTable: "fx_rates",
    targetDate,
    whereClause:
      "WHERE f.date = $1::date AND (c_base.type = 'CRYPTO' OR c_quote.type = 'CRYPTO')",
    isWeekdayOnly: false,
    entityLabel: "Crypto FX rates",
    severity: "CRITICAL",
    failureType: "DETERMINISTIC",
  });
}

export async function hasFxRunToday(targetDate = new Date()) {
  return hasTableRunToday({
    checkName: "hasFxRunToday",
    fromClause: FX_FROM,
    displayTable: "fx_rates",
    targetDate,
    whereClause:
      "WHERE f.date = $1::date AND c_base.type = 'FIAT' AND c_quote.type = 'FIAT'",
    isWeekdayOnly: true,
    entityLabel: "Fiat FX rates",
    severity: "CRITICAL",
    failureType: "DETERMINISTIC",
  });
}

export async function checkCryptoFxStale(targetDate = new Date()) {
  return checkStaleData({
    checkName: "checkCryptoFxStale",
    fromClause: FX_FROM,
    targetDate,
    whereClause: "WHERE (c_base.type = 'CRYPTO' OR c_quote.type = 'CRYPTO')",
    isWeekdayOnly: false,
    entityLabel: "Crypto Rates",
    severity: "WARNING",
    failureType: "DETERMINISTIC",
  });
}

export async function checkFiatFxStale(targetDate = new Date()) {
  return checkStaleData({
    checkName: "checkFiatFxStale",
    fromClause: FX_FROM,
    targetDate,
    whereClause: "WHERE c_base.type = 'FIAT' AND c_quote.type = 'FIAT'",
    isWeekdayOnly: true,
    entityLabel: "Fiat FX Rates",
    severity: "WARNING",
    failureType: "DETERMINISTIC",
  });
}

export async function checkCryptoFxOutOfBounds(targetDate = new Date()) {
  return checkOutOfBounds({
    checkName: "checkCryptoFxOutOfBounds",
    fromClause: FX_FROM,
    targetDate,
    thresholdPct: 15.0,
    whereClause: "WHERE (c_base.type = 'CRYPTO' OR c_quote.type = 'CRYPTO')",
    isWeekdayOnly: false,
    entityLabel: "Crypto FX Rates",
    severity: "WARNING",
    failureType: "PROBABILISTIC",
  });
}

export async function checkFiatFxOutOfBounds(targetDate = new Date()) {
  return checkOutOfBounds({
    checkName: "checkFiatFxOutOfBounds",
    fromClause: FX_FROM,
    targetDate,
    thresholdPct: 2.5,
    whereClause: "WHERE c_base.type = 'FIAT' AND c_quote.type = 'FIAT'",
    isWeekdayOnly: true,
    entityLabel: "Fiat FX Rates",
    severity: "CRITICAL",
    failureType: "PROBABILISTIC",
  });
}

export async function isCryptoFxContinuous(startDate, endDate = new Date()) {
  const start = startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  return isTimeSeriesContinuous({
    checkName: "isCryptoFxContinuous",
    fromClause: FX_FROM,
    startDate: start,
    endDate,
    whereClause: "WHERE (c_base.type = 'CRYPTO' OR c_quote.type = 'CRYPTO')",
    isWeekdayOnly: false,
    entityLabel: "Crypto FX Time Series",
    severity: "WARNING",
    failureType: "DETERMINISTIC",
  });
}

export async function isFiatFxContinuous(startDate, endDate = new Date()) {
  const start = startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  return isTimeSeriesContinuous({
    checkName: "isFiatFxContinuous",
    fromClause: FX_FROM,
    startDate: start,
    endDate,
    whereClause: "WHERE c_base.type = 'FIAT' AND c_quote.type = 'FIAT'",
    isWeekdayOnly: true,
    entityLabel: "Fiat FX Time Series",
    severity: "WARNING",
    failureType: "DETERMINISTIC",
  });
}

export const overnightQC = {
  hasCryptoRunToday,
  hasFxRunToday,
  checkCryptoFxStale,
  checkFiatFxStale,
  checkCryptoFxOutOfBounds,
  checkFiatFxOutOfBounds,
  isCryptoFxContinuous,
  isFiatFxContinuous,
  runAll,
};

async function runAll(targetDate = new Date()) {
  const results = await Promise.all([
    hasCryptoRunToday(targetDate),
    hasFxRunToday(targetDate),
    checkCryptoFxStale(targetDate),
    checkFiatFxStale(targetDate),
    checkCryptoFxOutOfBounds(targetDate),
    checkFiatFxOutOfBounds(targetDate),
    isCryptoFxContinuous(null, targetDate),
    isFiatFxContinuous(null, targetDate),
  ]);

  return { results };
}
