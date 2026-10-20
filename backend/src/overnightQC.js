import { query } from "./db.js";
import { utils } from "./utils.js";

export const overnightQC = {
  hasCryptoRunToday,
  runAll,
};

// ============================================================================
// INDIVIDUAL QC CHECKS (Granular, SQL-first, zero memory bloat)
// ============================================================================

/**
 * Verifies that Crypto FX rates have been populated in fx_rates for targetDate.
 * Runs 24/7 (every single calendar day).
 *
 * @param {Date|string} [targetDate=new Date()] - Date to verify
 * @returns {Promise<{ passed: boolean, count: number, date: string }>}
 */
export async function hasCryptoRunToday(targetDate = new Date()) {
  const dateStr = utils.formatDateToISO(targetDate);

  // Join fx_rates with currencies to strictly count CRYPTO rate rows for today
  const sql = `
    SELECT COUNT(*)::int AS count
    FROM fx_rates f
    JOIN currencies c ON f.base_currency = c.currency_code
    WHERE f.date = $1::date
      AND c.type = 'CRYPTO';
  `;

  const { rows } = await query(sql, [dateStr]);
  const count = rows[0]?.count || 0;

  return {
    check: "hasCryptoRunToday",
    passed: count > 0,
    severity: "WARNING",
    summary:
      count > 0
        ? "Crypto FX rates are populated for today."
        : "No Crypto FX rates found for today.",
    data: [],
    date: dateStr,
  };
}

// ============================================================================
// PLACEHOLDERS FOR UPCOMING CHECKS (We will implement these one by one)
// ============================================================================

// export async function hasFiatFxRunToday(targetDate = new Date()) {}
// export async function hasPricesRunToday(targetDate = new Date()) {}
// export async function isFxTimeSeriesContinuous() {}
// export async function isLatestValueOutOfBounds() {}
// export async function doesNavMatchSumOfPositions() {}
// export async function checkWeightsSum() {}

/**
 * Esegue tutti i check di Quality Control in sequenza.
 * @param {Date|string} [targetDate=new Date()]
 * @returns {Promise<{ allPassed: boolean, results: Array }>}
 */
export async function runAll(targetDate = new Date()) {
  console.log(
    `[QC] Avvio esecuzione di tutti i controlli di qualità per la data: ${utils.formatDateToISO(targetDate)}...`,
  );

  // Active checks to run (add more as we implement them)
  const checksToRun = [hasCryptoRunToday(targetDate)];

  const results = await Promise.all(checksToRun);
  const allPassed = results.every((r) => r.passed);

  return {
    allPassed,
    results,
  };
}
