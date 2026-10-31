// src/overnightQC.js
import { query } from "./db.js";
import { batchLog } from "./batchLog.js";
import { utils } from "./utils.js";
import { loadFxRates, currencyConverter } from "./marketData.js";
import { ledger, OUTFLOW_TYPES } from "./ledger.js";
import { isPortfolioActive } from "./valuation.js";

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
          // Standard deviation of the signed daily moves (the move's own volatility), compared with today's |move|
          stdevMultiplier
            ? `STDDEV_SAMP((current_val - prev_val) / NULLIF(prev_val, 0) * 100) OVER (
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

// Dynamic per pair: today's move beyond 3 standard deviations of its last 90 daily moves (BTC moves less than BETA).
// 3, not 2: ~100 pairs move together, 2 flagged ~6 a day (34 on a big day), 3 flags ~2.4 (user, 2026-10-28)
export async function checkCryptoFxOutOfBounds(targetDate = new Date()) {
  return checkOutOfBounds({
    checkName: "checkCryptoFxOutOfBounds",
    fromClause: FX_FROM,
    targetDate,
    stdevMultiplier: 3,
    lookbackDays: 90,
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

// ============================================================================
// LEDGER, POSITIONS, NAV & AGGREGATES
// ============================================================================
// Checks over history that would fail every night on known, accepted rows (Binance micro-fills, GAS leftovers) only
// look at rows written today (created_at >= the run date): a problem is reported the night it appears.

const MAX_ROWS = 50;
// Securities valued at 1 per unit or in their own currency: no lots, no price feed
const CASH_LIKE = `(s.asset_type IN ('CASH', 'DEBT') OR s.security_id IN (SELECT currency_code FROM currencies WHERE type = 'STABLECOIN'))`;
// Money in / out of a portfolio (not performance): the flows a nav jump is explained by
const EXTERNAL_IN = ["CASHIN", "ASSETIN", "ADJUST_IN"];
const EXTERNAL_OUT = ["CASHOUT", "ASSETOUT", "ADJUST_OUT"];
// Price age allowed for a held, priced security (calendar days): ~5 trading sessions for daily feeds
const PRICE_MAX_AGE_DAYS = { DLY: 7, BIZ: 7, WKL: 14, MTH: 45 };
// Unexplained day-on-day move allowed (%), and the smallest value checked (EUR / base)
// Nav / aggregate jumps, dynamic like the crypto rates (user, 2026-10-28): a move (after money in / out) is flagged
// beyond JUMP_SIGMAS standard deviations of the same series' previous JUMP_LOOKBACK moves, never below JUMP_MIN_PCT
// (a series that barely moves, e.g. DEBT, has a σ near 0); fewer than JUMP_MIN_HISTORY moves -> JUMP_DEFAULT_PCT
const JUMP_SIGMAS = 3;
const JUMP_LOOKBACK = 90;
const JUMP_MIN_PCT = 2;
const JUMP_MIN_HISTORY = 10;
const JUMP_DEFAULT_PCT = 10;
const MIN_VALUE_CHECKED = 500;

/** Allowed |move| (%) given the moves before it (%, oldest first): JUMP_SIGMAS x their standard deviation. */
function jumpLimit(previousMoves, minPct = JUMP_MIN_PCT) {
  const moves = previousMoves.slice(-JUMP_LOOKBACK);
  if (moves.length < JUMP_MIN_HISTORY)
    return { limit: Math.max(JUMP_DEFAULT_PCT, minPct), sigma: null };
  const mean = moves.reduce((sum, move) => sum + move, 0) / moves.length;
  const sigma = Math.sqrt(
    moves.reduce((sum, move) => sum + (move - mean) ** 2, 0) /
      (moves.length - 1),
  );
  return { limit: Math.max(JUMP_SIGMAS * sigma, minPct), sigma };
}

/** Result in the shape every check returns (rows = what failed, capped for the email). */
function qcResult(
  checkName,
  dateStr,
  rows,
  { severity, failureType = "DETERMINISTIC", ok, fail, message = "" },
) {
  const passed = rows.length === 0;
  return {
    check: checkName,
    passed,
    severity,
    failureType,
    summary: passed ? ok : fail(rows.length),
    message: passed ? "" : message,
    data: rows.slice(0, MAX_ROWS),
    date: dateStr,
  };
}

const round = (value, digits = 2) =>
  value === null || value === undefined
    ? null
    : Number(Number(value).toFixed(digits));

/** T1: identical transactions (date, portfolio, security, type, quantity, price) where one was written today. */
export async function checkDuplicateTransactions(targetDate = new Date()) {
  const dateStr = utils.formatDateToISO(targetDate);
  const { rows } = await query(
    `SELECT date::text, portfolio_id, security_id, transaction_type::text AS type, quantity::float, transaction_price::float AS price,
            count(*)::int AS copies, string_agg(transaction_id::text, ', ') AS ids
     FROM transactions GROUP BY date, portfolio_id, security_id, transaction_type, quantity, transaction_price
     HAVING count(*) > 1 AND max(created_at) >= $1::date ORDER BY date DESC;`,
    [dateStr],
  );
  return qcResult("checkDuplicateTransactions", dateStr, rows, {
    severity: "CRITICAL",
    ok: "No duplicate transactions written today.",
    fail: (n) =>
      `Found ${n} group(s) of identical transactions, one written today.`,
    message:
      "Identical transactions (same date, portfolio, security, type, quantity, price):",
  });
}

/** T3: transaction price vs the stored price that day (latest within 7 days), for transactions written today. */
export async function checkTransactionPrices(targetDate = new Date()) {
  const dateStr = utils.formatDateToISO(targetDate);
  const { rows } = await query(
    `SELECT t.transaction_id::text AS id, t.date::text, t.portfolio_id, t.security_id, t.transaction_type::text AS type,
            t.transaction_price::float AS tx_price, p.price::float AS stored_price, p.date::text AS price_date,
            round((abs(t.transaction_price / NULLIF(p.price, 0) - 1) * 100)::numeric, 2)::float AS gap_pct
     FROM transactions t
     JOIN security_master s ON s.security_id = t.security_id
     CROSS JOIN LATERAL (SELECT price, date FROM prices WHERE security_id = t.security_id AND date <= t.date AND date > t.date - 7
                         ORDER BY date DESC LIMIT 1) p
     WHERE t.created_at >= $1::date AND NOT ${CASH_LIKE} AND s.asset_type <> 'CRYPTO'
       AND abs(t.transaction_price / NULLIF(p.price, 0) - 1) > 0.10
     ORDER BY gap_pct DESC;`,
    [dateStr],
  );
  return qcResult("checkTransactionPrices", dateStr, rows, {
    severity: "WARNING",
    failureType: "PROBABILISTIC",
    ok: "Transactions written today are priced within 10% of the market.",
    fail: (n) =>
      `Found ${n} transaction(s) priced more than 10% away from the stored price.`,
    message:
      "Transaction price vs stored price that day (wrong decimals / units?):",
  });
}

/** T5: a portfolio's ledger holds less than 0 of a non-cash security at the end of a day (sold more than held). */
export async function checkNegativeHoldings(targetDate = new Date()) {
  const dateStr = utils.formatDateToISO(targetDate);
  const { rows } = await query(
    `WITH cur AS (
       SELECT c.currency_code, coalesce(
         (SELECT security_id FROM security_master WHERE asset_type = 'CASH' AND currency = c.currency_code LIMIT 1),
         (SELECT security_id FROM security_master WHERE asset_type = 'CRYPTO' AND currency = c.currency_code LIMIT 1),
         c.currency_code) AS security_id
       FROM currencies c
     ),
     moves AS (
       SELECT date, portfolio_id, security_id, CASE WHEN capital_flow_type::text = ANY($2) THEN -quantity ELSE quantity END AS q, created_at FROM capital_flows
       UNION ALL SELECT date, portfolio_id, security_id, CASE WHEN transaction_type = 'BUY' THEN quantity ELSE -quantity END, created_at FROM transactions
       UNION ALL SELECT t.date, t.portfolio_id, cur.security_id, CASE WHEN t.transaction_type = 'BUY' THEN -t.market_value_local ELSE t.market_value_local END, t.created_at
         FROM transactions t JOIN cur ON cur.currency_code = t.counter_currency
       UNION ALL SELECT t.date, t.portfolio_id, cur.security_id, -t.fee, t.created_at
         FROM transactions t JOIN cur ON cur.currency_code = t.fee_currency WHERE coalesce(t.fee, 0) <> 0
     ),
     touched AS (SELECT DISTINCT portfolio_id, security_id FROM moves WHERE created_at >= $1::date),
     daily AS (
       SELECT m.portfolio_id, m.security_id, m.date, sum(m.q) AS q
       FROM moves m JOIN touched USING (portfolio_id, security_id) GROUP BY 1, 2, 3
     ),
     running AS (SELECT *, sum(q) OVER (PARTITION BY portfolio_id, security_id ORDER BY date) AS held FROM daily)
     SELECT r.portfolio_id, r.security_id, min(r.date)::text AS first_negative, round(min(r.held)::numeric, 8)::float AS lowest
     FROM running r JOIN security_master s ON s.security_id = r.security_id
     WHERE r.held < -1e-6 AND NOT ${CASH_LIKE}
     GROUP BY 1, 2 ORDER BY 3;`,
    [dateStr, OUTFLOW_TYPES],
  );
  return qcResult("checkNegativeHoldings", dateStr, rows, {
    severity: "CRITICAL",
    ok: "No security sold beyond what was held (ledgers changed today).",
    fail: (n) => `Found ${n} portfolio-security ledger(s) going below zero.`,
    message:
      "Ledger holds less than 0 at the end of a day (a sale or outflow without the units to back it):",
  });
}

/** C3: flow types that don't fit their security, or non-positive quantities. */
export async function checkFlowTypes(targetDate = new Date()) {
  const dateStr = utils.formatDateToISO(targetDate);
  const { rows } = await query(
    `SELECT c.capital_flow_id::text AS id, c.date::text, c.portfolio_id, c.capital_flow_type::text AS type, c.security_id,
            s.asset_type, c.quantity::float,
            CASE WHEN c.quantity <= 0 THEN 'quantity <= 0'
                 WHEN c.capital_flow_type IN ('ASSETIN', 'ASSETOUT') THEN 'asset transfer of a cash security'
                 ELSE 'cash flow on a non-cash security' END AS problem
     FROM capital_flows c JOIN security_master s ON s.security_id = c.security_id
     WHERE c.quantity <= 0
        OR (c.capital_flow_type IN ('ASSETIN', 'ASSETOUT') AND s.asset_type IN ('CASH', 'DEBT'))
        OR (c.capital_flow_type IN ('CASHIN', 'CASHOUT', 'DIVIDEND', 'COUPON', 'INTEREST', 'INTEREST_PAID')
            AND s.asset_type NOT IN ('CASH', 'DEBT', 'CRYPTO'))
     ORDER BY c.date DESC;`,
  );
  return qcResult("checkFlowTypes", dateStr, rows, {
    severity: "WARNING",
    ok: "Every capital flow fits its security.",
    fail: (n) =>
      `Found ${n} capital flow(s) whose type doesn't fit the security.`,
    message: "Capital flows to fix (type vs security, or quantity):",
  });
}

