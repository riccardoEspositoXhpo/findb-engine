import { utils } from "./utils.js";
import { query, withSavepoint } from "./db.js";
import { loadFxRates, currencyConverter } from "./marketData.js";

export const risk = {
  run,
  buildSecurityDailyVector,
  evaluateRiskSnapshot,
};

// Trading calendar: IUSQ sessions (weekdays) from here; crypto uses every calendar day from the same start
const CALENDAR_BENCHMARK = "IUSQ";
const CALENDAR_START = "2016-01-01";
// Tail capture benchmarks: equity, fixed income, crypto (worst TAIL_SESSIONS sessions each)
const BENCHMARKS = { equity: "IUSQ", fixedIncome: "EUNA", crypto: "BTC" };
const TAIL_SESSIONS = 30;
// A security may miss its price for up to this many sessions (local holidays: 0% carried); more is a data hole
const MAX_MISSING_SESSIONS = 3;
// Fixed historical stress windows (peak to trough)
const STRESS_SCENARIOS = {
  STRESS_COVID_2020: ["2020-02-19", "2020-03-23"],
  STRESS_RATES_2022: ["2022-01-03", "2022-10-21"],
  STRESS_UKRAINE_2022: ["2022-02-10", "2022-03-08"],
  STRESS_FTX_2022: ["2022-11-05", "2022-11-21"],
};
// A stress scenario needs returns on this share of its sessions (a security born mid-window would show a partial shock)
const STRESS_MIN_COVERAGE = 0.9;
// Metrics also given in money (<metric>_BASE, in the portfolio / aggregate currency: user, GAS called them _EUR) when a
// nav is known
const MONEY_METRICS = [
  "MAX_DD_1Y",
  "VAR_DLY_95",
  "ES_DLY_95",
  "VAR_WKL_95",
  "ES_WKL_95",
  "VAR_MTH_95",
  "ES_MTH_95",
  "GAR_DLY_95",
  "GAR_WKL_95",
  "GAR_MTH_95",
];
const UNIT_VALUED = ["CASH", "DEBT", "CRYPTO"];
const REAL_ASSETS = ["REAL_ASSET", "REAL_ESTATE"];

/**
 * Nightly risk step, after performance: ex-ante risk snapshots of the securities held, the performance portfolios and
 * the aggregates, as of each date in [from, targetDate] (nightly: the day itself), into security_risk /
 * portfolio_risk / aggregate_risk (one row per metric, the day's rows replaced). Every return series is daily, over
 * the full history since 2016 (252-session calendar, 365 days for crypto), today's composition projected on it, in the
 * currency of whose risk it is: securities in EUR, portfolios / aggregates in their own currency (AEGON in GBP).
 * Migrated from calculateSecurityRisk // securityData.gs, runPortfolioRisk // portfolioData.gs, runAggregateRisk //
 * aggregateData.gs, evaluateRiskSnapshot // generalScripts.gs
 *
 * @param {Date|string} [targetDate=new Date()]
 * @param {Object} [options={}] - { from: ISO date to backfill from }
 * @returns {Promise<{dates: number, securities: number, portfolios: number, aggregates: number, failures: Array}>}
 */
export async function run(targetDate = new Date(), options = {}) {
  const dateStr = utils.formatDateToISO(targetDate);
  console.log(`[RISK] Starting risk snapshots up to ${dateStr}...`);
  await loadFxRates();
  const data = await loadRiskData(dateStr);
  const totals = {
    dates: 0,
    securities: 0,
    portfolios: 0,
    aggregates: 0,
    failures: [],
  };
  for (
    let day = options.from ?? dateStr;
    day <= dateStr;
    day = utils.addDays(day, 1)
  ) {
    const result = await riskForDate(data, day);
    await withSavepoint(async () => {
      for (const [table, key, rows] of [
        ["security_risk", "security_id", result.securityRows],
        ["portfolio_risk", "portfolio_id", result.portfolioRows],
        ["aggregate_risk", "aggregate_id", result.aggregateRows],
      ]) {
        await query(`DELETE FROM ${table} WHERE date = $1;`, [day]);
        if (rows.length) await insertRiskRows(table, key, rows);
      }
    });
    totals.dates++;
    totals.securities += result.counts.securities;
    totals.portfolios += result.counts.portfolios;
    totals.aggregates += result.counts.aggregates;
    totals.failures.push(...result.failures);
  }
  console.log(
    `[RISK] Done: ${totals.dates} day(s), ${totals.securities} security / ${totals.portfolios} portfolio / ${totals.aggregates} aggregate snapshots, ${totals.failures.length} failure(s).`,
  );
  return totals;
}

