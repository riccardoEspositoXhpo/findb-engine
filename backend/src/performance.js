import { utils } from "./utils.js";
import { query, replaceDataInDb, withSavepoint } from "./db.js";
import { loadFxRates, currencyConverter } from "./marketData.js";

export const performance = {
  run,
  runSecurityPerformance,
};

// Securities without a price series of their own: cash is 1 per unit, crypto is a currency (its moves are fx at
// portfolio level), debts are cash
const UNPRICED_ASSET_TYPES = ["CASH", "DEBT", "CRYPTO"];

/**
 * Nightly performance step. Security level only for now; portfolio and aggregate follow.
 *
 * @param {Date|string} [targetDate=new Date()]
 */
export async function run(targetDate = new Date()) {
  return runSecurityPerformance(targetDate);
}

/**
 * Daily security returns from the prices and the cash distributions (security_income), one brick per calendar day
 * [d, d+1], in the security's own currency, in percent:
 * - PRICE_RETURN: the move between two consecutive prices lands on the day of the second price; the days in between
 *   (weekends, holidays, weekly / monthly prices) are 0. A distribution's ex-date drop shows here (raw prices)
 * - INCOME_RETURN: Σ distributions with ex-date = the brick's end day / the last price before it, the market
 *   convention for total return (MSCI / S&P total-return indices, GIPS accrual); amounts in another currency are
 *   converted at the ex-date
 * - TOTAL_RETURN = PRICE_RETURN + INCOME_RETURN
 * From each security's first price to its last; nothing for cash, debts and crypto (UNPRICED_ASSET_TYPES).
 * Each security restarts where it has to (getSecurityPerformanceStart); its bricks from there are replaced.
 * Migrated from calculateSecurityPerformance in // securityData.gs. GAS matched income on the pay date (a day
 * apart from the price drop), ignored days with two distributions and needed a price on the income day.
 *
 * @param {Date|string} [targetDate=new Date()] - Last day computed (prices after it are ignored)
 * @param {Object} [options={}] - { runOnlyThisId }
 * @returns {Promise<{written: number, securities: number}>}
 */
export async function runSecurityPerformance(targetDate = new Date(), options = {}) {
  const dateStr = utils.formatDateToISO(targetDate);
  console.log(`[PERFORMANCE] Starting security performance up to ${dateStr}...`);
  await loadFxRates();

  const { rows: securities } = await query(
    `SELECT s.security_id, s.currency FROM security_master s
     WHERE s.asset_type <> ALL($1) AND EXISTS (SELECT 1 FROM prices p WHERE p.security_id = s.security_id AND p.date <= $2)
     ${options.runOnlyThisId ? "AND s.security_id = $3" : ""} ORDER BY 1;`,
    options.runOnlyThisId ? [UNPRICED_ASSET_TYPES, dateStr, options.runOnlyThisId] : [UNPRICED_ASSET_TYPES, dateStr],
  );

  let written = 0;
  let recomputed = 0;
  for (const security of securities) {
    const from = await getSecurityPerformanceStart(security.security_id, dateStr);
    if (!from) continue;
    const { rows: prices } = await query(
      `SELECT date::text AS date, price::float FROM prices WHERE security_id = $1 AND date >= $2 AND date <= $3 ORDER BY date;`,
      [security.security_id, from, dateStr],
    );
    const { rows: income } = await query(
      `SELECT ex_date::text AS ex_date, amount::float, currency FROM security_income WHERE security_id = $1 AND ex_date > $2 AND ex_date <= $3;`,
      [security.security_id, from, dateStr],
    );
    const bricks = securityBricks(security, prices, income);
    await withSavepoint(async () => {
      await query(`DELETE FROM security_performance WHERE security_id = $1 AND start_date >= $2;`, [security.security_id, from]);
      if (bricks.length > 0) await replaceDataInDb(bricks, "security_performance");
    });
    written += bricks.length;
    recomputed++;
  }
  console.log(`[PERFORMANCE] Done: ${written} security bricks written for ${recomputed} securities.`);
  return { written, securities: recomputed };
}