/**
 * C4: identical capital flows where one was written today, and the same money arriving twice from two different
 * origins (email / schedule / recurring flow / an import) within 5 days, one of them written today.
 */
export async function checkDuplicateFlows(targetDate = new Date()) {
  const dateStr = utils.formatDateToISO(targetDate);
  const origin = (
    alias,
  ) => `CASE WHEN e${alias}.event_metadata ? 'email_source' THEN 'EMAIL'
      WHEN e${alias}.event_metadata ? 'scheduled_event_id' THEN 'SCHEDULE'
      WHEN e${alias}.event_metadata ? 'recurring_flow' THEN 'RECURRING'
      ELSE ${alias}.source END`;
  const { rows } = await query(
    `SELECT 'identical' AS kind, date::text, portfolio_id, capital_flow_type::text AS type, security_id, quantity::float,
            string_agg(capital_flow_id::text, ', ') AS ids, string_agg(source, ', ') AS origins
     FROM capital_flows GROUP BY date, portfolio_id, capital_flow_type, security_id, quantity
     HAVING count(*) > 1 AND max(created_at) >= $1::date
     UNION ALL
     SELECT 'two origins', b.date::text, b.portfolio_id, b.capital_flow_type::text, b.security_id, b.quantity::float,
            a.capital_flow_id || ', ' || b.capital_flow_id, ${origin("a")} || ', ' || ${origin("b")}
     FROM capital_flows a
     JOIN capital_flows b ON b.portfolio_id = a.portfolio_id AND b.capital_flow_type = a.capital_flow_type AND b.security_id = a.security_id
       AND b.quantity = a.quantity AND b.capital_flow_id > a.capital_flow_id AND abs(b.date - a.date) <= 5
     LEFT JOIN events ea ON ea.event_id = a.event_id
     LEFT JOIN events eb ON eb.event_id = b.event_id
     WHERE a.capital_flow_type IN ('CASHIN', 'CASHOUT', 'ASSETIN', 'ASSETOUT')
       AND greatest(a.created_at, b.created_at) >= $1::date AND ${origin("a")} <> ${origin("b")}
     ORDER BY 2 DESC;`,
    [dateStr],
  );
  return qcResult("checkDuplicateFlows", dateStr, rows, {
    severity: "CRITICAL",
    ok: "No duplicate capital flows written today.",
    fail: (n) => `Found ${n} possible duplicate capital flow(s).`,
    message:
      "Same flow twice (identical rows, or the same money from two origins within 5 days):",
  });
}

/** P1: every portfolio due today has a nav for today, and positions unless its nav is 0. */
export async function hasPortfoliosRunToday(targetDate = new Date()) {
  const dateStr = utils.formatDateToISO(targetDate);
  const { rows: portfolios } = await query(`SELECT * FROM portfolios;`);
  const { rows: today } = await query(
    `SELECT n.portfolio_id, n.nav::float, (SELECT count(*) FROM positions p WHERE p.portfolio_id = n.portfolio_id AND p.date = n.date)::int AS positions
     FROM nav n WHERE n.date = $1::date;`,
    [dateStr],
  );
  const ran = new Map(today.map((row) => [row.portfolio_id, row]));
  const rows = [];
  for (const portfolio of portfolios) {
    if (
      !isPortfolioActive(portfolio, dateStr) ||
      !utils.doesItRunToday(portfolio, dateStr)
    )
      continue;
    const row = ran.get(portfolio.portfolio_id);
    if (!row)
      rows.push({
        portfolio_id: portfolio.portfolio_id,
        method: portfolio.valuation_method,
        problem: "no nav today",
      });
    else if (row.positions === 0 && Math.abs(row.nav) > 0.005)
      rows.push({
        portfolio_id: portfolio.portfolio_id,
        method: portfolio.valuation_method,
        problem: `nav ${round(row.nav)} but no positions`,
      });
  }
  return qcResult("hasPortfoliosRunToday", dateStr, rows, {
    severity: "CRITICAL",
    ok: "Every portfolio due today has its nav and positions.",
    fail: (n) => `${n} portfolio(s) due today have no nav or no positions.`,
    message: "Portfolios due today (frequency) without today's valuation:",
  });
}

/** P2: today's positions: local value = quantity x price, base and EUR values = local x fx. */
export async function checkPositionValues(targetDate = new Date()) {
  const dateStr = utils.formatDateToISO(targetDate);
  await loadFxRates();
  const { rows: positions } = await query(
    `SELECT p.portfolio_id, p.security_id, p.quantity::float, p.price::float, p.market_value_local::float AS local,
            p.market_value_base::float AS base, p.market_value_eur::float AS eur, s.currency AS security_currency, f.currency AS portfolio_currency
     FROM positions p JOIN security_master s USING (security_id) JOIN portfolios f USING (portfolio_id)
     WHERE p.date = $1::date;`,
    [dateStr],
  );
  const off = (actual, expected) =>
    expected !== null &&
    Math.abs(actual - expected) > 0.01 + 0.005 * Math.abs(expected);
  const rows = [];
  for (const position of positions) {
    const local = await ledger.computeMarketValue(
      position.security_id,
      position.price,
      position.quantity,
    );
    const toBase = currencyConverter(
      position.security_currency,
      position.portfolio_currency,
      dateStr,
    );
    const toEur = currencyConverter(
      position.portfolio_currency,
      "EUR",
      dateStr,
    );
    const base = toBase === null ? null : position.local * toBase;
    const eur = toEur === null ? null : position.base * toEur;
    const problems = [
      off(position.local, local) && "local",
      off(position.base, base) && "base",
      off(position.eur, eur) && "eur",
    ].filter(Boolean);
    if (problems.length)
      rows.push({
        portfolio_id: position.portfolio_id,
        security_id: position.security_id,
        problem: problems.join(", "),
        local: round(position.local),
        expected_local: round(local),
        base: round(position.base),
        expected_base: round(base),
        eur: round(position.eur),
        expected_eur: round(eur),
      });
  }
  return qcResult("checkPositionValues", dateStr, rows, {
    severity: "CRITICAL",
    ok: "Today's position values match quantity x price x fx.",
    fail: (n) =>
      `Found ${n} position(s) whose value doesn't match quantity x price x fx.`,
    message: "Positions whose market values don't add up (0.5% tolerance):",
  });
}

/** P3: today's weights sum to 100 per portfolio (portfolios with a nav). */
export async function checkPositionWeights(targetDate = new Date()) {
  const dateStr = utils.formatDateToISO(targetDate);
  const { rows } = await query(
    `SELECT p.portfolio_id, round(sum(p.weight)::numeric, 4)::float AS weights_sum, round(max(n.nav)::numeric, 2)::float AS nav
     FROM positions p JOIN nav n ON n.portfolio_id = p.portfolio_id AND n.date = p.date
     WHERE p.date = $1::date AND abs(n.nav) > 0.005
     GROUP BY 1 HAVING abs(sum(p.weight) - 100) > 0.1 ORDER BY 1;`,
    [dateStr],
  );
  return qcResult("checkPositionWeights", dateStr, rows, {
    severity: "WARNING",
    ok: "Weights sum to 100 in every portfolio today.",
    fail: (n) => `${n} portfolio(s) with weights not summing to 100.`,
    message: "Portfolios whose weights don't sum to 100 (± 0.1):",
  });
}