/** Long rows { id, date, metric, value } inserted in chunks (a snapshot is ~30 metrics). */
async function insertRiskRows(table, key, rows) {
  for (let i = 0; i < rows.length; i += 1000) {
    const chunk = rows.slice(i, i + 1000);
    const values = chunk
      .map(
        (_, j) =>
          `($${j * 4 + 1}, $${j * 4 + 2}, $${j * 4 + 3}, $${j * 4 + 4})`,
      )
      .join(", ");
    await query(
      `INSERT INTO ${table} (${key}, date, metric, value) VALUES ${values};`,
      chunk.flatMap((row) => [row.id, row.date, row.metric, row.value]),
    );
  }
}

/** Reference data, prices, positions, navs and the aggregate tree, loaded once for every date of the run. */
async function loadRiskData(dateStr) {
  const securities = new Map(
    (
      await query(
        `SELECT security_id, currency, asset_type, risk_proxy FROM security_master;`,
      )
    ).rows.map((row) => [row.security_id, row]),
  );
  const prices = new Map();
  for (const row of (
    await query(
      `SELECT security_id, date::text AS date, price::float FROM prices WHERE date <= $1 AND price > 0;`,
      [dateStr],
    )
  ).rows)
    (
      prices.get(row.security_id) ??
      prices.set(row.security_id, new Map()).get(row.security_id)
    ).set(row.date, row.price);
  const portfolios = new Map(
    (await query(`SELECT * FROM portfolios;`)).rows.map((row) => [
      row.portfolio_id,
      row,
    ]),
  );
  const { rows: tree } = await query(
    `SELECT parent_id, child_id, child_type FROM aggregate_tree;`,
  );
  const aggregates = (
    await query(`SELECT aggregate_id, currency FROM aggregates ORDER BY 1;`)
  ).rows;
  const { rows: overrides } = await query(
    `SELECT portfolio_id, start_date::text AS start_date, my_share::float AS my_share FROM ownership_overrides ORDER BY portfolio_id, start_date;`,
  );
  const calendarDates = [...(prices.get(CALENDAR_BENCHMARK)?.keys() ?? [])]
    .filter(
      (date) =>
        date >= CALENDAR_START &&
        ![0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay()),
    )
    .sort();
  return {
    securities,
    prices,
    portfolios,
    tree,
    aggregates,
    overrides,
    calendarDates,
  };
}

/** Latest positions / nav of a portfolio on or before a date. */
async function latestPortfolioState(portfolioId, dateStr) {
  const { rows: navRows } = await query(
    `SELECT date::text AS date, nav::float, nav_eur::float FROM nav WHERE portfolio_id = $1 AND date <= $2 ORDER BY date DESC LIMIT 1;`,
    [portfolioId, dateStr],
  );
  if (!navRows.length) return null;
  const { rows: positions } = await query(
    `SELECT security_id, quantity::float, market_value_base::float, market_value_eur::float FROM positions WHERE portfolio_id = $1 AND date = $2;`,
    [portfolioId, navRows[0].date],
  );
  return { nav: navRows[0].nav, navEur: navRows[0].nav_eur, positions };
}