/**
 * Bricks between consecutive prices: [d, d+1] for every day from the first price to the last, the price move on the
 * day of the next price, distributions on their ex-date over the last price before it.
 *
 * @param {Object} security - { security_id, currency }
 * @param {Array} prices - { date, price } ascending, the first one is the window's base
 * @param {Array} income - { ex_date, amount, currency } with ex-dates after the first price
 * @returns {Array} security_performance rows
 */
function securityBricks(security, prices, income) {
  const incomeByDay = new Map();
  for (const distribution of income) {
    const rate = distribution.currency === security.currency ? 1 : currencyConverter(distribution.currency, security.currency, distribution.ex_date);
    if (rate === null) {
      console.warn(`[PERFORMANCE] ${security.security_id}: no ${distribution.currency}/${security.currency} rate on ${distribution.ex_date}, distribution skipped.`);
      continue;
    }
    incomeByDay.set(distribution.ex_date, (incomeByDay.get(distribution.ex_date) ?? 0) + distribution.amount * rate);
  }

  const bricks = [];
  for (let i = 1; i < prices.length; i++) {
    const { date: startPriceDate, price: startPrice } = prices[i - 1];
    const { date: endPriceDate, price: endPrice } = prices[i];
    for (let day = startPriceDate; day < endPriceDate; day = utils.addDays(day, 1)) {
      const end = utils.addDays(day, 1);
      const priceReturn = end === endPriceDate ? ((endPrice - startPrice) / startPrice) * 100 : 0;
      const incomeReturn = incomeByDay.has(end) ? (incomeByDay.get(end) / startPrice) * 100 : 0;
      bricks.push({
        start_date: day,
        end_date: end,
        security_id: security.security_id,
        price_return: priceReturn,
        income_return: incomeReturn,
        total_return: priceReturn + incomeReturn,
      });
    }
  }
  return bricks;
}

/**
 * Where a security's bricks restart, derived from the data like valuation.getRollStartDate: its last price with a
 * brick (the last brick's end), or earlier when, since its last run (max security_performance.created_at), a price or
 * a distribution was written with a past date: then the last price before that date (the brick ending on a changed
 * price starts at the previous price). No bricks yet: the first price. null when there is no later price to add.
 *
 * @param {string} securityId
 * @param {string} dateStr - ISO date of the run
 * @returns {Promise<string|null>} ISO date of the window's base price
 */
async function getSecurityPerformanceStart(securityId, dateStr) {
  // last_run stays in SQL (microsecond timestamps, see getRollStartDate)
  const { rows } = await query(
    `WITH last AS (SELECT max(end_date) AS end_date, max(created_at) AS run FROM security_performance WHERE security_id = $1),
     changed AS (
       SELECT least(
         (SELECT min(date) FROM prices WHERE security_id = $1 AND date <= $2 AND created_at > (SELECT run FROM last)),
         (SELECT min(ex_date) FROM security_income WHERE security_id = $1 AND ex_date <= $2 AND created_at > (SELECT run FROM last))
       ) AS day
     )
     SELECT (SELECT end_date FROM last)::text AS last_end,
            (SELECT day FROM changed)::text AS changed,
            (SELECT max(date) FROM prices WHERE security_id = $1 AND date <= $2)::text AS last_price,
            (SELECT min(date) FROM prices WHERE security_id = $1 AND date <= $2)::text AS first_price,
            (SELECT max(date) FROM prices WHERE security_id = $1 AND date < (SELECT day FROM changed))::text AS price_before_change;`,
    [securityId, dateStr],
  );
  const { last_end: lastEnd, changed, last_price: lastPrice, first_price: firstPrice, price_before_change: beforeChange } = rows[0];
  if (!lastEnd) return firstPrice < lastPrice ? firstPrice : null;
  const from = changed ? [lastEnd, beforeChange ?? firstPrice].sort()[0] : lastEnd;
  return from < lastPrice ? from : null;
}