/** P4: no negative quantities today, except debts and liability portfolios. */
export async function checkNegativePositions(targetDate = new Date()) {
  const dateStr = utils.formatDateToISO(targetDate);
  const { rows } = await query(
    `SELECT p.portfolio_id, p.security_id, p.quantity::float, round(p.market_value_base::numeric, 2)::float AS value
     FROM positions p JOIN security_master s USING (security_id) JOIN portfolios f USING (portfolio_id)
     WHERE p.date = $1::date AND p.quantity < -1e-9 AND s.asset_type <> 'DEBT' AND f.portfolio_type <> 'Liability'
     ORDER BY 1, 2;`,
    [dateStr],
  );
  return qcResult("checkNegativePositions", dateStr, rows, {
    severity: "CRITICAL",
    ok: "No negative positions today (debts aside).",
    fail: (n) => `Found ${n} negative position(s).`,
    message: "Negative quantities outside debts / liabilities:",
  });
}

/** P5: ROLL / CUSTOM portfolios valued today: positions = ledger holdings, security by security. */
export async function checkPositionsVsLedger(targetDate = new Date()) {
  const dateStr = utils.formatDateToISO(targetDate);
  const { rows: valued } = await query(
    `SELECT f.portfolio_id FROM portfolios f JOIN nav n ON n.portfolio_id = f.portfolio_id AND n.date = $1::date
     WHERE f.valuation_method IN ('ROLL', 'CUSTOM') AND f.portfolio_id NOT IN ('UNREALIZED_TAX', 'REALIZED_TAX') ORDER BY 1;`,
    [dateStr],
  );
  const rows = [];
  for (const { portfolio_id: portfolioId } of valued) {
    const holdings = await ledger.getLedgerHoldings(portfolioId, dateStr);
    const { rows: positions } = await query(
      `SELECT security_id, quantity::float FROM positions WHERE portfolio_id = $1 AND date = $2::date;`,
      [portfolioId, dateStr],
    );
    const held = new Map(
      positions.map((row) => [row.security_id, row.quantity]),
    );
    for (const securityId of new Set([...holdings.keys(), ...held.keys()])) {
      const ledgerQuantity = holdings.get(securityId) ?? 0;
      const positionQuantity = held.get(securityId) ?? 0;
      // 1e-4: rounding dust (PIR cash -0.000004)
      if (
        Math.abs(ledgerQuantity - positionQuantity) >
        1e-4 + 1e-6 * Math.abs(ledgerQuantity)
      )
        rows.push({
          portfolio_id: portfolioId,
          security_id: securityId,
          positions: round(positionQuantity, 6),
          ledger: round(ledgerQuantity, 6),
          gap: round(positionQuantity - ledgerQuantity, 6),
        });
    }
  }
  return qcResult("checkPositionsVsLedger", dateStr, rows, {
    severity: "CRITICAL",
    ok: `Positions match the ledger in the ${valued.length} ledger-based portfolio(s) valued today.`,
    fail: (n) => `Found ${n} position(s) that differ from the ledger.`,
    message: "Positions vs ledger holdings today (ROLL / CUSTOM):",
  });
}

/** P6: open lots = latest positions, per portfolio-security (non-cash securities, open portfolios). */
export async function checkPositionsVsLots(targetDate = new Date()) {
  const dateStr = utils.formatDateToISO(targetDate);
  const { rows } = await query(
    `WITH latest AS (
       SELECT p.portfolio_id, p.security_id, p.quantity
       FROM positions p JOIN (SELECT portfolio_id, max(date) AS d FROM positions WHERE date <= $1::date GROUP BY 1) m
         ON m.portfolio_id = p.portfolio_id AND m.d = p.date
     ),
     lots AS (SELECT portfolio_id, security_id, sum(quantity) AS quantity FROM open_lots GROUP BY 1, 2)
     SELECT coalesce(l.portfolio_id, o.portfolio_id) AS portfolio_id, coalesce(l.security_id, o.security_id) AS security_id,
            round(coalesce(l.quantity, 0)::numeric, 6)::float AS positions, round(coalesce(o.quantity, 0)::numeric, 6)::float AS open_lots
     FROM latest l FULL JOIN lots o ON o.portfolio_id = l.portfolio_id AND o.security_id = l.security_id
     JOIN security_master s ON s.security_id = coalesce(l.security_id, o.security_id)
     JOIN portfolios f ON f.portfolio_id = coalesce(l.portfolio_id, o.portfolio_id)
     WHERE NOT ${CASH_LIKE} AND (f.closed_date IS NULL OR f.closed_date >= $1::date)
       AND abs(coalesce(l.quantity, 0) - coalesce(o.quantity, 0)) > 1e-6 + 1e-6 * abs(coalesce(l.quantity, 0))
     ORDER BY 1, 2;`,
    [dateStr],
  );
  return qcResult("checkPositionsVsLots", dateStr, rows, {
    severity: "CRITICAL",
    ok: "Open lots match the positions everywhere.",
    fail: (n) => `Found ${n} position(s) that differ from the open lots.`,
    message:
      "Positions vs open lots (a ledger row the lots read differently, a duplicate, or dust):",
  });
}

/** P7: held securities with a price feed: latest price not older than their frequency allows (PRICE_MAX_AGE_DAYS). */
export async function checkStalePositionPrices(targetDate = new Date()) {
  const dateStr = utils.formatDateToISO(targetDate);
  const { rows: held } = await query(
    `SELECT s.security_id, s.valuation_frequency, s.source, (SELECT max(date) FROM prices WHERE security_id = s.security_id AND date <= $1::date)::text AS last_price,
            string_agg(DISTINCT p.portfolio_id, ', ') AS portfolios
     FROM positions p JOIN security_master s USING (security_id)
     WHERE p.date = $1::date AND s.source IS NOT NULL AND s.asset_type NOT IN ('CASH', 'DEBT', 'CRYPTO')
     GROUP BY 1, 2, 3;`,
    [dateStr],
  );
  const rows = [];
  for (const security of held) {
    const maxAge =
      PRICE_MAX_AGE_DAYS[security.valuation_frequency] ??
      PRICE_MAX_AGE_DAYS.MTH;
    const age = security.last_price
      ? utils.daysBetween(security.last_price, dateStr).length - 1
      : null;
    if (age === null || age > maxAge)
      rows.push({
        security_id: security.security_id,
        source: security.source,
        last_price: security.last_price,
        age_days: age,
        max_days: maxAge,
        portfolios: security.portfolios,
      });
  }
  return qcResult("checkStalePositionPrices", dateStr, rows, {
    severity: "WARNING",
    ok: "Every held security with a price feed has a recent price.",
    fail: (n) => `Found ${n} held security(ies) with an old price.`,
    message:
      "Held securities whose latest price is older than allowed (DLY / BIZ 7 days, WKL 14, MTH 45):",
  });
}

/** N1: the last 30 days: every active portfolio has a nav on each day its frequency says it runs. */
export async function isNavContinuous(targetDate = new Date()) {
  const dateStr = utils.formatDateToISO(targetDate);
  const from = utils.addDays(dateStr, -30);
  const { rows: portfolios } = await query(`SELECT * FROM portfolios;`);
  const { rows: navs } = await query(
    `SELECT portfolio_id, date::text FROM nav WHERE date BETWEEN $1::date AND $2::date;`,
    [from, dateStr],
  );
  const have = new Set(navs.map((row) => `${row.portfolio_id}|${row.date}`));
  const rows = [];
  for (const portfolio of portfolios) {
    const missing = utils
      .daysBetween(from, dateStr)
      .filter(
        (date) =>
          isPortfolioActive(portfolio, date) &&
          utils.doesItRunToday(portfolio, date) &&
          !have.has(`${portfolio.portfolio_id}|${date}`),
      );
    if (missing.length)
      rows.push({
        portfolio_id: portfolio.portfolio_id,
        frequency: portfolio.valuation_frequency,
        missing_days: missing.length,
        first_missing: missing[0],
        last_missing: missing.at(-1),
      });
  }
  return qcResult("isNavContinuous", dateStr, rows, {
    severity: "CRITICAL",
    ok: `Every portfolio has a nav on each scheduled day since ${from}.`,
    fail: (n) => `${n} portfolio(s) miss scheduled navs in the last 30 days.`,
    message: "Scheduled valuation days without a nav (last 30 days):",
  });
}

/** N2: nav = Σ positions (base), for the navs written today. */
export async function checkNavVsPositions(targetDate = new Date()) {
  const dateStr = utils.formatDateToISO(targetDate);
  const { rows } = await query(
    `SELECT n.portfolio_id, n.date::text, round(n.nav::numeric, 2)::float AS nav, round(coalesce(sum(p.market_value_base), 0)::numeric, 2)::float AS positions_sum
     FROM nav n LEFT JOIN positions p ON p.portfolio_id = n.portfolio_id AND p.date = n.date
     WHERE n.created_at >= $1::date
     GROUP BY n.portfolio_id, n.date, n.nav
     HAVING abs(n.nav - coalesce(sum(p.market_value_base), 0)) > 0.01 + 1e-6 * abs(n.nav)
     ORDER BY 2 DESC, 1;`,
    [dateStr],
  );
  return qcResult("checkNavVsPositions", dateStr, rows, {
    severity: "CRITICAL",
    ok: "Every nav written today equals the sum of its positions.",
    fail: (n) =>
      `Found ${n} nav(s) that differ from the sum of their positions.`,
    message: "Nav vs Σ positions (base currency):",
  });
}