async function riskForDate(data, day) {
  const isActive = (portfolio) =>
    utils.formatDateToISO(portfolio.inception_date) <= day &&
    (!portfolio.closed_date ||
      day <= utils.formatDateToISO(portfolio.closed_date));
  const calendar252 = data.calendarDates.filter((date) => date <= day);
  const calendar365 = calendar252.length
    ? utils.daysBetween(calendar252[0], day)
    : [];
  const failures = [];
  const vectorCache = new Map();
  // Return vector of a security on a calendar in a currency (cached); a data hole is a failure: null
  const vectorFor = (securityId, calendar, currency = "EUR") => {
    const cacheKey = `${securityId}|${calendar.length}|${currency}`;
    if (vectorCache.has(cacheKey)) return vectorCache.get(cacheKey);
    const meta = data.securities.get(securityId);
    let vector = null;
    if (meta) {
      try {
        vector = buildSecurityDailyVector(
          meta,
          meta.risk_proxy,
          calendar,
          data,
          currency,
        );
      } catch (error) {
        failures.push({
          date: day,
          security_id: securityId,
          error: error.message,
        });
      }
    }
    vectorCache.set(cacheKey, vector);
    return vector;
  };
  const tails = (calendar, isCrypto) => ({
    eqTailCluster: extractBenchmarkTailCluster(
      vectorFor(BENCHMARKS.equity, calendar252),
      calendar252,
      TAIL_SESSIONS,
    ),
    fiTailCluster: extractBenchmarkTailCluster(
      vectorFor(BENCHMARKS.fixedIncome, calendar252),
      calendar252,
      TAIL_SESSIONS,
    ),
    cryptoTailCluster: extractBenchmarkTailCluster(
      vectorFor(BENCHMARKS.crypto, calendar),
      calendar,
      TAIL_SESSIONS,
    ),
    isCrypto,
  });
  const tails252 = tails(calendar252, false);
  const tails365 = tails(calendar365, true);
  const toRows = (record, id) =>
    Object.entries(record)
      .filter(
        ([metric, value]) =>
          metric !== "id" &&
          value !== null &&
          value !== undefined &&
          Number.isFinite(value),
      )
      .map(([metric, value]) => ({ id, date: day, metric, value }));

  // Securities: everything an active portfolio holds that day (real assets only with a risk proxy)
  const held = new Set();
  const states = new Map();
  for (const portfolio of data.portfolios.values()) {
    if (!isActive(portfolio)) continue;
    const state = await latestPortfolioState(portfolio.portfolio_id, day);
    if (!state) continue;
    states.set(portfolio.portfolio_id, state);
    for (const position of state.positions)
      if (Math.abs(position.quantity) > 1e-5) held.add(position.security_id);
  }
  const securityRows = [];
  let securityCount = 0;
  for (const securityId of [...held].sort()) {
    const meta = data.securities.get(securityId);
    if (!meta || (REAL_ASSETS.includes(meta.asset_type) && !meta.risk_proxy))
      continue;
    const isCrypto = meta.asset_type === "CRYPTO";
    const calendar = isCrypto ? calendar365 : calendar252;
    const vector = vectorFor(securityId, calendar);
    const record =
      vector &&
      evaluateRiskSnapshot(
        vector,
        calendar,
        null,
        isCrypto ? tails365 : tails252,
      );
    if (!record) continue;
    securityRows.push(...toRows(record, securityId));
    securityCount++;
  }

  // Portfolios: the performance portfolios, today's weights (positive positions) on each component's history
  const portfolioRows = [];
  let portfolioCount = 0;
  for (const portfolio of data.portfolios.values()) {
    if (!portfolio.performance || !states.has(portfolio.portfolio_id)) continue;
    const { nav, positions } = states.get(portfolio.portfolio_id);
    if (!positions.length || !nav) continue;
    const isCrypto = portfolio.portfolio_type === "Cryptocurrency Investment";
    const calendar = isCrypto ? calendar365 : calendar252;
    const components = [];
    for (const position of positions) {
      const weight = position.market_value_base / nav;
      if (weight <= 0.0001 || !data.securities.has(position.security_id))
        continue;
      const vector = vectorFor(
        position.security_id,
        calendar,
        portfolio.currency,
      );
      if (vector) components.push({ weight, vector });
    }
    if (!components.length) continue;
    // Weighted by what is known that session, renormalized; below half the weight known the session is null
    const vector = combine(components, calendar.length - 1, true);
    const record = evaluateRiskSnapshot(
      vector,
      calendar,
      nav,
      isCrypto ? tails365 : tails252,
    );
    if (!record) continue;
    // Share of the nav whose holdings have a usable series (QC R5: the rest is assumed to move like them)
    record.COVERAGE_PCT = truncate(
      components.reduce((total, component) => total + component.weight, 0) *
        100,
      2,
    );
    portfolioRows.push(...toRows(record, portfolio.portfolio_id));
    portfolioCount++;
  }

  // Aggregates: every position of every non-liability portfolio under it, at the user's share, in the aggregate's
  // currency over its nav (net of liabilities, so _BASE metrics are the money at risk); its own cash, real assets
  // without a proxy and unknown / broken series count as 0 (no daily risk), so the weights cover the whole aggregate
  const myShare = (portfolioId) =>
    (data.overrides
      .filter(
        (row) => row.portfolio_id === portfolioId && row.start_date <= day,
      )
      .at(-1)?.my_share ?? 100) / 100;
  const constituents = (id, found = new Set()) => {
    for (const link of data.tree.filter((row) => row.parent_id === id))
      if (link.child_type === "PORTFOLIO") found.add(link.child_id);
      else constituents(link.child_id, found);
    return found;
  };
  const aggregateRows = [];
  let aggregateCount = 0;
  for (const aggregate of data.aggregates) {
    const { rows: navRows } = await query(
      `SELECT nav::float FROM aggregate_nav WHERE aggregate_id = $1 AND date <= $2 ORDER BY date DESC LIMIT 1;`,
      [aggregate.aggregate_id, day],
    );
    const aggregateNav = navRows[0]?.nav;
    if (!aggregateNav || aggregateNav <= 0) continue;
    const ids = [...constituents(aggregate.aggregate_id)];
    if (!ids.length) continue;
    const isCrypto = ids.every(
      (id) =>
        data.portfolios.get(id)?.portfolio_type === "Cryptocurrency Investment",
    );
    const calendar = isCrypto ? calendar365 : calendar252;
    const weights = new Map();
    for (const id of ids) {
      const portfolio = data.portfolios.get(id);
      if (
        !portfolio ||
        portfolio.portfolio_type === "Liability" ||
        !states.has(id)
      )
        continue;
      const fx =
        currencyConverter(portfolio.currency, aggregate.currency, day) ?? 0;
      for (const position of states.get(id).positions) {
        const weight =
          ((position.market_value_base ?? 0) * fx * myShare(id)) / aggregateNav;
        if (weight > 0.00001)
          weights.set(
            position.security_id,
            (weights.get(position.security_id) ?? 0) + weight,
          );
      }
    }
    const zero = new Array(Math.max(calendar.length - 1, 0)).fill(0);
    let uncovered = 0;
    const components = [...weights].map(([securityId, weight]) => {
      const meta = data.securities.get(securityId);
      if (
        meta &&
        (meta.security_id === `CASH_${aggregate.currency}` ||
          (REAL_ASSETS.includes(meta.asset_type) && !meta.risk_proxy))
      )
        return { weight, vector: zero };
      const vector = meta
        ? vectorFor(securityId, calendar, aggregate.currency)
        : null;
      if (!vector) uncovered += weight; // counted as 0 risk, but it does move
      return { weight, vector: vector ?? zero };
    });
    if (!components.length) continue;
    // Not renormalized: the weights already cover the aggregate (cash at 0), so the % is of the whole aggregate
    const vector = combine(components, calendar.length - 1, false);
    const record = evaluateRiskSnapshot(
      vector,
      calendar,
      aggregateNav,
      isCrypto ? tails365 : tails252,
    );
    if (!record) continue;
    const total = components.reduce(
      (sum, component) => sum + component.weight,
      0,
    );
    record.COVERAGE_PCT =
      total > 0 ? truncate(((total - uncovered) / total) * 100, 2) : 0;
    aggregateRows.push(...toRows(record, aggregate.aggregate_id));
    aggregateCount++;
  }
  return {
    securityRows,
    portfolioRows,
    aggregateRows,
    failures,
    counts: {
      securities: securityCount,
      portfolios: portfolioCount,
      aggregates: aggregateCount,
    },
  };
}

