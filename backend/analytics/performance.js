import { utils } from "#core/utils.js";
import { query, replaceDataInDb, withSavepoint } from "#core/db.js";
import { loadFxRates, currencyConverter } from "#market/index.js";
import { ledger, OUTFLOW_TYPES } from "#ledger/ledger.js";

export const performance = {
  run,
  runSecurityPerformance,
  runPortfolioPerformance,
  runPortfolioNavReturn,
  runAggregatePerformance,
  runAggregateNavReturn,
};

// Securities without a price series of their own: cash is 1 per unit, crypto is a currency (its moves are fx at
// portfolio level), debts are cash
const UNPRICED_ASSET_TYPES = ["CASH", "DEBT", "CRYPTO"];

// Capital flows by role in a portfolio's return (user, 2026-10-29). External flows move money in / out and are not
// return; income and fees are return. REWARDS (card cashback) count as money in, not income (to revisit).
const EXTERNAL_IN = ["CASHIN", "ASSETIN", "ADJUST_IN", "REWARDS"];
const EXTERNAL_OUT = ["CASHOUT", "ASSETOUT", "ADJUST_OUT"];
const INCOME_FLOWS = ["DIVIDEND", "COUPON", "INTEREST", "STAKING", "EARN", "FUNDING_REWARD"];
const FEE_FLOWS = ["MANAGEMENT_FEE", "TRANSACTION_FEE", "FUNDING_FEE", "INTEREST_PAID", "TAX", "CAPITAL_GAIN_TAX"];
const COMPONENTS = ["price_return", "income_return", "trade_return", "fx_return", "fee_return", "residual"];
// Below this denominator (portfolio / aggregate currency) a period has nothing invested: zero returns
const MIN_DENOMINATOR = 1;

/**
 * Share of a period (d0, d1] that money arriving on `date` was invested: from the start of its day to d1 (Modified
 * Dietz with start-of-day inflows). 1 for a daily brick; a vest on the last day of a monthly brick counts 1/30, not as
 * if held all month (AWARDS_VESTED 2023-01: 3.45% instead of BLK's 7.1%).
 */
const inflowWeight = (d0, d1, date) => (Date.parse(d1) - Date.parse(date) + 86400000) / (Date.parse(d1) - Date.parse(d0));

/**
 * Nightly performance step, after the aggregate navs: security, portfolio and aggregate returns, then the nav returns.
 * Every level restarts from the earliest data written since its last run (created_at), like ROLL.
 *
 * @param {Date|string} [targetDate=new Date()]
 */