/**
 * N3: unexplained nav moves in the last 7 days, ROLL / CUSTOM portfolios (their money in / out is in the ledger):
 * (nav - previous nav - net external flows) / previous nav, beyond 3σ of the portfolio's previous 90 moves (jumpLimit).
 */
export async function checkNavJumps(targetDate = new Date()) {
  const dateStr = utils.formatDateToISO(targetDate);
  const { rows: series } = await query(
    `WITH series AS (
       SELECT n.portfolio_id, n.date, n.nav, LAG(n.nav) OVER w AS prev_nav, LAG(n.date) OVER w AS prev_date
       FROM nav n JOIN portfolios f USING (portfolio_id)
       WHERE f.valuation_method IN ('ROLL', 'CUSTOM') AND f.portfolio_id NOT IN ('UNREALIZED_TAX', 'REALIZED_TAX')
       WINDOW w AS (PARTITION BY n.portfolio_id ORDER BY n.date)
     )
     SELECT s.portfolio_id, f.portfolio_type, s.date::text, s.prev_date::text, s.nav::float, s.prev_nav::float,
            coalesce((SELECT sum(CASE WHEN c.capital_flow_type::text = ANY($2) THEN c.market_value_base ELSE -c.market_value_base END)
                      FROM capital_flows c WHERE c.portfolio_id = s.portfolio_id AND c.date > s.prev_date AND c.date <= s.date
                        AND c.capital_flow_type::text = ANY($2 || $3)), 0)::float AS net_flows
     FROM series s JOIN portfolios f USING (portfolio_id)
     WHERE s.date > $1::date - $5::int - 7 AND s.date <= $1::date AND abs(s.prev_nav) >= $4
     ORDER BY s.portfolio_id, s.date;`,
    [
      dateStr,
      EXTERNAL_IN,
      EXTERNAL_OUT,
      MIN_VALUE_CHECKED,
      Math.ceil(JUMP_LOOKBACK * 1.5),
    ],
  );
  const recentFrom = utils.addDays(dateStr, -6);
  const byPortfolio = new Map();
  for (const move of series)
    (
      byPortfolio.get(move.portfolio_id) ??
      byPortfolio.set(move.portfolio_id, []).get(move.portfolio_id)
    ).push(move);
  const rows = [];
  for (const moves of byPortfolio.values()) {
    const pcts = moves.map(
      (move) =>
        ((move.nav - move.prev_nav - move.net_flows) /
          Math.abs(move.prev_nav)) *
        100,
    );
    moves.forEach((move, index) => {
      if (move.date < recentFrom) return;
      const { limit, sigma } = jumpLimit(pcts.slice(0, index));
      if (Math.abs(pcts[index]) > limit)
        rows.push({
          portfolio_id: move.portfolio_id,
          date: move.date,
          prev_nav: round(move.prev_nav),
          nav: round(move.nav),
          net_flows: round(move.net_flows),
          unexplained: round(move.nav - move.prev_nav - move.net_flows),
          unexplained_pct: round(pcts[index]),
          sigma_pct: round(sigma),
          limit_pct: round(limit),
        });
    });
  }
  return qcResult("checkNavJumps", dateStr, rows, {
    severity: "WARNING",
    failureType: "PROBABILISTIC",
    ok: "No unexplained nav moves in the last 7 days.",
    fail: (n) => `Found ${n} nav move(s) not explained by money in / out.`,
    message:
      "Day-on-day nav moves beyond the limit after removing money in / out (a missing flow?):",
  });
}

/** A1: every aggregate with a nav in the 7 days before has one today. */
export async function hasAggregatesRunToday(targetDate = new Date()) {
  const dateStr = utils.formatDateToISO(targetDate);
  const { rows } = await query(
    `SELECT a.aggregate_id, max(a.date)::text AS last_nav
     FROM aggregate_nav a WHERE a.date >= $1::date - 7 AND a.date < $1::date
       AND NOT EXISTS (SELECT 1 FROM aggregate_nav t WHERE t.aggregate_id = a.aggregate_id AND t.date = $1::date)
     GROUP BY 1 ORDER BY 1;`,
    [dateStr],
  );
  return qcResult("hasAggregatesRunToday", dateStr, rows, {
    severity: "CRITICAL",
    ok: "Every aggregate has today's nav.",
    fail: (n) => `${n} aggregate(s) without today's nav.`,
    message: "Aggregates that ran this week but not today:",
  });
}

/**
 * A2: today, each aggregate (EUR) = Σ its direct children: child aggregates' nav_eur + child portfolios' latest nav on
 * or before today x the user's share (ownership_overrides) x fx to EUR. 0.1% tolerance.
 */
export async function checkAggregateSums(targetDate = new Date()) {
  const dateStr = utils.formatDateToISO(targetDate);
  await loadFxRates();
  const { rows: aggregates } = await query(
    `SELECT aggregate_id, nav_eur::float FROM aggregate_nav WHERE date = $1::date;`,
    [dateStr],
  );
  const navEur = new Map(
    aggregates.map((row) => [row.aggregate_id, row.nav_eur]),
  );
  const { rows: tree } = await query(
    `SELECT parent_id, child_id, child_type FROM aggregate_tree;`,
  );
  const { rows: portfolios } = await query(
    `SELECT f.portfolio_id, f.currency, f.inception_date::text AS inception, f.closed_date::text AS closed,
            (SELECT nav::float FROM nav WHERE portfolio_id = f.portfolio_id AND date <= $1::date ORDER BY date DESC LIMIT 1) AS nav,
            coalesce((SELECT my_share::float FROM ownership_overrides o WHERE o.portfolio_id = f.portfolio_id AND o.start_date <= $1::date ORDER BY start_date DESC LIMIT 1), 100) AS share
     FROM portfolios f;`,
    [dateStr],
  );
  const byId = new Map(portfolios.map((row) => [row.portfolio_id, row]));
  const childValue = (link) => {
    if (link.child_type === "AGGREGATE") return navEur.get(link.child_id) ?? 0;
    const portfolio = byId.get(link.child_id);
    if (
      !portfolio ||
      portfolio.nav === null ||
      dateStr < portfolio.inception ||
      (portfolio.closed && dateStr > portfolio.closed)
    )
      return 0;
    return (
      portfolio.nav *
      (portfolio.share / 100) *
      (currencyConverter(portfolio.currency, "EUR", dateStr) ?? NaN)
    );
  };
  const rows = [];
  for (const [aggregateId, value] of navEur) {
    const expected = tree
      .filter((link) => link.parent_id === aggregateId)
      .reduce((sum, link) => sum + childValue(link), 0);
    if (!(Math.abs(value - expected) <= 0.01 + 0.001 * Math.abs(expected)))
      rows.push({
        aggregate_id: aggregateId,
        nav_eur: round(value),
        children_sum_eur: round(expected),
        gap: round(value - expected),
      });
  }
  return qcResult("checkAggregateSums", dateStr, rows, {
    severity: "CRITICAL",
    ok: "Every aggregate equals the sum of its children today.",
    fail: (n) =>
      `Found ${n} aggregate(s) that differ from the sum of their children.`,
    message: "Aggregate nav (EUR) vs Σ children (share x fx):",
  });
}

/**
 * A3: today's aggregate move after removing the money in / out of its portfolios (transfers between two of them cancel
 * out), beyond 3σ of the aggregate's previous 90 daily moves (jumpLimit).
 */