/** Σ weight x return per session; null when less than half of the weight has a return that session. */
function combine(components, sessions, renormalize) {
  const vector = [];
  for (let t = 0; t < sessions; t++) {
    let sum = 0;
    let known = 0;
    for (const { weight, vector: series } of components) {
      const ret = series[t];
      if (ret !== null && !Number.isNaN(ret)) {
        sum += weight * ret;
        known += weight;
      }
    }
    vector.push(known >= 0.5 ? (renormalize ? sum / known : sum) : null);
  }
  return vector;
}

/**
 * Daily return vector of a security on a calendar, in a currency (length = calendar.length - 1, decimals). Its own
 * return when it is priced on both days, else its risk proxy's (return level: prices of the two never mixed); null
 * before either ever traded; 0 for up to MAX_MISSING_SESSIONS missing sessions (local holidays); a longer hole throws.
 * Cash / debt / crypto are worth 1 in their own currency: their return is the currency's move against `currency`.
 *
 * @param {Object} meta - security_master row
 * @param {string|null} proxyId - risk_proxy
 * @param {Array<string>} calendar - ISO dates
 * @param {Object} data - { securities, prices }
 * @param {string} [currency="EUR"] - currency of the returns
 * @returns {Array<number|null>}
 */
export function buildSecurityDailyVector(
  meta,
  proxyId,
  calendar,
  data,
  currency = "EUR",
) {
  const eurPrice = (securityId, date) => {
    const security = data.securities.get(securityId);
    if (!security) return null;
    const price = UNIT_VALUED.includes(security.asset_type)
      ? 1
      : data.prices.get(securityId)?.get(date);
    if (!price || price <= 0) return null;
    let fx = 1;
    try {
      if (security.currency !== currency)
        fx = currencyConverter(security.currency, currency, date);
    } catch {
      return null; // no rate yet that early (crypto before its first rate): not traded
    }
    return fx && fx > 0 ? price * fx : null;
  };
  const proxy = proxyId && data.securities.has(proxyId) ? proxyId : null;
  const vector = [];
  let securityPrevious = eurPrice(meta.security_id, calendar[0]);
  let proxyPrevious = proxy ? eurPrice(proxy, calendar[0]) : null;
  let traded = securityPrevious !== null || proxyPrevious !== null;
  let missing = 0;
  for (let i = 1; i < calendar.length; i++) {
    const securityNow = eurPrice(meta.security_id, calendar[i]);
    const proxyNow = proxy ? eurPrice(proxy, calendar[i]) : null;
    if (securityNow !== null || proxyNow !== null) traded = true;
    if (securityPrevious !== null && securityNow !== null) {
      vector.push((securityNow - securityPrevious) / securityPrevious);
      [securityPrevious, proxyPrevious, missing] = [securityNow, proxyNow, 0];
    } else if (proxy && proxyPrevious !== null && proxyNow !== null) {
      vector.push((proxyNow - proxyPrevious) / proxyPrevious);
      [securityPrevious, proxyPrevious, missing] = [securityNow, proxyNow, 0];
    } else if (!traded) {
      vector.push(null);
      [securityPrevious, proxyPrevious] = [securityNow, proxyNow];
    } else if (missing < MAX_MISSING_SESSIONS) {
      vector.push(0);
      securityPrevious = securityNow ?? securityPrevious;
      proxyPrevious = proxyNow ?? proxyPrevious;
      missing++;
    } else {
      throw new Error(
        `no price for ${meta.security_id} on ${calendar[i]} (${missing + 1} sessions in a row, proxy ${proxy ?? "none"})`,
      );
    }
  }
  return vector;
}