export async function run(targetDate = new Date()) {
  const securities = await runSecurityPerformance(targetDate);
  const portfolios = await runPortfolioPerformance(targetDate);
  const portfolioNavReturns = await runPortfolioNavReturn(targetDate);
  const aggregates = await runAggregatePerformance(targetDate);
  const aggregateNavReturns = await runAggregateNavReturn(targetDate);
  return { securities, portfolios, portfolioNavReturns, aggregates, aggregateNavReturns };
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

/**
 * Portfolio returns of the performance portfolios, one brick per pair of consecutive navs [d0, d1], in percent of the
 * portfolio currency. P&L = nav(d1) - nav(d0) - external flows (d0, d1]; denominator = nav(d0) + external inflows, each
 * weighted by the share of the period it was there (money in counts from the start of its day, money out at its end:
 * user, D1; inflowWeight). The P&L is split per holding, exactly:
 * - PRICE: start quantity x local price move, at the start fx
 * - FX: start quantity x end local price x fx move (crypto is a currency: unit price 1, its whole move is fx)
 * - TRADE: what each movement of the period (buy / sell leg, transfer, income or fee received in kind) is worth at
 *   the close vs its booked value
 * - INCOME: income flows at their booked value; FEE: fee flows + transaction fees at their booked value (taxes too)
 * - RESIDUAL: P&L - the rest (positions that don't match the ledger, navs that don't match the positions)
 * Since end value = start value + movements, these add up to the P&L by construction (GAS split each holding through
 * a "percent held" and case analysis: same-day buy + sell, foreign funds bought with base cash, fees in another
 * currency and new foreign positions went wrong, the gap landing in RESIDUAL).
 * Migrated from runPortfolioPerformance in // performanceData.gs
 *
 * @param {Date|string} [targetDate=new Date()] - Last day computed
 * @param {Object} [options={}] - { runOnlyThisId }
 * @returns {Promise<{written: number, portfolios: number}>}
 */
export async function runPortfolioPerformance(targetDate = new Date(), options = {}) {
  const dateStr = utils.formatDateToISO(targetDate);
  console.log(`[PERFORMANCE] Starting portfolio performance up to ${dateStr}...`);
  await loadFxRates();
  const { rows: portfolios } = await query(
    `SELECT * FROM portfolios WHERE performance ${options.runOnlyThisId ? "AND portfolio_id = $1" : ""} ORDER BY portfolio_id;`,
    options.runOnlyThisId ? [options.runOnlyThisId] : [],
  );
  const securities = new Map((await query(`SELECT security_id, currency, asset_type, price_pct, face FROM security_master;`)).rows.map((row) => [row.security_id, row]));

  let written = 0;
  let recomputed = 0;
  for (const portfolio of portfolios) {
    const from = await getPortfolioStart(portfolio.portfolio_id, "portfolio_performance", dateStr, true);
    if (!from) continue;
    const window = await loadPortfolioWindow(portfolio.portfolio_id, from, dateStr);
    const bricks = [];
    for (let i = 1; i < window.navs.length; i++) bricks.push(await portfolioBrick(portfolio, securities, window, window.navs[i - 1], window.navs[i]));
    await withSavepoint(async () => {
      await query(`DELETE FROM portfolio_performance WHERE portfolio_id = $1 AND start_date >= $2;`, [portfolio.portfolio_id, from]);
      if (bricks.length > 0) await replaceDataInDb(bricks, "portfolio_performance");
    });
    written += bricks.length;
    recomputed++;
  }
  console.log(`[PERFORMANCE] Done: ${written} portfolio bricks written for ${recomputed} portfolios.`);
  return { written, portfolios: recomputed };
}

/** navs, positions (by date), flows and transactions of a portfolio from its window's base nav to dateStr. */
async function loadPortfolioWindow(portfolioId, from, dateStr) {
  const { rows: navs } = await query(
    `SELECT date::text AS date, nav::float FROM nav WHERE portfolio_id = $1 AND date >= $2 AND date <= $3 ORDER BY date;`,
    [portfolioId, from, dateStr],
  );
  const { rows: positionRows } = await query(
    `SELECT date::text AS date, security_id, quantity::float, market_value_local::float AS local, market_value_base::float AS base
     FROM positions WHERE portfolio_id = $1 AND date >= $2 AND date <= $3;`,
    [portfolioId, from, dateStr],
  );
  const positions = new Map();
  for (const row of positionRows) (positions.get(row.date) ?? positions.set(row.date, new Map()).get(row.date)).set(row.security_id, row);
  const { rows: flows } = await query(
    `SELECT date::text AS date, security_id, capital_flow_type, quantity::float, market_value_base::float AS base
     FROM capital_flows WHERE portfolio_id = $1 AND date > $2 AND date <= $3;`,
    [portfolioId, from, dateStr],
  );
  const { rows: transactions } = await query(
    `SELECT date::text AS date, security_id, transaction_type, quantity::float, counter_currency, market_value_local::float AS local,
            market_value_base::float AS base, fee::float, fee_currency, fee_value_base::float AS fee_base
     FROM transactions WHERE portfolio_id = $1 AND date > $2 AND date <= $3;`,
    [portfolioId, from, dateStr],
  );
  return { navs, positions, flows, transactions };
}

/**
 * One portfolio brick [d0, d1] (see runPortfolioPerformance). Movements per security: signed quantity, booked value
 * in the portfolio currency and role (TRADE / EXTERNAL / INCOME / FEE).
 */
async function portfolioBrick(portfolio, securities, window, start, end) {
  const [d0, d1] = [start.date, end.date];
  const currency = portfolio.currency;
  const moves = new Map();
  const move = (securityId, quantity, value, role) => (moves.get(securityId) ?? moves.set(securityId, []).get(securityId)).push({ quantity, value, role });

  let external = 0;
  let inflows = 0;
  for (const flow of window.flows.filter((row) => row.date > d0 && row.date <= d1)) {
    const type = flow.capital_flow_type;
    const value = flow.base ?? 0;
    if (INCOME_FLOWS.includes(type)) move(flow.security_id, flow.quantity, value, "INCOME");
    else if (FEE_FLOWS.includes(type)) move(flow.security_id, -flow.quantity, value, "FEE");
    else {
      const out = EXTERNAL_OUT.includes(type) || (!EXTERNAL_IN.includes(type) && OUTFLOW_TYPES.includes(type));
      move(flow.security_id, out ? -flow.quantity : flow.quantity, out ? -value : value, "EXTERNAL");
      external += out ? -value : value;
      if (!out) inflows += value * inflowWeight(d0, d1, flow.date);
    }
  }
  for (const tx of window.transactions.filter((row) => row.date > d0 && row.date <= d1)) {
    const sign = tx.transaction_type === "BUY" ? 1 : -1;
    move(tx.security_id, sign * tx.quantity, sign * tx.base, "TRADE");
    move(await ledger.cashSecurityFor(tx.counter_currency), -sign * tx.local, -sign * tx.base, "TRADE");
    if (tx.fee) {
      const feeSecurity = await ledger.cashSecurityFor(tx.fee_currency);
      const feeBase = tx.fee_base ?? tx.fee * (currencyConverter(securities.get(feeSecurity)?.currency ?? tx.fee_currency, currency, tx.date) ?? 0);
      move(feeSecurity, -tx.fee, feeBase, "FEE");
    }
  }

  const positions0 = window.positions.get(d0) ?? new Map();
  const positions1 = window.positions.get(d1) ?? new Map();
  const amounts = { price_return: 0, income_return: 0, trade_return: 0, fx_return: 0, fee_return: 0 };
  for (const securityId of new Set([...positions0.keys(), ...positions1.keys(), ...moves.keys()])) {
    const security = securities.get(securityId);
    const [p0, p1] = [positions0.get(securityId), positions1.get(securityId)];
    const q0 = p0?.quantity ?? 0;
    // Local value per unit and fx to the portfolio currency, from the positions where held, else from the market
    const unit0 = q0 ? p0.local / q0 : null;
    const fx0 = p0?.local ? p0.base / p0.local : null;
    let unit1 = p1?.quantity ? p1.local / p1.quantity : null;
    let fx1 = p1?.local ? p1.base / p1.local : null;
    if (unit1 === null) unit1 = await marketUnitValue(security, securityId, d1, unit0);
    if (fx1 === null) fx1 = currencyConverter(security?.currency ?? currency, currency, d1) ?? fx0 ?? 1;
    if (q0) {
      amounts.price_return += q0 * (unit1 - unit0) * fx0;
      amounts.fx_return += q0 * unit1 * (fx1 - fx0);
    }
    for (const { quantity, value, role } of moves.get(securityId) ?? []) {
      const atClose = quantity * unit1 * fx1;
      if (role === "INCOME") {
        amounts.income_return += value;
        amounts.trade_return += atClose - value;
      } else if (role === "FEE") {
        amounts.fee_return -= value;
        amounts.trade_return += atClose + value;
      } else amounts.trade_return += atClose - value;
    }
  }

  const pnl = end.nav - start.nav - external;
  const denominator = start.nav + inflows;
  const brick = { start_date: d0, end_date: d1, portfolio_id: portfolio.portfolio_id };
  return toReturns(brick, amounts, pnl, denominator);
}

/** Local value of one unit on a date for a security no longer held: 1 for cash / debt / crypto, else its last price. */
async function marketUnitValue(security, securityId, dateStr, fallback) {
  if (!security || UNPRICED_ASSET_TYPES.includes(security.asset_type)) return 1;
  try {
    return await ledger.computeMarketValue(securityId, await ledger.getLatestPriceForDate(securityId, dateStr), 1);
  } catch {
    return fallback ?? 0;
  }
}

/** Component amounts + P&L + denominator -> brick in percent; residual closes the gap, total = Σ components. */
function toReturns(brick, amounts, pnl, denominator) {
  const row = { ...brick };
  if (!(denominator >= MIN_DENOMINATOR)) {
    for (const key of COMPONENTS) row[key] = 0;
    row.total_return = 0;
    return row;
  }
  const explained = Object.values(amounts).reduce((total, amount) => total + amount, 0);
  for (const [key, amount] of Object.entries(amounts)) row[key] = (amount / denominator) * 100;
  row.residual = ((pnl - explained) / denominator) * 100;
  row.total_return = COMPONENTS.reduce((total, key) => total + row[key], 0);
  return row;
}

/**
 * Where a portfolio's bricks (performance or nav return) restart: the last brick's end, or earlier when, since the
 * last run (max created_at of its bricks), a nav (or, with ledger, a flow or transaction) of the portfolio was written
 * with a past date (positions have no created_at: a position that changes value changes the nav): then the nav before that date. No bricks yet: its first nav. null if nothing to add.
 *
 * @param {string} portfolioId
 * @param {string} table - portfolio_performance / portfolio_nav_return
 * @param {string} dateStr - ISO date of the run
 * @param {boolean} withLedger - also flows and transactions
 * @returns {Promise<string|null>} ISO date of the window's base nav
 */
async function getPortfolioStart(portfolioId, table, dateStr, withLedger) {
  // last_run stays in SQL (microsecond timestamps, see getRollStartDate)
  const ledgerChanges = withLedger
    ? `, (SELECT min(date) FROM capital_flows WHERE portfolio_id = $1 AND date <= $2 AND created_at > (SELECT run FROM last)),
         (SELECT min(date) FROM transactions WHERE portfolio_id = $1 AND date <= $2 AND created_at > (SELECT run FROM last))`
    : "";
  const { rows } = await query(
    `WITH last AS (SELECT max(end_date) AS end_date, max(created_at) AS run FROM ${table} WHERE portfolio_id = $1),
     changed AS (SELECT least((SELECT min(date) FROM nav WHERE portfolio_id = $1 AND date <= $2 AND created_at > (SELECT run FROM last)) ${ledgerChanges}) AS day)
     SELECT (SELECT end_date FROM last)::text AS last_end, (SELECT day FROM changed)::text AS changed,
            (SELECT max(date) FROM nav WHERE portfolio_id = $1 AND date <= $2)::text AS last_nav,
            (SELECT min(date) FROM nav WHERE portfolio_id = $1 AND date <= $2)::text AS first_nav,
            (SELECT max(date) FROM nav WHERE portfolio_id = $1 AND date < (SELECT day FROM changed))::text AS nav_before_change;`,
    [portfolioId, dateStr],
  );
  const { last_end: lastEnd, changed, last_nav: lastNav, first_nav: firstNav, nav_before_change: beforeChange } = rows[0];
  if (!lastNav) return null;
  if (!lastEnd) return firstNav < lastNav ? firstNav : null;
  const from = changed ? [lastEnd, beforeChange ?? firstNav].sort()[0] : lastEnd;
  return from < lastNav ? from : null;
}

/**
 * Nav returns of every portfolio, one brick per pair of consecutive navs: nav_pnl = the change of the nav (flows
 * included: "how much did the number move"), nav_return = nav_pnl / |start nav| in percent (a debt getting smaller is
 * positive; GAS divided by the signed nav). 0 when the start nav is 0.
 *
 * @param {Date|string} [targetDate=new Date()]
 * @returns {Promise<{written: number}>}
 */
export async function runPortfolioNavReturn(targetDate = new Date()) {
  const dateStr = utils.formatDateToISO(targetDate);
  const { rows: portfolios } = await query(`SELECT portfolio_id FROM portfolios ORDER BY 1;`);
  let written = 0;
  for (const { portfolio_id: portfolioId } of portfolios) {
    const from = await getPortfolioStart(portfolioId, "portfolio_nav_return", dateStr, false);
    if (!from) continue;
    const { rows: navs } = await query(
      `SELECT date::text AS date, nav::float FROM nav WHERE portfolio_id = $1 AND date >= $2 AND date <= $3 ORDER BY date;`,
      [portfolioId, from, dateStr],
    );
    const bricks = navReturnBricks(navs).map((brick) => ({ ...brick, portfolio_id: portfolioId }));
    await withSavepoint(async () => {
      await query(`DELETE FROM portfolio_nav_return WHERE portfolio_id = $1 AND start_date >= $2;`, [portfolioId, from]);
      if (bricks.length > 0) await replaceDataInDb(bricks, "portfolio_nav_return");
    });
    written += bricks.length;
  }
  console.log(`[PERFORMANCE] Done: ${written} portfolio nav returns written.`);
  return { written };
}

/** Consecutive (date, nav) pairs -> { start_date, end_date, nav_pnl, nav_return }. */
function navReturnBricks(navs) {
  const bricks = [];
  for (let i = 1; i < navs.length; i++) {
    const [start, end] = [navs[i - 1], navs[i]];
    const pnl = end.nav - start.nav;
    bricks.push({ start_date: start.date, end_date: end.date, nav_pnl: pnl, nav_return: start.nav ? (pnl / Math.abs(start.nav)) * 100 : 0 });
  }
  return bricks;
}

/**
 * Nav returns of every aggregate from aggregate_nav, daily (see runPortfolioNavReturn). Restarts from the earliest
 * aggregate nav written since its last run.
 *
 * @param {Date|string} [targetDate=new Date()]
 * @returns {Promise<{written: number}>}
 */
export async function runAggregateNavReturn(targetDate = new Date()) {
  const dateStr = utils.formatDateToISO(targetDate);
  const { rows: aggregates } = await query(`SELECT aggregate_id FROM aggregates ORDER BY 1;`);
  let written = 0;
  for (const { aggregate_id: aggregateId } of aggregates) {
    const { rows } = await query(
      `WITH last AS (SELECT max(end_date) AS end_date, max(created_at) AS run FROM aggregate_nav_return WHERE aggregate_id = $1)
       SELECT least((SELECT end_date FROM last),
                    (SELECT max(date) FROM aggregate_nav WHERE aggregate_id = $1 AND date < (SELECT min(date) FROM aggregate_nav WHERE aggregate_id = $1 AND created_at > (SELECT run FROM last))))::text AS from_date,
              (SELECT end_date FROM last)::text AS last_end,
              (SELECT min(date) FROM aggregate_nav WHERE aggregate_id = $1)::text AS first_nav;`,
      [aggregateId],
    );
    const from = rows[0].last_end ? rows[0].from_date : rows[0].first_nav;
    if (!from) continue;
    const { rows: navs } = await query(
      `SELECT date::text AS date, nav::float FROM aggregate_nav WHERE aggregate_id = $1 AND date >= $2 AND date <= $3 ORDER BY date;`,
      [aggregateId, from, dateStr],
    );
    const bricks = navReturnBricks(navs).map((brick) => ({ ...brick, aggregate_id: aggregateId }));
    if (bricks.length === 0) continue;
    await withSavepoint(async () => {
      await query(`DELETE FROM aggregate_nav_return WHERE aggregate_id = $1 AND start_date >= $2;`, [aggregateId, from]);
      await replaceDataInDb(bricks, "aggregate_nav_return");
    });
    written += bricks.length;
  }
  console.log(`[PERFORMANCE] Done: ${written} aggregate nav returns written.`);
  return { written };
}

/**
 * Aggregate returns over the performance portfolios under each aggregate (any depth; user, D3: aggregate_performance
 * only tracks performance portfolios), one brick per calendar day [d, d+1], in percent of the aggregate currency.
 * Each portfolio counts with its latest nav on or before the day (weekly / monthly ones are flat between navs), times
 * the user's share (ownership_overrides), in the aggregate currency:
 * - the components of the portfolio brick ending that day, converted at the day's fx
 * - FX also gets the translation of the portfolio's start value into the aggregate currency (GAS added returns in
 *   other currencies as they were)
 * - external flows that day are not return; transfers between two performance portfolios of the aggregate (paired in
 *   lot_transfers) are not money in either (D7); a change of ownership share is a flow
 * - denominator = Σ start values + money in that day; RESIDUAL closes the gap to the change of value net of flows
 * Built from the portfolios' own navs and flows, so a portfolio without a brick can't silently count as 0 (GAS: Σ
 * weight x return, nested aggregates added without their weight, no fx, no ownership share).
 * Migrated from runAggregatePerformance in // performanceData.gs
 *
 * @param {Date|string} [targetDate=new Date()]
 * @returns {Promise<{written: number, aggregates: number}>}
 */
export async function runAggregatePerformance(targetDate = new Date()) {
  const dateStr = utils.formatDateToISO(targetDate);
  console.log(`[PERFORMANCE] Starting aggregate performance up to ${dateStr}...`);
  await loadFxRates();
  const { rows: aggregateRows } = await query(`SELECT aggregate_id, currency FROM aggregates ORDER BY 1;`);
  const { rows: tree } = await query(`SELECT parent_id, child_id, child_type FROM aggregate_tree;`);
  const portfolios = new Map((await query(`SELECT portfolio_id, currency, inception_date::text, closed_date::text, performance FROM portfolios;`)).rows.map((row) => [row.portfolio_id, row]));
  const { rows: overrideRows } = await query(`SELECT portfolio_id, start_date::text AS start_date, my_share::float AS my_share FROM ownership_overrides ORDER BY portfolio_id, start_date;`);
  const myShare = (portfolioId, date) => (overrideRows.filter((row) => row.portfolio_id === portfolioId && row.start_date <= date).at(-1)?.my_share ?? 100) / 100;
  const descendants = (id, seen = new Set()) => {
    for (const link of tree.filter((row) => row.parent_id === id))
      if (link.child_type === "PORTFOLIO") seen.add(link.child_id);
      else descendants(link.child_id, seen);
    return seen;
  };

  let written = 0;
  let recomputed = 0;
  for (const aggregate of aggregateRows) {
    const members = [...descendants(aggregate.aggregate_id)].filter((id) => portfolios.get(id)?.performance);
    if (members.length === 0) continue;
    const from = await getAggregatePerformanceStart(aggregate.aggregate_id, members, dateStr);
    if (!from || from >= dateStr) continue;
    const data = await loadAggregateWindow(members, from, dateStr);
    const bricks = [];
    for (let day = from; day < dateStr; day = utils.addDays(day, 1)) {
      const brick = aggregateBrick(aggregate, members, portfolios, myShare, data, day, utils.addDays(day, 1));
      if (brick) bricks.push(brick);
    }
    await withSavepoint(async () => {
      await query(`DELETE FROM aggregate_performance WHERE aggregate_id = $1 AND start_date >= $2;`, [aggregate.aggregate_id, from]);
      if (bricks.length > 0) await replaceDataInDb(bricks, "aggregate_performance");
    });
    written += bricks.length;
    recomputed++;
  }
  console.log(`[PERFORMANCE] Done: ${written} aggregate bricks written for ${recomputed} aggregates.`);
  return { written, aggregates: recomputed };
}

/**
 * Navs (all history: the latest on or before a day is needed), portfolio bricks, external flows and internal transfers
 * of the members for an aggregate window.
 */
async function loadAggregateWindow(members, from, dateStr) {
  const { rows: navRows } = await query(`SELECT portfolio_id, date::text AS date, nav::float FROM nav WHERE portfolio_id = ANY($1) AND date <= $2 ORDER BY date;`, [members, dateStr]);
  const navs = new Map(members.map((id) => [id, []]));
  for (const row of navRows) navs.get(row.portfolio_id).push([row.date, row.nav]);
  const { rows: brickRows } = await query(
    `SELECT b.*, b.start_date::text AS start_date, b.end_date::text AS end_date FROM portfolio_performance b WHERE portfolio_id = ANY($1) AND end_date > $2 AND end_date <= $3;`,
    [members, from, dateStr],
  );
  const bricks = new Map(brickRows.map((row) => [`${row.portfolio_id}|${row.end_date}`, row]));
  const { rows: flowRows } = await query(
    `SELECT c.capital_flow_id::text AS id, c.portfolio_id, c.date::text AS date, c.capital_flow_type, c.market_value_base::float AS base,
            t.assetout_flow_id::text AS paired_out, o.portfolio_id AS paired_from
     FROM capital_flows c LEFT JOIN lot_transfers t ON t.assetin_flow_id = c.capital_flow_id LEFT JOIN capital_flows o ON o.capital_flow_id = t.assetout_flow_id
     WHERE c.portfolio_id = ANY($1) AND c.date > (SELECT min(date) FROM nav WHERE portfolio_id = ANY($1)) - 1 AND c.date <= $2 AND c.capital_flow_type = ANY($3);`,
    [members, dateStr, [...EXTERNAL_IN, ...EXTERNAL_OUT]],
  );
  const flows = new Map();
  for (const row of flowRows) (flows.get(`${row.portfolio_id}|${row.date}`) ?? flows.set(`${row.portfolio_id}|${row.date}`, []).get(`${row.portfolio_id}|${row.date}`)).push(row);
  return { navs, bricks, flows };
}

/** Latest nav of a portfolio on or before a date (binary search over [date, nav] ascending), null before the first. */
function navOn(series, date) {
  let [low, high, found] = [0, series.length - 1, null];
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (series[mid][0] <= date) {
      found = series[mid][1];
      low = mid + 1;
    } else high = mid - 1;
  }
  return found;
}