export async function checkAggregateJumps(targetDate = new Date()) {
  const dateStr = utils.formatDateToISO(targetDate);
  const { rows: series } = await query(
    `WITH RECURSIVE members AS (
       SELECT parent_id AS aggregate_id, child_id, child_type FROM aggregate_tree
       UNION SELECT m.aggregate_id, t.child_id, t.child_type FROM members m JOIN aggregate_tree t ON t.parent_id = m.child_id AND m.child_type = 'AGGREGATE'
     ),
     flows AS (
       SELECT m.aggregate_id, c.date, sum(CASE WHEN c.capital_flow_type::text = ANY($2) THEN c.market_value_eur ELSE -c.market_value_eur END) AS net
       FROM capital_flows c JOIN members m ON m.child_type = 'PORTFOLIO' AND m.child_id = c.portfolio_id
       WHERE c.date > $1::date - $5::int AND c.date <= $1::date AND c.capital_flow_type::text = ANY($2 || $3)
       GROUP BY 1, 2
     ),
     days AS (
       SELECT a.aggregate_id, a.date, a.nav_eur, LAG(a.nav_eur) OVER (PARTITION BY a.aggregate_id ORDER BY a.date) AS prev_nav_eur
       FROM aggregate_nav a WHERE a.date > $1::date - $5::int - 1 AND a.date <= $1::date
     )
     SELECT d.aggregate_id, d.date::text, d.nav_eur::float, d.prev_nav_eur::float, coalesce(f.net, 0)::float AS net_flows_eur
     FROM days d LEFT JOIN flows f ON f.aggregate_id = d.aggregate_id AND f.date = d.date
     WHERE d.prev_nav_eur IS NOT NULL AND abs(d.prev_nav_eur) >= $4
     ORDER BY d.aggregate_id, d.date;`,
    [dateStr, EXTERNAL_IN, EXTERNAL_OUT, MIN_VALUE_CHECKED, JUMP_LOOKBACK],
  );
  const byAggregate = new Map();
  for (const day of series)
    (
      byAggregate.get(day.aggregate_id) ??
      byAggregate.set(day.aggregate_id, []).get(day.aggregate_id)
    ).push(day);
  const rows = [];
  for (const days of byAggregate.values()) {
    const today = days.at(-1);
    if (today.date !== dateStr) continue;
    const pcts = days.map(
      (day) =>
        ((day.nav_eur - day.prev_nav_eur - day.net_flows_eur) /
          Math.abs(day.prev_nav_eur)) *
        100,
    );
    const { limit, sigma } = jumpLimit(pcts.slice(0, -1));
    if (Math.abs(pcts.at(-1)) > limit)
      rows.push({
        aggregate_id: today.aggregate_id,
        prev_nav_eur: round(today.prev_nav_eur),
        nav_eur: round(today.nav_eur),
        net_flows_eur: round(today.net_flows_eur),
        unexplained_pct: round(pcts.at(-1)),
        sigma_pct: round(sigma),
        limit_pct: round(limit),
      });
  }
  return qcResult("checkAggregateJumps", dateStr, rows, {
    severity: "WARNING",
    failureType: "PROBABILISTIC",
    ok: "No unexplained aggregate moves today.",
    fail: (n) => `Found ${n} aggregate(s) moving beyond the limit today.`,
    message: "Aggregate day-on-day moves after removing money in / out:",
  });
}

/** A4: every aggregate has a nav on every day from its first one to today. */
export async function isAggregateNavContinuous(targetDate = new Date()) {
  const dateStr = utils.formatDateToISO(targetDate);
  const { rows } = await query(
    `SELECT a.aggregate_id, count(*)::int AS missing_days, min(d)::date::text AS first_missing, max(d)::date::text AS last_missing
     FROM (SELECT aggregate_id, min(date) AS first FROM aggregate_nav GROUP BY 1) a
     CROSS JOIN LATERAL generate_series(a.first, $1::date, '1 day'::interval) d
     WHERE NOT EXISTS (SELECT 1 FROM aggregate_nav x WHERE x.aggregate_id = a.aggregate_id AND x.date = d::date)
     GROUP BY 1 ORDER BY 1;`,
    [dateStr],
  );
  return qcResult("isAggregateNavContinuous", dateStr, rows, {
    severity: "WARNING",
    ok: "Every aggregate has a nav on every day since its first.",
    fail: (n) => `${n} aggregate(s) with missing days.`,
    message: "Aggregates with gaps in their daily nav:",
  });
}

/** A5: every active portfolio sits under TOTAL in the aggregate tree. */
export async function checkPortfoliosInTree(targetDate = new Date()) {
  const dateStr = utils.formatDateToISO(targetDate);
  const { rows } = await query(
    `WITH RECURSIVE under_total AS (
       SELECT child_id, child_type FROM aggregate_tree WHERE parent_id = 'TOTAL'
       UNION SELECT t.child_id, t.child_type FROM aggregate_tree t JOIN under_total u ON t.parent_id = u.child_id AND u.child_type = 'AGGREGATE'
     )
     SELECT f.portfolio_id, f.portfolio_type, f.inception_date::text AS inception
     FROM portfolios f
     WHERE (f.closed_date IS NULL OR f.closed_date >= $1::date) AND f.inception_date <= $1::date
       AND f.portfolio_id NOT IN (SELECT child_id FROM under_total WHERE child_type = 'PORTFOLIO')
     ORDER BY 1;`,
    [dateStr],
  );
  return qcResult("checkPortfoliosInTree", dateStr, rows, {
    severity: "CRITICAL",
    ok: "Every active portfolio is counted under TOTAL.",
    fail: (n) => `${n} active portfolio(s) missing from the aggregate tree.`,
    message:
      "Active portfolios that no aggregate counts (add them to aggregate_tree):",
  });
}

// ============================================================================
// PERFORMANCE (user, 2026-10-29)
// ============================================================================
// Residual: what positions / navs don't explain, in % of the brick (WARNING above, CRITICAL above the second);
// portfolios below MIN_VALUE_CHECKED_PERF at the brick start are skipped (IBKR's last 5 EUR)
const RESIDUAL_WARN_PCT = 0.5;
const RESIDUAL_FAIL_PCT = 2;
const MIN_VALUE_CHECKED_PERF = 100;
// Daily return jumps: 3σ of the series' last 90 bricks like the nav jumps, never below these floors
const PERF_JUMP_MIN_PCT = { portfolio: 5, aggregate: 2 };
// A trade booked far from the close (wrong price / quantity) shows as trade return
const TRADE_SPIKE_PCT = 2;

/** PF1: portfolio / aggregate bricks written today whose residual is beyond RESIDUAL_WARN_PCT. */
export async function checkPerformanceResiduals(targetDate = new Date()) {
  const dateStr = utils.formatDateToISO(targetDate);
  const { rows } = await query(
    `SELECT 'portfolio' AS level, b.portfolio_id AS id, b.start_date::text, b.end_date::text, round(b.total_return::numeric, 3)::float AS total_pct,
            round(b.residual::numeric, 3)::float AS residual_pct, round(n.nav::numeric, 2)::float AS start_nav
     FROM portfolio_performance b JOIN nav n ON n.portfolio_id = b.portfolio_id AND n.date = b.start_date
     WHERE b.created_at >= $1::date AND abs(b.residual) > $2 AND abs(n.nav) >= $3
     UNION ALL
     SELECT 'aggregate', a.aggregate_id, a.start_date::text, a.end_date::text, round(a.total_return::numeric, 3)::float, round(a.residual::numeric, 3)::float, NULL
     FROM aggregate_performance a WHERE a.created_at >= $1::date AND abs(a.residual) > $2
     ORDER BY 6 DESC LIMIT 200;`,
    [dateStr, RESIDUAL_WARN_PCT, MIN_VALUE_CHECKED_PERF],
  );
  return qcResult("checkPerformanceResiduals", dateStr, rows, {
    severity: rows.some((row) => Math.abs(row.residual_pct) > RESIDUAL_FAIL_PCT)
      ? "CRITICAL"
      : "WARNING",
    ok: `No performance residual above ${RESIDUAL_WARN_PCT}%.`,
    fail: (n) =>
      `${n} performance brick(s) with a residual above ${RESIDUAL_WARN_PCT}%.`,
    message: `Returns the positions / navs don't explain (positions vs ledger, nav vs positions); above ${RESIDUAL_FAIL_PCT}% is critical:`,
  });
}

/** PF2: every nav of a performance portfolio after its first one ends a performance brick. */
export async function checkPerformanceCoverage(targetDate = new Date()) {
  const dateStr = utils.formatDateToISO(targetDate);
  const { rows } = await query(
    `SELECT n.portfolio_id, count(*)::int AS navs_without_brick, min(n.date)::text AS first, max(n.date)::text AS last
     FROM nav n JOIN portfolios p USING (portfolio_id)
     WHERE p.performance AND n.date <= $1::date AND n.date > (SELECT min(date) FROM nav f WHERE f.portfolio_id = n.portfolio_id)
       AND NOT EXISTS (SELECT 1 FROM portfolio_performance b WHERE b.portfolio_id = n.portfolio_id AND b.end_date = n.date)
     GROUP BY 1 ORDER BY 1;`,
    [dateStr],
  );
  return qcResult("checkPerformanceCoverage", dateStr, rows, {
    severity: "CRITICAL",
    ok: "Every nav of the performance portfolios has its performance brick.",
    fail: (n) => `${n} performance portfolio(s) with navs and no performance.`,
    message:
      "Navs with no performance brick (the aggregates would count these days as 0%):",
  });
}

/**
 * PF3: daily returns in the last 7 days beyond 3σ of the same series' previous 90 bricks (portfolio / aggregate),
 * floors PERF_JUMP_MIN_PCT; portfolios below MIN_VALUE_CHECKED at the brick start are skipped.
 */