const truncate = (value, decimals) =>
  Math.trunc(value * 10 ** decimals) / 10 ** decimals;
const mean = (values) =>
  values.reduce((sum, value) => sum + value, 0) / values.length;
// Population standard deviation (GAS calculateStandardDeviation)
const standardDeviation = (values) => {
  if (!values.length) return 0;
  const average = mean(values);
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
      values.length,
  );
};

/**
 * Risk profile of a return vector (security, portfolio or aggregate), percentages truncated to 2 decimals:
 * VOLATILITY_1Y / 5Y, DOWNSIDE_DEV_1Y (annualized), CURRENT_DD (from the all-time peak), MAX_DD_1Y, historical VaR / ES /
 * GaR at 95% over the full history (daily, rolling 5 and 21 sessions), WORST_DAY / WEEK / MONTH, the fixed STRESS_*
 * windows, tail capture ratios against the equity / fixed income / crypto benchmarks' 30 worst sessions (4 decimals),
 * and with a nav the money metrics (<metric>_BASE = nav x %, in the nav's currency). Needs 21 returns for the statistics.
 * GAS: VOLATILITY_5Y was over the whole history (now the last 5 years); a stress window counted sessions without a
 * return as 0% (a security born after it showed a 0 shock: now null below STRESS_MIN_COVERAGE); the money metrics
 * were named _EUR whatever the currency (now _BASE).
 *
 * @param {Array<number|null>} vector - daily returns (decimals) on the calendar
 * @param {Array<string>} calendar - ISO dates (vector.length + 1)
 * @param {number|null} nav - nav for the _BASE metrics (in the currency of the returns)
 * @param {Object} tails - { eqTailCluster, fiTailCluster, cryptoTailCluster, isCrypto }
 * @returns {Object|null} metric -> value
 */