/** One aggregate brick [d0, d1] (see runAggregatePerformance); null when no member is active. */
function aggregateBrick(aggregate, members, portfolios, myShare, data, d0, d1) {
  const amounts = { price_return: 0, income_return: 0, trade_return: 0, fx_return: 0, fee_return: 0 };
  let [startValue, change, external, inflows, active] = [0, 0, 0, 0, false];
  const isActive = (portfolio, date) => portfolio.inception_date <= date && (!portfolio.closed_date || date <= portfolio.closed_date);
  for (const id of members) {
    const portfolio = portfolios.get(id);
    const [on0, on1] = [isActive(portfolio, d0), isActive(portfolio, d1)];
    if (!on0 && !on1) continue;
    active = true;
    const nav0 = on0 ? navOn(data.navs.get(id), d0) ?? 0 : 0;
    const nav1 = on1 ? navOn(data.navs.get(id), d1) ?? 0 : 0;
    const fx0 = currencyConverter(portfolio.currency, aggregate.currency, d0) ?? 0;
    const fx1 = currencyConverter(portfolio.currency, aggregate.currency, d1) ?? 0;
    const [share0, share1] = [myShare(id, d0), myShare(id, d1)];
    startValue += nav0 * fx0 * share0;
    change += nav1 * fx1 * share1 - nav0 * fx0 * share0;
    // Entering (inception) or leaving (closing) the aggregate: its value comes in / goes out as money, not return
    // (VINOVEST has navs before its inception date, BINANCE_FUTURES opens without a flow)
    if (!on0 || !on1) {
      const moved = nav1 * fx1 * share1 - nav0 * fx0 * share0;
      external += moved;
      if (moved > 0) inflows += moved;
      continue;
    }

    // External flows of the day; a transfer from another member is neither money in nor money out of the aggregate
    let flowsBase = 0;
    for (const flow of data.flows.get(`${id}|${d1}`) ?? []) {
      const value = (EXTERNAL_OUT.includes(flow.capital_flow_type) ? -1 : 1) * (flow.base ?? 0);
      flowsBase += value;
      const internal = flow.paired_from && members.includes(flow.paired_from);
      if (value > 0 && !internal) inflows += value * fx1 * share1;
    }
    external += flowsBase * fx1 * share1;
    // A share change is money in / out of the user's part
    const shareFlow = (share1 - share0) * nav0 * fx0;
    external += shareFlow;
    if (shareFlow > 0) inflows += shareFlow;

    amounts.fx_return += nav0 * share1 * (fx1 - fx0);
    const brick = data.bricks.get(`${id}|${d1}`);
    if (brick) {
      // Back to amounts: the brick's denominator is its start nav + money in over the brick
      const brickNav0 = navOn(data.navs.get(id), brick.start_date) ?? 0;
      let brickInflows = 0;
      for (let day = utils.addDays(brick.start_date, 1); day <= d1; day = utils.addDays(day, 1))
        for (const flow of data.flows.get(`${id}|${day}`) ?? [])
          if (!EXTERNAL_OUT.includes(flow.capital_flow_type)) brickInflows += (flow.base ?? 0) * inflowWeight(brick.start_date, d1, day);
      const scale = ((brickNav0 + brickInflows) / 100) * fx1 * share1;
      // The portfolio's own residual stays unexplained: it lands in the aggregate's residual
      for (const key of Object.keys(amounts)) amounts[key] += Number(brick[key]) * scale;
    }
  }
  if (!active) return null;
  return toReturns({ start_date: d0, end_date: d1, aggregate_id: aggregate.aggregate_id }, amounts, change - external, startValue + inflows);
}