export async function checkPerformanceJumps(targetDate = new Date()) {
  const dateStr = utils.formatDateToISO(targetDate);
  const lookbackDays = Math.ceil(JUMP_LOOKBACK * 1.5) + 7;
  const { rows: bricks } = await query(
    `SELECT 'portfolio' AS level, b.portfolio_id AS id, b.end_date::text, b.total_return::float AS pct, n.nav::float AS start_nav
     FROM portfolio_performance b JOIN nav n ON n.portfolio_id = b.portfolio_id AND n.date = b.start_date
     WHERE b.end_date > $1::date - $2::int AND b.end_date <= $1::date
     UNION ALL
     SELECT 'aggregate', aggregate_id, end_date::text, total_return::float, NULL FROM aggregate_performance
     WHERE end_date > $1::date - $2::int AND end_date <= $1::date
     ORDER BY 1, 2, 3;`,
    [dateStr, lookbackDays],
  );
  const recentFrom = utils.addDays(dateStr, -6);
  const bySeries = new Map();
  for (const brick of bricks)
    (
      bySeries.get(`${brick.level}|${brick.id}`) ??
      bySeries
        .set(`${brick.level}|${brick.id}`, [])
        .get(`${brick.level}|${brick.id}`)
    ).push(brick);
  const rows = [];
  for (const series of bySeries.values()) {
    const pcts = series.map((brick) => brick.pct);
    series.forEach((brick, index) => {
      if (
        brick.end_date < recentFrom ||
        (brick.level === "portfolio" &&
          Math.abs(brick.start_nav) < MIN_VALUE_CHECKED)
      )
        return;
      const { limit, sigma } = jumpLimit(
        pcts.slice(0, index),
        PERF_JUMP_MIN_PCT[brick.level],
      );
      if (Math.abs(brick.pct) > limit)
        rows.push({
          level: brick.level,
          id: brick.id,
          end_date: brick.end_date,
          return_pct: round(brick.pct),
          sigma_pct: round(sigma),
          limit_pct: round(limit),
        });
    });
  }
  return qcResult("checkPerformanceJumps", dateStr, rows, {
    severity: "WARNING",
    failureType: "PROBABILISTIC",
    ok: "No unusual daily return in the last 7 days.",
    fail: (n) => `Found ${n} unusual daily return(s).`,
    message:
      "Returns beyond 3σ of their last 90 days (a wrong price or fx rate? money in / out is already removed):",
  });
}

/** PF4: portfolio bricks written today with a trade return beyond TRADE_SPIKE_PCT (a trade far from the close). */
export async function checkTradeSpikes(targetDate = new Date()) {
  const dateStr = utils.formatDateToISO(targetDate);
  const { rows } = await query(
    `SELECT portfolio_id, start_date::text, end_date::text, round(trade_return::numeric, 3)::float AS trade_pct, round(total_return::numeric, 3)::float AS total_pct
     FROM portfolio_performance WHERE created_at >= $1::date AND abs(trade_return) > $2 ORDER BY abs(trade_return) DESC;`,
    [dateStr, TRADE_SPIKE_PCT],
  );
  return qcResult("checkTradeSpikes", dateStr, rows, {
    severity: "WARNING",
    ok: `No trade return above ${TRADE_SPIKE_PCT}%.`,
    fail: (n) => `${n} brick(s) with a trade return above ${TRADE_SPIKE_PCT}%.`,
    message:
      "Trades booked far from the closing price (a wrong price or quantity in the ledger?):",
  });
}

/**
 * PF5: performance ran: every performance portfolio's last brick ends on its last nav, and every aggregate with a
 * brick in the 7 days before has one ending today.
 */
export async function hasPerformanceRunToday(targetDate = new Date()) {
  const dateStr = utils.formatDateToISO(targetDate);
  const { rows } = await query(
    `SELECT 'portfolio' AS level, p.portfolio_id AS id, (SELECT max(date) FROM nav n WHERE n.portfolio_id = p.portfolio_id AND n.date <= $1::date)::text AS last_nav,
            (SELECT max(end_date) FROM portfolio_performance b WHERE b.portfolio_id = p.portfolio_id)::text AS last_brick
     FROM portfolios p WHERE p.performance
       AND (SELECT max(date) FROM nav n WHERE n.portfolio_id = p.portfolio_id AND n.date <= $1::date) > (SELECT min(date) FROM nav n WHERE n.portfolio_id = p.portfolio_id)
       AND coalesce((SELECT max(end_date) FROM portfolio_performance b WHERE b.portfolio_id = p.portfolio_id), '1900-01-01')
           < (SELECT max(date) FROM nav n WHERE n.portfolio_id = p.portfolio_id AND n.date <= $1::date)
     UNION ALL
     SELECT 'aggregate', a.aggregate_id, NULL, max(a.end_date)::text FROM aggregate_performance a
     WHERE a.end_date >= $1::date - 7 AND a.end_date < $1::date
       AND NOT EXISTS (SELECT 1 FROM aggregate_performance t WHERE t.aggregate_id = a.aggregate_id AND t.end_date = $1::date)
     GROUP BY a.aggregate_id ORDER BY 1, 2;`,
    [dateStr],
  );
  return qcResult("hasPerformanceRunToday", dateStr, rows, {
    severity: "CRITICAL",
    ok: "Performance is up to date for every portfolio and aggregate.",
    fail: (n) =>
      `${n} portfolio(s) / aggregate(s) with performance behind their navs.`,
    message:
      "Performance not computed up to the latest nav (did the performance step fail?):",
  });
}

// ============================================================================
// PRICES & RISK (user, 2026-10-30)
// ============================================================================
// Price moves: 3σ of the security's last 90 moves like the fx / nav jumps, never below 2% (money market / bond funds
// hit 20-30σ on 0.5% moves); only prices written today of securities held
const PRICE_JUMP_SIGMAS = 3;
const PRICE_JUMP_LOOKBACK = 90;
const PRICE_JUMP_MIN_PCT = 2;
// Risk computed on less than this share of a portfolio / aggregate (holdings without a usable series) is understated
const RISK_MIN_COVERAGE_PCT = 90;

/** SP1: prices written today, of securities held today, moving beyond 3σ of their last 90 moves (and 2%). */
export async function checkPriceJumps(targetDate = new Date()) {
  const dateStr = utils.formatDateToISO(targetDate);
  const { rows } = await query(
    `WITH held AS (
       SELECT DISTINCT p.security_id FROM positions p
       JOIN (SELECT portfolio_id, max(date) AS d FROM nav WHERE date <= $1::date GROUP BY 1) m ON m.portfolio_id = p.portfolio_id AND m.d = p.date
       JOIN portfolios f ON f.portfolio_id = p.portfolio_id WHERE f.closed_date IS NULL AND abs(p.quantity) > 1e-5
     ),
     moves AS (
       SELECT x.security_id, x.date, x.created_at, x.price, LAG(x.price) OVER w AS prev_price,
              x.price / NULLIF(LAG(x.price) OVER w, 0) - 1 AS move
       FROM prices x JOIN held USING (security_id)
       WHERE x.date > $1::date - $2::int * 2 AND x.date <= $1::date
       WINDOW w AS (PARTITION BY x.security_id ORDER BY x.date)
     ),
     scored AS (
       SELECT *, stddev_pop(move) OVER (PARTITION BY security_id ORDER BY date ROWS BETWEEN $2::int PRECEDING AND 1 PRECEDING) AS sigma FROM moves
     )
     SELECT security_id, date::text, round(prev_price::numeric, 4)::float AS prev_price, round(price::numeric, 4)::float AS price,
            round((move * 100)::numeric, 2)::float AS move_pct, round((sigma * 100)::numeric, 3)::float AS sigma_pct,
            round((greatest(sigma * $3, $4 / 100.0) * 100)::numeric, 2)::float AS limit_pct
     FROM scored WHERE created_at >= $1::date AND move IS NOT NULL AND sigma IS NOT NULL
       AND abs(move) > greatest(sigma * $3, $4 / 100.0)
     ORDER BY abs(move) DESC;`,
    [dateStr, PRICE_JUMP_LOOKBACK, PRICE_JUMP_SIGMAS, PRICE_JUMP_MIN_PCT],
  );
  return qcResult("checkPriceJumps", dateStr, rows, {
    severity: "WARNING",
    failureType: "PROBABILISTIC",
    ok: "No unusual price move today.",
    fail: (n) => `Found ${n} unusual price move(s).`,
    message: `Prices written today moving beyond ${PRICE_JUMP_SIGMAS}σ of their last ${PRICE_JUMP_LOOKBACK} moves and ${PRICE_JUMP_MIN_PCT}% (a bad tick?):`,
  });
}

/** R1: risk ran: snapshots today for the securities held, the active performance portfolios and the aggregates with a nav. */
export async function hasRiskRunToday(targetDate = new Date()) {
  const dateStr = utils.formatDateToISO(targetDate);
  const { rows } = await query(
    `SELECT 'security' AS level, count(*)::int AS snapshots FROM (SELECT DISTINCT security_id FROM security_risk WHERE date = $1::date) s
     UNION ALL SELECT 'portfolio', count(DISTINCT portfolio_id)::int FROM portfolio_risk WHERE date = $1::date
     UNION ALL SELECT 'aggregate', count(DISTINCT aggregate_id)::int FROM aggregate_risk WHERE date = $1::date;`,
    [dateStr],
  );
  const missing = rows.filter((row) => row.snapshots === 0);
  return qcResult("hasRiskRunToday", dateStr, missing, {
    severity: "CRITICAL",
    ok: `Risk snapshots written today (${rows.map((row) => `${row.snapshots} ${row.level}`).join(", ")}).`,
    fail: (n) => `No risk snapshot today for ${n} level(s).`,
    message: "Risk levels without today's snapshot (did the risk step fail?):",
  });
}

/**
 * R2: no usable risk: a security held today without today's snapshot (a price hole longer than 3 sessions and no risk
 * proxy; real assets without a proxy are skipped by design), or with a 1Y volatility of exactly 0 (prices that never
 * move: a stale or flat feed).
 */