export function evaluateRiskSnapshot(vector, calendar, nav, tails) {
  if (!vector || !vector.length) return null;
  const record = {};
  const valid = vector.filter((ret) => ret !== null && !Number.isNaN(ret));
  const annual = tails.isCrypto ? 365 : 252;
  if (valid.length >= 21) {
    const last1Y = valid.slice(-annual);
    record.VOLATILITY_1Y = truncate(
      standardDeviation(last1Y) * 100 * Math.sqrt(annual),
      2,
    );
    record.VOLATILITY_5Y = truncate(
      standardDeviation(valid.slice(-5 * annual)) * 100 * Math.sqrt(annual),
      2,
    );
    record.DOWNSIDE_DEV_1Y = truncate(
      downsideDeviation(last1Y) * 100 * Math.sqrt(annual),
      2,
    );
    record.CURRENT_DD = truncate(drawdowns(valid).current * 100, 2);
    record.MAX_DD_1Y = truncate(drawdowns(last1Y).max * 100, 2);
    for (const [label, series] of [
      ["DLY", valid],
      ["WKL", rollingCompounded(valid, 5)],
      ["MTH", rollingCompounded(valid, 21)],
    ]) {
      const tail = tailMetrics(series, 0.95);
      record[`VAR_${label}_95`] = truncate(tail.var * 100, 2);
      record[`ES_${label}_95`] = truncate(tail.es * 100, 2);
      record[`GAR_${label}_95`] = truncate(tail.gar * 100, 2);
    }
  }
  const worst = worstRollingWindows(valid);
  for (const key of ["WORST_DAY", "WORST_WEEK", "WORST_MONTH"])
    if (worst[key] !== null) record[key] = truncate(worst[key] * 100, 2);
  for (const [key, [start, end]] of Object.entries(STRESS_SCENARIOS)) {
    const shock = historicalShock(vector, calendar, start, end);
    if (shock !== null) record[key] = truncate(shock * 100, 2);
  }
  for (const [key, cluster] of [
    ["EQUITY_TAIL_CAPTURE", tails.eqTailCluster],
    ["CRYPTO_TAIL_CAPTURE", tails.cryptoTailCluster],
    ["FI_TAIL_CAPTURE", tails.fiTailCluster],
  ]) {
    const capture = cluster ? tailCapture(vector, calendar, cluster) : null;
    if (capture !== null && !Number.isNaN(capture))
      record[key] = truncate(capture, 4);
  }
  if (nav > 0)
    for (const key of MONEY_METRICS)
      if (record[key] !== undefined)
        record[`${key}_BASE`] = Number(((nav * record[key]) / 100).toFixed(2));
  return record;
}