/**
 * Where an aggregate's bricks restart: the day after its last brick, or earlier when, since its last run, a brick or a
 * nav of one of its performance portfolios, or an fx rate, was written with a past date. No bricks yet: the first nav
 * of its members.
 */
async function getAggregatePerformanceStart(aggregateId, members, dateStr) {
  const { rows } = await query(
    `WITH last AS (SELECT max(end_date) AS end_date, max(created_at) AS run FROM aggregate_performance WHERE aggregate_id = $1)
     SELECT (SELECT end_date FROM last)::text AS last_end,
            least((SELECT min(start_date) FROM portfolio_performance WHERE portfolio_id = ANY($2) AND created_at > (SELECT run FROM last)),
                  (SELECT min(date) - 1 FROM nav WHERE portfolio_id = ANY($2) AND date <= $3 AND created_at > (SELECT run FROM last)),
                  (SELECT min(date) - 1 FROM fx_rates WHERE date <= $3 AND created_at > (SELECT run FROM last)))::text AS changed,
            (SELECT min(date) FROM nav WHERE portfolio_id = ANY($2))::text AS first_nav;`,
    [aggregateId, members, dateStr],
  );
  const { last_end: lastEnd, changed, first_nav: firstNav } = rows[0];
  if (!lastEnd) return firstNav;
  return changed && changed < lastEnd ? changed : lastEnd;
}