export async function checkRiskGaps(targetDate = new Date()) {
  const dateStr = utils.formatDateToISO(targetDate);
  const { rows } = await query(
    `WITH held AS (
       SELECT DISTINCT p.security_id FROM positions p
       JOIN (SELECT portfolio_id, max(date) AS d FROM nav WHERE date <= $1::date GROUP BY 1) m ON m.portfolio_id = p.portfolio_id AND m.d = p.date
       JOIN portfolios f ON f.portfolio_id = p.portfolio_id
       WHERE f.closed_date IS NULL AND abs(p.quantity) > 1e-5
     )
     SELECT h.security_id, s.asset_type, 'no risk snapshot (price hole, no proxy?)' AS problem FROM held h JOIN security_master s USING (security_id)
     WHERE NOT (s.asset_type IN ('REAL_ASSET', 'REAL_ESTATE') AND s.risk_proxy IS NULL)
       AND NOT EXISTS (SELECT 1 FROM security_risk r WHERE r.security_id = h.security_id AND r.date = $1::date)
     UNION ALL
     SELECT r.security_id, s.asset_type, '1Y volatility 0 (stale / flat prices?)' FROM security_risk r JOIN security_master s USING (security_id)
     JOIN held h ON h.security_id = r.security_id
     WHERE r.date = $1::date AND r.metric = 'VOLATILITY_1Y' AND r.value = 0 AND s.asset_type NOT IN ('CASH', 'DEBT')
     ORDER BY 1;`,
    [dateStr],
  );
  return qcResult("checkRiskGaps", dateStr, rows, {
    severity: "WARNING",
    ok: "Every security held has a usable risk series.",
    fail: (n) => `${n} security(ies) held without usable risk.`,
    message:
      "Held securities without risk (they count as 0 risk in the portfolios and aggregates):",
  });
}

/** R5: portfolio / aggregate risk computed on less than RISK_MIN_COVERAGE_PCT of its value (holdings without a series). */
export async function checkRiskCoverage(targetDate = new Date()) {
  const dateStr = utils.formatDateToISO(targetDate);
  const { rows } = await query(
    `SELECT 'portfolio' AS level, portfolio_id AS id, value::float AS coverage_pct FROM portfolio_risk WHERE date = $1::date AND metric = 'COVERAGE_PCT' AND value < $2
     UNION ALL
     SELECT 'aggregate', aggregate_id, value::float FROM aggregate_risk WHERE date = $1::date AND metric = 'COVERAGE_PCT' AND value < $2
     ORDER BY 3;`,
    [dateStr, RISK_MIN_COVERAGE_PCT],
  );
  return qcResult("checkRiskCoverage", dateStr, rows, {
    severity: "WARNING",
    ok: `Every portfolio / aggregate risk covers at least ${RISK_MIN_COVERAGE_PCT}% of its value.`,
    fail: (n) =>
      `${n} portfolio(s) / aggregate(s) with risk on less than ${RISK_MIN_COVERAGE_PCT}% of their value.`,
    message:
      "Risk computed on part of the holdings only (the rest has no price history / proxy): the numbers are understated:",
  });
}

/**
 * T6: from November, last year's declared tax (DICHIARATIVO capital gains + IVAFE, in tax_items) has a tax_payments row
 * (TAX_PAID event), else REALIZED_TAX keeps it as owed: was the payment not recorded?
 */
export async function checkTaxPaid(targetDate = new Date()) {
  const dateStr = utils.formatDateToISO(targetDate);
  const year = Number(dateStr.slice(0, 4)) - 1;
  const { rows } =
    Number(dateStr.slice(5, 7)) < 11
      ? { rows: [] }
      : await query(
          `SELECT t.tax_year, round(sum(t.value_eur)::numeric, 2)::float AS owed_eur
     FROM tax_items t JOIN portfolios p USING (portfolio_id)
     WHERE t.tax_year = $1 AND ((t.item = 'TAX_EST' AND p.fiscal_regime LIKE 'DICHIARATIVO%') OR (t.item = 'IVAFE_EST' AND p.ivafe_taxable))
       AND NOT EXISTS (SELECT 1 FROM tax_payments x WHERE x.tax_year = t.tax_year)
     GROUP BY 1 HAVING sum(t.value_eur) > 0;`,
          [year],
        );
  return qcResult("checkTaxPaid", dateStr, rows, {
    severity: "WARNING",
    ok: "Last year's declared tax is marked as paid (or nothing is owed).",
    fail: () => `Tax year ${year} is not marked as paid.`,
    message:
      "Declared tax still owed in REALIZED_TAX: add a TAX_PAID event when it is paid:",
  });
}

// ============================================================================
// BREAKDOWNS (user, 2026-10-30)
// ============================================================================
const BREAKDOWN_TABLES = [
  ["security", "security_breakdowns", "security_id"],
  ["portfolio", "portfolio_breakdowns", "portfolio_id"],
  ["aggregate", "aggregate_breakdowns", "aggregate_id"],
];
const SECURITY_BREAKDOWNS = [
  "ASSET_TYPE",
  "CURRENCY",
  "ASSET_CLASS",
  "REGION",
  "ASSET_CLASSIFICATION",
  "ITALY_EXPOSURE",
];
const LOOKTHROUGH_BREAKDOWNS = [
  "CURRENCY_LT",
  "ASSET_CLASS_LT",
  "REGION_LT",
  "ASSET_CLASSIFICATION_LT",
];
const PORTFOLIO_BREAKDOWNS = [
  ...SECURITY_BREAKDOWNS,
  ...LOOKTHROUGH_BREAKDOWNS,
  "PORTFOLIO_TYPE",
  "LIQUIDATION_TIME_STANDARD",
  "LIQUIDATION_TIME_URGENT",
];
const OPEN_END = "2222-12-31";
// "Other" above this in a lookthrough dimension: positions not adding up to the nav, or a big holding with a thin shape
const BREAKDOWN_OTHER_MAX_PCT = 20;
// Held funds / ETFs / structured products below this value don't need a lookthrough shape
const LOOKTHROUGH_MIN_VALUE = 1000;

/**
 * B1: breakdown intervals are consistent in every table: no two intervals of one entity / dimension overlap, and the
 * weights of every interval sum to 100.
 */
export async function checkBreakdownIntegrity(targetDate = new Date()) {
  const dateStr = utils.formatDateToISO(targetDate);
  const rows = [];
  for (const [level, table, key] of BREAKDOWN_TABLES) {
    const { rows: found } = await query(
      `WITH intervals AS (
         SELECT ${key} AS id, breakdown, start_date, end_date, sum(weight)::float AS total FROM ${table} GROUP BY 1, 2, 3, 4
       ),
       ordered AS (
         SELECT *, LAG(end_date) OVER (PARTITION BY id, breakdown ORDER BY start_date, end_date) AS prev_end FROM intervals
       )
       SELECT $1::text AS level, id, breakdown, start_date::text, end_date::text,
              CASE WHEN prev_end > start_date THEN 'overlaps the previous interval (ends ' || prev_end::text || ')'
                   ELSE 'weights sum to ' || round(total::numeric, 2)::text END AS problem
       FROM ordered WHERE prev_end > start_date OR abs(total - 100) > 0.01
       ORDER BY id, breakdown, start_date;`,
      [level],
    );
    rows.push(...found);
  }
  return qcResult("checkBreakdownIntegrity", dateStr, rows, {
    severity: "CRITICAL",
    ok: "Breakdown intervals don't overlap and every one sums to 100.",
    fail: (n) => `Found ${n} broken breakdown interval(s).`,
    message:
      "Overlapping intervals or weights not summing to 100 (a breakdown writer bug?):",
  });
}

/**
 * B2: breakdowns ran: every active portfolio with a non-zero latest nav has a current interval (open until 2222-12-31)
 * for each security and portfolio dimension, every aggregate with a breakdown_scope for each dimension of its scope.
 */
export async function hasBreakdownsRunToday(targetDate = new Date()) {
  const dateStr = utils.formatDateToISO(targetDate);
  const { rows } = await query(
    `WITH expected AS (
       SELECT 'portfolio' AS level, p.portfolio_id AS id, d AS breakdown
       FROM portfolios p
       JOIN LATERAL (SELECT nav FROM nav n WHERE n.portfolio_id = p.portfolio_id AND n.date <= $1::date ORDER BY n.date DESC LIMIT 1) n ON true
       CROSS JOIN unnest($2::text[]) d
       WHERE p.closed_date IS NULL AND p.inception_date <= $1::date AND n.nav <> 0
       UNION ALL
       SELECT 'aggregate', a.aggregate_id, d
       FROM aggregates a CROSS JOIN unnest($2::text[]) d
       WHERE (a.breakdown_scope = 'ALL' OR (a.breakdown_scope = 'LT_ONLY' AND d = ANY($3)))
         AND EXISTS (SELECT 1 FROM aggregate_nav x WHERE x.aggregate_id = a.aggregate_id AND x.date <= $1::date)
     )
     SELECT e.level, e.id, string_agg(e.breakdown, ', ' ORDER BY e.breakdown) AS missing
     FROM expected e
     WHERE NOT EXISTS (
       SELECT 1 FROM portfolio_breakdowns b WHERE e.level = 'portfolio' AND b.portfolio_id = e.id AND b.breakdown = e.breakdown AND b.end_date = $4::date
       UNION ALL
       SELECT 1 FROM aggregate_breakdowns b WHERE e.level = 'aggregate' AND b.aggregate_id = e.id AND b.breakdown = e.breakdown AND b.end_date = $4::date
     )
     GROUP BY 1, 2 ORDER BY 1, 2;`,
    [dateStr, PORTFOLIO_BREAKDOWNS, LOOKTHROUGH_BREAKDOWNS, OPEN_END],
  );
  return qcResult("hasBreakdownsRunToday", dateStr, rows, {
    severity: "CRITICAL",
    ok: "Every active portfolio and aggregate has current breakdowns.",
    fail: (n) => `${n} portfolio(s) / aggregate(s) without current breakdowns.`,
    message:
      "Dimensions without a current interval (did the breakdown step fail or skip them?):",
  });
}