/** Compounded return over a stress window; null when fewer than STRESS_MIN_COVERAGE of its sessions have a return. */
function historicalShock(vector, calendar, start, end) {
  let wealth = 1;
  let sessions = 0;
  let known = 0;
  for (let i = 0; i < vector.length; i++) {
    const date = calendar[i + 1];
    if (date < start || date > end) continue;
    sessions++;
    if (vector[i] === null || Number.isNaN(vector[i])) continue;
    wealth *= 1 + vector[i];
    known++;
  }
  return sessions && known / sessions >= STRESS_MIN_COVERAGE
    ? wealth - 1
    : null;
}

/** Worst 1 / 5 / 21-session compounded returns (sessions without a return dropped). */
function worstRollingWindows(valid) {
  if (!valid.length)
    return { WORST_DAY: null, WORST_WEEK: null, WORST_MONTH: null };
  const worstOver = (size) => {
    if (valid.length < size) return null;
    let product = valid.slice(0, size).reduce((acc, ret) => acc * (1 + ret), 1);
    let worst = product - 1;
    for (let i = size; i < valid.length; i++) {
      product = (product / (1 + valid[i - size])) * (1 + valid[i]);
      if (product - 1 < worst) worst = product - 1;
    }
    return worst;
  };
  return {
    WORST_DAY: Math.min(...valid),
    WORST_WEEK: worstOver(5),
    WORST_MONTH: worstOver(21),
  };
}

/** The benchmark's `count` worst sessions: { dates, avgLoss }. */
function extractBenchmarkTailCluster(vector, calendar, count) {
  if (!vector || !vector.length) return null;
  const sessions = vector
    .map((ret, i) => ({ date: calendar[i + 1], ret }))
    .filter((session) => session.ret !== null && !Number.isNaN(session.ret));
  sessions.sort((a, b) => a.ret - b.ret);
  const worst = sessions.slice(0, Math.min(count, sessions.length));
  if (!worst.length) return null;
  return {
    dates: new Set(worst.map((session) => session.date)),
    avgLoss: mean(worst.map((session) => session.ret)),
  };
}

/** Average return on the benchmark's worst sessions / the benchmark's average loss there (needs 5 of them). */
function tailCapture(vector, calendar, cluster, minOverlap = 5) {
  if (!cluster.avgLoss) return 0;
  let sum = 0;
  let matches = 0;
  for (let i = 0; i < vector.length; i++) {
    if (
      vector[i] === null ||
      Number.isNaN(vector[i]) ||
      !cluster.dates.has(calendar[i + 1])
    )
      continue;
    sum += vector[i];
    matches++;
  }
  return matches < minOverlap ? null : sum / matches / cluster.avgLoss;
}

/** Historical VaR (5th percentile, <= 0), ES (mean beyond it) and GaR (95th percentile). */
function tailMetrics(returns, confidence) {
  if (!returns.length) return { var: 0, es: 0, gar: 0 };
  const sorted = [...returns].sort((a, b) => a - b);
  const n = sorted.length;
  const varIndex = Math.min(Math.floor((1 - confidence) * n), n - 1);
  const tail = sorted.slice(0, varIndex + 1);
  return {
    var: sorted[varIndex],
    es: mean(tail),
    gar: sorted[Math.min(Math.floor(confidence * n), n - 1)],
  };
}

function rollingCompounded(valid, size) {
  const rolling = [];
  for (let i = size; i <= valid.length; i++)
    rolling.push(
      valid.slice(i - size, i).reduce((acc, ret) => acc * (1 + ret), 1) - 1,
    );
  return rolling;
}

function drawdowns(valid) {
  let [wealth, peak, max] = [1, 1, 0];
  for (const ret of valid) {
    wealth *= 1 + ret;
    if (wealth > peak) peak = wealth;
    max = Math.min(max, (wealth - peak) / peak);
  }
  return { max, current: (wealth - peak) / peak };
}

function downsideDeviation(returns) {
  if (returns.length < 2) return 0;
  return Math.sqrt(
    returns.reduce((acc, ret) => acc + Math.min(0, ret) ** 2, 0) /
      (returns.length - 1),
  );
}