/** B3: current "Other" above BREAKDOWN_OTHER_MAX_PCT in a lookthrough dimension of a portfolio / aggregate. */
export async function checkBreakdownOther(targetDate = new Date()) {
  const dateStr = utils.formatDateToISO(targetDate);
  const { rows } = await query(
    `SELECT 'portfolio' AS level, portfolio_id AS id, breakdown, weight::float AS other_pct FROM portfolio_breakdowns
     WHERE end_date = $1::date AND sector = 'Other' AND breakdown = ANY($2) AND weight > $3
     UNION ALL
     SELECT 'aggregate', aggregate_id, breakdown, weight::float FROM aggregate_breakdowns
     WHERE end_date = $1::date AND sector = 'Other' AND breakdown = ANY($2) AND weight > $3
     ORDER BY 4 DESC;`,
    [OPEN_END, LOOKTHROUGH_BREAKDOWNS, BREAKDOWN_OTHER_MAX_PCT],
  );
  return qcResult("checkBreakdownOther", dateStr, rows, {
    severity: "WARNING",
    ok: `No lookthrough breakdown with more than ${BREAKDOWN_OTHER_MAX_PCT}% in "Other".`,
    fail: (n) =>
      `${n} lookthrough breakdown(s) with more than ${BREAKDOWN_OTHER_MAX_PCT}% in "Other".`,
    message: `"Other" above ${BREAKDOWN_OTHER_MAX_PCT}% (positions not adding up to the nav, or a big holding with a thin lookthrough shape?):`,
  });
}

/**
 * B4: funds, ETFs and structured products held today (positions of the latest nav, worth at least
 * LOOKTHROUGH_MIN_VALUE EUR) without a lookthrough shape active today: their _LT breakdowns fall back to the
 * security's own attribute. Input for the lookthrough data project.
 */
export async function checkLookthroughCoverage(targetDate = new Date()) {
  const dateStr = utils.formatDateToISO(targetDate);
  const { rows } = await query(
    `SELECT p.security_id, s.asset_type, string_agg(DISTINCT p.portfolio_id, ', ') AS portfolios,
            round(sum(p.market_value_eur)::numeric, 0)::float AS value_eur
     FROM positions p
     JOIN (SELECT portfolio_id, max(date) AS d FROM nav WHERE date <= $1::date GROUP BY 1) m ON m.portfolio_id = p.portfolio_id AND m.d = p.date
     JOIN portfolios f ON f.portfolio_id = p.portfolio_id
     JOIN security_master s ON s.security_id = p.security_id
     WHERE f.closed_date IS NULL AND abs(p.quantity) > 1e-5 AND s.asset_type IN ('ETF', 'FUND', 'STRUCTURED_PRODUCT')
       AND NOT EXISTS (SELECT 1 FROM lookthrough_data l WHERE l.security_id = p.security_id AND l.start_date <= $1::date AND $1::date < l.end_date)
     GROUP BY 1, 2 HAVING sum(abs(p.market_value_eur)) >= $2
     ORDER BY 4 DESC;`,
    [dateStr, LOOKTHROUGH_MIN_VALUE],
  );
  return qcResult("checkLookthroughCoverage", dateStr, rows, {
    severity: "WARNING",
    ok: "Every fund / ETF / structured product held has a lookthrough shape.",
    fail: (n) => `${n} fund(s) / ETF(s) held without a lookthrough shape.`,
    message:
      "Held without lookthrough data (their _LT breakdowns use the security's own attribute):",
  });
}

// ============================================================================
// BATCH LOG (user, 2026-10-31)
// ============================================================================

const batchRows = (level) => batchLog.entries(level).map(({ step, entity, message }) => ({ step, entity, message }));

/** BL1: errors of tonight's batch (a step that crashed twice, a portfolio / event / feed that failed): something didn't run. */
export async function checkBatchErrors(targetDate = new Date()) {
  return qcResult("checkBatchErrors", utils.formatDateToISO(targetDate), batchRows("ERROR"), {
    severity: "CRITICAL",
    ok: "The batch ran without errors.",
    fail: (n) => `${n} error(s) in tonight's batch.`,
    message: "Failed during the batch (the rest carried on with the data already in the DB):",
  });
}

/** BL2: warnings of tonight's batch (skips, unparsed emails, missing prices, a step that needed its retry). */
export async function checkBatchWarnings(targetDate = new Date()) {
  return qcResult("checkBatchWarnings", utils.formatDateToISO(targetDate), batchRows("WARNING"), {
    severity: "WARNING",
    ok: "The batch ran without warnings.",
    fail: (n) => `${n} warning(s) in tonight's batch.`,
    message: "Skipped or degraded during the batch:",
  });
}

/**
 * S1: securities created automatically (a new ISIN / token / fund in an email, event or import) not reviewed yet: their
 * classifications are "Other" and the provider match needs a look. Curate the row in security_master, then set
 * reviewed = true.
 */
export async function checkSecuritiesToReview(targetDate = new Date()) {
  const dateStr = utils.formatDateToISO(targetDate);
  const { rows } = await query(
    `SELECT security_id, security_description AS description, asset_type, source, source_id, review_note
     FROM security_master WHERE NOT reviewed ORDER BY created_at;`,
  );
  return qcResult("checkSecuritiesToReview", dateStr, rows, {
    severity: "WARNING",
    ok: "No security waiting for review.",
    fail: (n) => `${n} new security(ies) to review.`,
    message: "Created automatically: check the provider match, set asset class / region / classification, then reviewed = true:",
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
  checkDuplicateTransactions,
  checkTransactionPrices,
  checkNegativeHoldings,
  checkFlowTypes,
  checkDuplicateFlows,
  hasPortfoliosRunToday,
  checkPositionValues,
  checkPositionWeights,
  checkNegativePositions,
  checkPositionsVsLedger,
  checkPositionsVsLots,
  checkStalePositionPrices,
  isNavContinuous,
  checkNavVsPositions,
  checkNavJumps,
  hasAggregatesRunToday,
  checkAggregateSums,
  checkAggregateJumps,
  isAggregateNavContinuous,
  checkPortfoliosInTree,
  checkPerformanceResiduals,
  checkPerformanceCoverage,
  checkPerformanceJumps,
  checkTradeSpikes,
  hasPerformanceRunToday,
  checkTaxPaid,
  checkPriceJumps,
  hasRiskRunToday,
  checkRiskGaps,
  checkRiskCoverage,
  checkBreakdownIntegrity,
  hasBreakdownsRunToday,
  checkBreakdownOther,
  checkLookthroughCoverage,
  checkBatchErrors,
  checkBatchWarnings,
  checkSecuritiesToReview,
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
    // transactions
    checkDuplicateTransactions(targetDate),
    checkTransactionPrices(targetDate),
    checkNegativeHoldings(targetDate),
    // capital flows
    checkFlowTypes(targetDate),
    checkDuplicateFlows(targetDate),
    // positions
    hasPortfoliosRunToday(targetDate),
    checkPositionValues(targetDate),
    checkPositionWeights(targetDate),
    checkNegativePositions(targetDate),
    checkPositionsVsLedger(targetDate),
    checkPositionsVsLots(targetDate),
    checkStalePositionPrices(targetDate),
    // nav
    isNavContinuous(targetDate),
    checkNavVsPositions(targetDate),
    checkNavJumps(targetDate),
    // aggregate nav
    hasAggregatesRunToday(targetDate),
    checkAggregateSums(targetDate),
    checkAggregateJumps(targetDate),
    isAggregateNavContinuous(targetDate),
    checkPortfoliosInTree(targetDate),
    // performance
    hasPerformanceRunToday(targetDate),
    checkPerformanceCoverage(targetDate),
    checkPerformanceResiduals(targetDate),
    checkPerformanceJumps(targetDate),
    checkTradeSpikes(targetDate),
    // taxes
    checkTaxPaid(targetDate),
    // prices & risk
    checkPriceJumps(targetDate),
    hasRiskRunToday(targetDate),
    checkRiskGaps(targetDate),
    checkRiskCoverage(targetDate),
    // breakdowns
    checkBreakdownIntegrity(targetDate),
    hasBreakdownsRunToday(targetDate),
    checkBreakdownOther(targetDate),
    checkLookthroughCoverage(targetDate),
    // batch log
    checkBatchErrors(targetDate),
    checkBatchWarnings(targetDate),
    // securities
    checkSecuritiesToReview(targetDate),
  ]);

  return { results };
}
