import crypto from "crypto";
import { utils } from "./utils.js";
import { importDatabase, query, replaceDataInDb, withSavepoint } from "./db.js";
import { loadFxRates, currencyConverter } from "./marketData.js";
import { ledger, OUTFLOW_TYPES } from "./ledger.js";
import { config } from "../config.js";
import { readLabelAttachments } from "./scrapeEmails.js";

// Securities valued at 1 per unit (same list as ledger.js)
const UNIT_VALUED = ["CASH", "DEBT", "CRYPTO"];

export const valuation = {
  run,
  runRoll,
  rollPortfolio,
  getRollStartDate,
  runBalance,
  runFile,
  runRecurringFlows,
  runCustom,
  runKraken,
  runCryptoCom,
  runAllianz,
  runTradeRepublic,
};

/**
 * Daily portfolio production: writes positions + nav for every portfolio that runs on targetDate,
 * dispatching on portfolios.valuation_method.
 * Migrated from runPortfolioProduction in // portfolioData.gs
 *
 * @param {Date|string} [targetDate=new Date()] - Valuation date
 * @param {Object} [options={}] - Optional filters, e.g. { runOnlyThisId: 'PROFOND' }
 * @returns {Promise<{valued: string[], skipped: string[], failed: string[]}>}
 */
export async function run(targetDate = new Date(), options = {}) {
  const dateStr = utils.formatDateToISO(targetDate);
  console.log(`[VALUATION] Starting portfolio valuation for ${dateStr}...`);

  await loadFxRates();
  const portfolios = await importDatabase("portfolios");
  const triggered = await getTriggeredPortfolios(dateStr);

  const summary = { valued: [], skipped: [], failed: [] };

  for (const portfolio of portfolios) {
    const portfolioId = portfolio.portfolio_id;
    if (options.runOnlyThisId && portfolioId !== options.runOnlyThisId)
      continue;

    // Runs on its own schedule, or off-schedule when something changed it today
    if (!isPortfolioActive(portfolio, dateStr)) continue;
    if (
      !utils.doesItRunToday(portfolio, dateStr) &&
      !triggered.has(portfolioId)
    )
      continue;

    try {
      let valued = false;
      switch (portfolio.valuation_method) {
        case "ROLL":
          valued = await runRoll(portfolio, dateStr);
          break;
        case "BALANCE":
          valued = await runBalance(portfolio, dateStr);
          break;
        case "FILE":
          valued = await runFile(portfolio, dateStr);
          break;
        case "RECURRING_FLOWS":
          valued = await runRecurringFlows(portfolio, dateStr);
          break;
        case "CUSTOM":
          valued = await runCustom(portfolio, dateStr);
          break;
        default:
          console.warn(
            `[VALUATION] ${portfolioId}: no valuation method (${portfolio.valuation_method}), skipping.`,
          );
      }
      (valued ? summary.valued : summary.skipped).push(portfolioId);
    } catch (error) {
      // GAS emailed "Portfolio X failed to run" and moved on to the next portfolio
      console.error(`[VALUATION] ${portfolioId} failed:`, error.message);
      summary.failed.push(portfolioId);
    }
  }

  console.log(
    `[VALUATION] Done for ${dateStr}: ${summary.valued.length} valued, ${summary.skipped.length} skipped, ` +
      `${summary.failed.length} failed.` +
      (summary.failed.length ? ` Failed: ${summary.failed.join(", ")}` : ""),
  );
  return summary;
}

/**
 * Portfolios that must be valued on dateStr even if it isn't their scheduled day, because their value changed:
 * - RECURRING_FLOWS: an instalment / one-off with eval_date = dateStr
 * - ROLL: an event for the portfolio dated dateStr (GAS getEvents: PORTFOLIO_ID + DATE)
 * TODO: backdate flags (GAS runStartDate) — not ported yet
 *
 * @param {string} dateStr - ISO date
 * @returns {Promise<Set<string>>} portfolio ids
 */
async function getTriggeredPortfolios(dateStr) {
  const { rows } = await query(
    `
    SELECT rf.portfolio_id
    FROM recurring_flows rf
    JOIN portfolios p ON p.portfolio_id = rf.portfolio_id
    WHERE p.valuation_method = 'RECURRING_FLOWS' AND rf.eval_date = $1
    UNION
    SELECT e.portfolio_id
    FROM events e
    JOIN portfolios p ON p.portfolio_id = e.portfolio_id
    WHERE p.valuation_method = 'ROLL' AND e.date = $1;`,
    [dateStr],
  );
  return new Set(rows.map((row) => row.portfolio_id));
}

/**
 * Positions of the portfolio on its latest valuation date on or before dateStr (empty array if none).
 * Migrated from getLatestPositionsForDate in // portfolioData.gs
 *
 * @param {string} portfolioId
 * @param {string} dateStr - ISO date
 * @returns {Promise<Array<Object>>} positions rows
 */
export async function getLatestPositionsForDate(portfolioId, dateStr) {
  const { rows } = await query(
    `
    SELECT * FROM positions
    WHERE portfolio_id = $1
      AND date = (SELECT max(date) FROM positions WHERE portfolio_id = $1 AND date <= $2);`,
    [portfolioId, dateStr],
  );
  return rows;
}

/**
 * True when inception_date <= date <= closed_date (closed_date NULL = still open).
 * Migrated from isPortfolioActive in // portfolioData.gs
 *
 * @param {Object} portfolio - Row from portfolios
 * @param {string} dateStr - ISO date
 * @returns {boolean}
 */
export function isPortfolioActive(portfolio, dateStr) {
  const inception = utils.formatDateToISO(portfolio.inception_date);
  const closed = portfolio.closed_date
    ? utils.formatDateToISO(portfolio.closed_date)
    : null;
  return inception <= dateStr && (!closed || dateStr <= closed);
}

/**
 * ROLL: rolls the portfolio from its start date (getRollStartDate, or options.startDate) to dateStr.
 * Migrated from rollPositions in // portfolioData.gs
 *
 * @param {Object} portfolio - Row from portfolios
 * @param {string} dateStr - ISO date
 * @param {{startDate?: string}} [options]
 * @returns {Promise<boolean>} true if positions/nav were written
 */
export async function runRoll(portfolio, dateStr, options = {}) {
  const startDate =
    options.startDate ?? (await getRollStartDate(portfolio, dateStr));
  const { navRows } = await rollPortfolio(portfolio, startDate, dateStr);
  return navRows.length > 0;
}

/**
 * Where a roll has to start, derived from the data (no flags to set or clear; GAS: runStartDate / priceRevisionDate
 * Script Properties). Normally the day after the latest nav. Earlier when something that portfolio depends on was
 * written after its last run (max nav.created_at) with a date in the already-valued past:
 * - its ledger rows (late events, CSV imports, corrections)
 * - prices of securities it held from that date on (GAS: a historical price broadcast "who holds me?")
 * - fx rates involving the currency of a security it held from that date on
 * Rows deleted since the last run leave no trace: a correction by delete + re-insert is picked up by the re-insert.
 *
 * @param {Object} portfolio - Row from portfolios
 * @param {string} dateStr - ISO date of the run
 * @returns {Promise<string>} ISO date
 */
export async function getRollStartDate(portfolio, dateStr) {
  const portfolioId = portfolio.portfolio_id;
  const { rows } = await query(
    `SELECT max(date)::text AS last_date FROM nav WHERE portfolio_id = $1 AND date <= $2;`,
    [portfolioId, dateStr],
  );
  const lastDate = rows[0].last_date;
  if (!lastDate) return utils.formatDateToISO(portfolio.inception_date);

  // last_run stays in SQL: timestamps have microseconds, a JS Date would round them to milliseconds and make rows
  // written in the same transaction as the last nav look newer than it
  const { rows: changed } = await query(
    `
    WITH last AS (SELECT max(created_at) AS run FROM nav WHERE portfolio_id = $1 AND date <= $2)
    SELECT least(
      (SELECT min(date) FROM transactions WHERE portfolio_id = $1 AND created_at > (SELECT run FROM last) AND date <= $2),
      (SELECT min(date) FROM capital_flows WHERE portfolio_id = $1 AND created_at > (SELECT run FROM last) AND date <= $2),
      (SELECT min(p.date) FROM prices p WHERE p.created_at > (SELECT run FROM last) AND p.date <= $2
         AND EXISTS (SELECT 1 FROM positions pos WHERE pos.portfolio_id = $1 AND pos.security_id = p.security_id AND pos.date >= p.date)),
      (SELECT min(f.date) FROM fx_rates f WHERE f.created_at > (SELECT run FROM last) AND f.date <= $2
         AND EXISTS (SELECT 1 FROM positions pos JOIN security_master s USING (security_id)
                     WHERE pos.portfolio_id = $1 AND pos.date >= f.date AND s.currency IN (f.base_currency, f.quote_currency)))
    )::text AS changed_from;`,
    [portfolioId, lastDate],
  );
  const changedFrom = changed[0].changed_from;
  const startDate = [utils.addDays(lastDate, 1), changedFrom]
    .filter(Boolean)
    .sort()[0];
  if (changedFrom)
    console.log(
      `[VALUATION] ${portfolioId}: changes written since the last run back to ${changedFrom}, re-rolling from there.`,
    );
  return startDate > dateStr ? dateStr : startDate;
}

/**
 * Rebuilds positions + nav day by day: the positions of the day before startDate, then for every valuation day
 * (portfolio frequency, daily when it has none, plus every day with ledger activity) that day's capital flows
 * (inflows +, outflows -) and transactions (security +/- quantity, counter currency cash -/+ market_value_local, fee
 * out of the fee currency), repriced at the latest price on or before the day and that day's fx.
 * Differences from GAS: the fee comes out as `fee` (fee currency; GAS subtracted fee_value_base, portfolio currency);
 * a negative quantity is a warning (GAS stopped the roll); a missing price values the position at 0 with a warning;
 * the whole window is written at once.
 * Migrated from reconstructMarketValues in // portfolioData.gs
 *
 * @param {Object} portfolio - Row from portfolios
 * @param {string} startDate - ISO date, first day rolled
 * @param {string} stopDate - ISO date, last day rolled
 * @param {{write?: boolean}} [options] - write: false only returns the rows (QC)
 * @returns {Promise<{positionRows: Object[], navRows: Object[], warnings: string[]}>}
 */
export async function rollPortfolio(
  portfolio,
  startDate,
  stopDate,
  { write = true } = {},
) {
  const portfolioId = portfolio.portfolio_id;
  const inception = utils.formatDateToISO(portfolio.inception_date);
  const closed = portfolio.closed_date
    ? utils.formatDateToISO(portfolio.closed_date)
    : null;
  if (startDate < inception) startDate = inception;
  if (closed && stopDate > closed) stopDate = closed;

  const quantities = new Map();
  for (const position of await getLatestPositionsForDate(
    portfolioId,
    utils.addDays(startDate, -1),
  )) {
    quantities.set(position.security_id, Number(position.quantity));
  }

  // The window's ledger, by day; counter / fee currencies become their cash securities
  const { rows: flows } = await query(
    `SELECT date::text AS date, security_id, capital_flow_type, quantity FROM capital_flows
     WHERE portfolio_id = $1 AND date BETWEEN $2 AND $3;`,
    [portfolioId, startDate, stopDate],
  );
  const { rows: transactions } = await query(
    `SELECT date::text AS date, security_id, transaction_type, quantity, counter_currency, market_value_local, fee_currency, fee
     FROM transactions WHERE portfolio_id = $1 AND date BETWEEN $2 AND $3;`,
    [portfolioId, startDate, stopDate],
  );
  const movesByDay = new Map();
  const move = (date, securityId, quantity) =>
    (movesByDay.get(date) ?? movesByDay.set(date, []).get(date)).push([
      securityId,
      Number(quantity),
    ]);
  for (const flow of flows)
    move(
      flow.date,
      flow.security_id,
      OUTFLOW_TYPES.includes(flow.capital_flow_type)
        ? -flow.quantity
        : flow.quantity,
    );
  for (const tx of transactions) {
    const sign = tx.transaction_type === "BUY" ? 1 : -1;
    move(tx.date, tx.security_id, sign * tx.quantity);
    move(
      tx.date,
      await ledger.cashSecurityFor(tx.counter_currency),
      -sign * tx.market_value_local,
    );
    if (Number(tx.fee))
      move(tx.date, await ledger.cashSecurityFor(tx.fee_currency), -tx.fee);
  }

  // Prices of every security the window can hold, loaded once (latest on or before a day = last entry <= day)
  const securityIds = [
    ...new Set([
      ...quantities.keys(),
      ...[...movesByDay.values()].flat().map(([securityId]) => securityId),
    ]),
  ];
  const { rows: priceRows } = await query(
    `SELECT security_id, date::text AS date, price FROM prices WHERE security_id = ANY($1) AND date <= $2 ORDER BY security_id, date;`,
    [securityIds, stopDate],
  );
  const priceSeries = new Map();
  for (const row of priceRows)
    (
      priceSeries.get(row.security_id) ??
      priceSeries.set(row.security_id, []).get(row.security_id)
    ).push([row.date, Number(row.price)]);
  // Before a security's first price (bought before it is quoted, e.g. a structured product on its issue day): the
  // portfolio's own trade price, not 0 (DIRECTA 2024-02-15: nav 5,000 -> 110.90 -> 5,009 the day after)
  const { rows: tradePriceRows } = await query(
    `SELECT security_id, date::text AS date, transaction_price FROM transactions
     WHERE portfolio_id = $1 AND date <= $2 AND transaction_price IS NOT NULL ORDER BY security_id, date, transaction_id;`,
    [portfolioId, stopDate],
  );
  const tradePriceSeries = new Map();
  for (const row of tradePriceRows)
    (
      tradePriceSeries.get(row.security_id) ??
      tradePriceSeries.set(row.security_id, []).get(row.security_id)
    ).push([row.date, Number(row.transaction_price)]);
  const latestOn = (series, date) => {
    let low = 0;
    let high = series.length - 1;
    let found = null;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (series[mid][0] <= date) {
        found = series[mid][1];
        low = mid + 1;
      } else high = mid - 1;
    }
    return found;
  };
  const warnings = [];
  const priceOn = async (securityId, date) => {
    if (UNIT_VALUED.includes((await ledger.getSecurity(securityId)).asset_type))
      return 1;
    const found =
      latestOn(priceSeries.get(securityId) ?? [], date) ??
      latestOn(tradePriceSeries.get(securityId) ?? [], date);
    if (found === null)
      warnings.push(
        `${date} ${securityId}: no price on or before, valued at 0`,
      );
    return found ?? 0;
  };

  const positionRows = [];
  const navRows = [];
  for (let date = startDate; date <= stopDate; date = utils.addDays(date, 1)) {
    const moves = movesByDay.get(date) ?? [];
    for (const [securityId, quantity] of moves)
      quantities.set(securityId, (quantities.get(securityId) ?? 0) + quantity);
    if (
      moves.length === 0 &&
      portfolio.valuation_frequency &&
      !utils.doesItRunToday(portfolio, date)
    )
      continue;

    const positions = [];
    for (const [securityId, quantity] of quantities) {
      if (Math.abs(quantity) < 1e-4) {
        quantities.delete(securityId);
        continue;
      }
      if (quantity < 0)
        warnings.push(`${date} ${securityId}: negative quantity ${quantity}`);
      positions.push({
        security_id: securityId,
        quantity,
        price: await priceOn(securityId, date),
      });
    }
    const { rows, nav } = await buildPortfolioRows(portfolio, positions, date);
    positionRows.push(...rows);
    navRows.push(nav);
  }

  if (write && navRows.length > 0)
    await writePositionsAndNav(positionRows, navRows);
  console.log(
    `[VALUATION] ${portfolioId}: rolled ${navRows.length} day(s) ${startDate} -> ${stopDate}` +
      (warnings.length ? `, ${warnings.length} warning(s)` : "") +
      ".",
  );
  return { positionRows, navRows, warnings };
}

/**
 * BALANCE: one-line portfolio holding portfolios.balance in base-currency cash.
 * GAS emailed and rolled previous positions on a zero balance (and crashed on a typo in that branch);
 * here a missing/zero balance is skipped with a warning.
 * Migrated from runBalance in // portfolioData.gs
 *
 * @param {Object} portfolio - Row from portfolios
 * @param {string} dateStr - ISO date
 * @returns {Promise<boolean>} true if positions/nav were written
 */
export async function runBalance(portfolio, dateStr) {
  const balance = Number(portfolio.balance);
  if (!balance) {
    console.warn(
      `[VALUATION] ${portfolio.portfolio_id}: missing or zero balance (${portfolio.balance}), skipping.`,
    );
    return false;
  }
  return runOneLinePortfolio(
    portfolio,
    `CASH_${portfolio.currency}`,
    1,
    balance,
    dateStr,
  );
}

/**
 * FILE: one-line portfolio holding the balance of the latest BALANCE event on or before the date. The events come
 * from the bank / card emails (scrapeEmails); the security is the event's (DEBT_EUR for AMEX) or base-currency cash.
 * GAS read the latest Google Doc saved from Gmail and regex'd the number out of it at valuation time.
 * Migrated from createandRunBalanceFromFile in // portfolioData.gs
 *
 * @param {Object} portfolio - Row from portfolios
 * @param {string} dateStr - ISO date
 * @returns {Promise<boolean>} true if positions/nav were written
 */
export async function runFile(portfolio, dateStr) {
  const { rows } = await query(
    `
    SELECT quantity, security_id FROM events
    WHERE portfolio_id = $1 AND event_type = 'BALANCE' AND date <= $2
    ORDER BY date DESC, event_id DESC
    LIMIT 1;`,
    [portfolio.portfolio_id, dateStr],
  );
  if (rows.length === 0)
    throw new Error(`no BALANCE event on or before ${dateStr}`);

  const securityId = rows[0].security_id ?? `CASH_${portfolio.currency}`;
  return runOneLinePortfolio(
    portfolio,
    securityId,
    1,
    Number(rows[0].quantity),
    dateStr,
  );
}

/**
 * RECURRING_FLOWS: one-line portfolio = sum of the latest outstanding amount per payment (eval_date <= date, within
 * start_date <= date < end_date), held in the rows' security (DEBT_EUR for loans, CASH_EUR for receivables).
 * No rows (e.g. EXTRA_LIQUID) -> zero balance in base-currency cash, like GAS.
 * Only valuation: the payment flows GAS wrote on the eval date belong to events (not ported yet).
 * Migrated from runRecurringFlows in // portfolioData.gs
 *
 * @param {Object} portfolio - Row from portfolios
 * @param {string} dateStr - ISO date
 * @returns {Promise<boolean>} true if positions/nav were written
 */
export async function runRecurringFlows(portfolio, dateStr) {
  const portfolioId = portfolio.portfolio_id;

  // Per active payment: the outstanding of its latest row on or before the date; before its first eval_date the
  // whole total_amount (a loan received / a receivable promised, nothing paid yet)
  const { rows } = await query(
    `
    SELECT DISTINCT ON (rf.payment_desc)
      rf.payment_desc, rf.security_id, sm.currency,
      CASE WHEN rf.eval_date <= $2 THEN rf.outstanding_amount ELSE rf.total_amount END AS outstanding_amount
    FROM recurring_flows rf
    JOIN security_master sm ON sm.security_id = rf.security_id
    WHERE rf.portfolio_id = $1
      AND rf.start_date <= $2 AND $2 < rf.end_date
    ORDER BY rf.payment_desc, (rf.eval_date <= $2) DESC, rf.eval_date DESC;`,
    [portfolioId, dateStr],
  );

  if (rows.length === 0) {
    return runOneLinePortfolio(
      portfolio,
      `CASH_${portfolio.currency}`,
      1,
      0,
      dateStr,
    );
  }

  // One-liner: all payments must share one security in the portfolio currency (true for every portfolio today)
  const securityIds = [...new Set(rows.map((row) => row.security_id))];
  if (securityIds.length > 1 || rows[0].currency !== portfolio.currency) {
    throw new Error(
      `mixed securities or currencies not supported (${securityIds.join(", ")} vs portfolio ${portfolio.currency})`,
    );
  }

  const totalOutstanding = rows.reduce(
    (sum, row) => sum + Number(row.outstanding_amount),
    0,
  );
  return runOneLinePortfolio(
    portfolio,
    securityIds[0],
    1,
    totalOutstanding,
    dateStr,
  );
}

/**
 * CUSTOM: per-portfolio integrations. KRAKEN (API), CRYPTO_COM and TRADE_REPUBLIC (CSV by email), ALLIANZ (xls export
 * by email) are ported; UNREALIZED_TAX is valued by taxes.run after valuation (it needs today's positions of every
 * other portfolio); IBKR is closed.
 * Migrated from runCustomPortfolio in // portfolioData.gs
 *
 * @returns {Promise<boolean>} true if positions/nav were written
 */
export async function runCustom(portfolio, dateStr) {
  switch (portfolio.portfolio_id) {
    case "KRAKEN":
      return runKraken(portfolio, dateStr);
    case "CRYPTO_COM":
      return runCryptoCom(portfolio, dateStr);
    case "ALLIANZ":
      return runAllianz(portfolio, dateStr);
    case "TRADE_REPUBLIC":
      return runTradeRepublic(portfolio, dateStr);
    case "UNREALIZED_TAX":
    case "REALIZED_TAX":
      console.log(`[VALUATION] ${portfolio.portfolio_id}: valued by taxes.run after valuation.`);
      return false;
    default:
      console.warn(
        `[VALUATION] ${portfolio.portfolio_id}: CUSTOM not migrated yet, skipping.`,
      );
      return false;
  }
}

/**
 * KRAKEN: syncs the Kraken ledger into transactions / capital flows (source KRAKEN), then values today's positions
 * from the live balance (one line per asset, price 1 per unit). The balance only exists "now": for a past date
 * the ledger is synced but no positions are written.
 * Everything Kraken (asset codes, signed API calls, ledger sync) lives inside this function.
 * Migrated from runKraken in // portfolioData.gs
 *
 * @param {Object} portfolio - Row from portfolios
 * @param {string} dateStr - ISO date
 * @returns {Promise<boolean>} true if positions/nav were written
 */
export async function runKraken(portfolio, dateStr) {
  // Kraken's legacy asset codes (X / Z prefixed) -> engine currency codes. Explicit list: stripping any leading X/Z
  // (GAS) would break real tickers like XAUT.
  const KRAKEN_LEGACY_ASSETS = {
    XXBT: "BTC",
    XBT: "BTC",
    XETH: "ETH",
    XLTC: "LTC",
    XXRP: "XRP",
    XXLM: "XLM",
    XXMR: "XMR",
    XZEC: "ZEC",
    XXDG: "DOGE",
    XDG: "DOGE",
    XETC: "ETC",
    XMLN: "MLN",
    XREP: "REP",
    ZEUR: "EUR",
    ZUSD: "USD",
    ZGBP: "GBP",
    ZCAD: "CAD",
    ZJPY: "JPY",
  };

  // Ledger entries that only move money between Kraken wallets (spot <-> staking / earn): not flows
  const KRAKEN_INTERNAL_SUBTYPES = [
    "spottostaking",
    "stakingfromspot",
    "stakingtospot",
    "spotfromstaking",
    "spendpoint",
    "allocation",
    "deallocation",
    "autoallocation",
    "migration",
  ];

  await syncKrakenLedger(portfolio, dateStr);

  if (dateStr !== utils.formatDateToISO(new Date())) {
    console.warn(
      `[VALUATION] KRAKEN: balance is only available for today, no positions written for ${dateStr}.`,
    );
    return false;
  }

  const balances = await callKrakenPrivate("/0/private/Balance");
  const quantities = {};
  for (const [asset, amount] of Object.entries(balances)) {
    if (Number(amount) <= 0) continue;
    const code = normalizeKrakenAsset(asset);
    quantities[code] = (quantities[code] ?? 0) + Number(amount);
  }

  const positions = [];
  for (const [code, quantity] of Object.entries(quantities)) {
    positions.push({
      security_id: await ledger.cashSecurityFor(code),
      quantity,
      price: 1,
    });
  }
  return runGenericPortfolio(portfolio, positions, dateStr);

  /** Kraken asset -> engine currency code: staking variants (ETH2.S, DOT.S, SOL.F...) collapse into the asset. */
  function normalizeKrakenAsset(asset) {
    const withoutVariant = asset.replace(/\.(S|F|M|B|P)$/, "");
    const code = KRAKEN_LEGACY_ASSETS[withoutVariant] ?? withoutVariant;
    return code === "ETH2" ? "ETH" : code;
  }

  /**
   * Signed call to a Kraken private endpoint: API-Sign = base64(HMAC-SHA512(base64-decoded secret,
   * path + SHA256(nonce + body))). No retry: a retried request would reuse a spent nonce.
   * Migrated from callKrakenPrivateEndpoint in // portfolioData.gs
   */
  async function callKrakenPrivate(path, params = {}) {
    if (!config.krakenApiKey || !config.krakenPrivateKey)
      throw new Error("KRAKEN_API_KEY / KRAKEN_PRIVATE_KEY not set");
    const nonce = String(Date.now() * 1000);
    const body = new URLSearchParams({ nonce, ...params }).toString();
    const sha256 = crypto
      .createHash("sha256")
      .update(nonce + body)
      .digest();
    const signature = crypto
      .createHmac("sha512", Buffer.from(config.krakenPrivateKey, "base64"))
      .update(Buffer.concat([Buffer.from(path), sha256]))
      .digest("base64");

    const response = await fetch(`https://api.kraken.com${path}`, {
      method: "POST",
      headers: {
        "API-Key": config.krakenApiKey,
        "API-Sign": signature,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    const json = await response.json();
    if (json.error?.length)
      throw new Error(`Kraken ${path}: ${json.error.join(", ")}`);
    return json.result;
  }

  /**
   * Writes the Kraken ledger entries not saved yet, from the day of the last saved Kraken row (all of them the first
   * time): no fixed lookback window (GAS: 5 days), duplicates skipped on external_id (the Kraken id, unhashed).
   * - trade legs grouped by refid -> one transaction: BUY of the crypto received, or SELL of the crypto given when
   *   the other side is fiat; each leg's fee stays in the asset Kraken charged it in
   * - deposit / withdrawal -> CASHIN / CASHOUT for fiat and stablecoins, ASSETIN / ASSETOUT for other crypto
   * - staking / dividend -> STAKING, earn -> EARN, anything else -> REWARDS; internal wallet moves skipped
   * - flow quantities are net of Kraken's fee (amount - fee: what the balance actually gets; GAS used the gross)
   */
  async function syncKrakenLedger(portfolio, dateStr) {
    const portfolioId = portfolio.portfolio_id;
    const { rows: saved } = await query(
      `
      SELECT external_id, date FROM transactions WHERE source = 'KRAKEN' AND portfolio_id = $1
      UNION ALL
      SELECT external_id, date FROM capital_flows WHERE source = 'KRAKEN' AND portfolio_id = $1;`,
      [portfolioId],
    );
    const savedIds = new Set(saved.map((row) => row.external_id));
    const lastDate = saved.length
      ? utils.formatDateToISO(
          new Date(Math.max(...saved.map((row) => new Date(row.date)))),
        )
      : null;
    const startDay = new Date(
      `${lastDate ?? utils.formatDateToISO(portfolio.inception_date)}T00:00:00Z`,
    );
    startDay.setUTCDate(startDay.getUTCDate() - 1);

    // All pages since startDay (Kraken returns 50 per page; pause between pages for the API rate limit)
    const entries = [];
    for (let offset = 0, total = 1; offset < total; offset += 50) {
      if (offset > 0) await new Promise((resolve) => setTimeout(resolve, 2500));
      const page = await callKrakenPrivate("/0/private/Ledgers", {
        start: String(startDay.getTime() / 1000),
        ofs: String(offset),
      });
      total = page.count;
      entries.push(
        ...Object.entries(page.ledger).map(([id, entry]) => ({ id, ...entry })),
      );
    }

    const { rows: currencyRows } = await query(
      `SELECT currency_code, type FROM currencies;`,
    );
    const currencyTypes = new Map(
      currencyRows.map((row) => [row.currency_code, row.type]),
    );
    const isCashLike = (code) =>
      ["FIAT", "STABLECOIN"].includes(currencyTypes.get(code));

    const trades = {};
    let written = 0;
    for (const entry of entries) {
      const entryDate = utils.formatDateToISO(new Date(entry.time * 1000));
      if (entryDate > dateStr) continue;
      const code = normalizeKrakenAsset(entry.asset);
      const amount = Number(entry.amount);
      const fee = Number(entry.fee ?? 0);

      if (entry.type === "trade") {
        (trades[entry.refid] ??= []).push({
          code,
          amount,
          fee,
          date: entryDate,
        });
        continue;
      }
      if (
        entry.type === "transfer" ||
        KRAKEN_INTERNAL_SUBTYPES.includes(entry.subtype) ||
        savedIds.has(entry.id)
      )
        continue;

      let flowType = "REWARDS";
      if (entry.type === "deposit")
        flowType = isCashLike(code) ? "CASHIN" : "ASSETIN";
      else if (entry.type === "withdrawal")
        flowType = isCashLike(code) ? "CASHOUT" : "ASSETOUT";
      else if (entry.type === "staking" || entry.type === "dividend")
        flowType = "STAKING";
      else if (entry.type === "earn") flowType = "EARN";

      await ledger.addCapitalFlow({
        date: entryDate,
        portfolio_id: portfolioId,
        capital_flow_type: flowType,
        security_id: await ledger.cashSecurityFor(code),
        quantity: Math.abs(amount) - fee,
        source: "KRAKEN",
        external_id: entry.id,
      });
      written++;
    }

    for (const [refid, legs] of Object.entries(trades)) {
      if (savedIds.has(refid)) continue;
      const received = legs.find((leg) => leg.amount > 0);
      const given = legs.find((leg) => leg.amount < 0);
      if (legs.length !== 2 || !received || !given) {
        console.warn(
          `[VALUATION] KRAKEN: trade ${refid} has unbalanced legs, skipped.`,
        );
        continue;
      }

      // Instrument = the crypto side; with fiat on one side, a crypto given away is a SELL
      const isSell =
        currencyTypes.get(received.code) === "FIAT" &&
        currencyTypes.get(given.code) !== "FIAT";
      const asset = isSell ? given : received;
      const counter = isSell ? received : given;
      const quantity = Math.abs(asset.amount);
      const counterValue = Math.abs(counter.amount);
      const feeLeg = given.fee > 0 ? given : received;

      await ledger.addTransaction({
        date: received.date,
        portfolio_id: portfolioId,
        security_id: await ledger.cashSecurityFor(asset.code),
        transaction_type: isSell ? "SELL" : "BUY",
        quantity,
        fee:
          given.fee > 0 && received.fee > 0
            ? given.fee + (received.fee * counterValue) / quantity
            : feeLeg.fee,
        fee_currency:
          given.fee > 0 && received.fee > 0 ? given.code : feeLeg.code,
        counter_currency: counter.code,
        market_value_local: counterValue,
        source: "KRAKEN",
        external_id: refid,
      });
      written++;
    }

    console.log(
      `[VALUATION] KRAKEN: ${entries.length} ledger entries since ${utils.formatDateToISO(startDay)}, ${written} new rows written.`,
    );
  }
}

/**
 * CRYPTO_COM (the App: no API). The CSV export is emailed to Gmail (label cryptocom); every run:
 * 1. imports the CSV rows not saved yet into transactions / capital flows (source CRYPTO_COM, external_id = hash of
 *    the row, so overlapping exports never duplicate). Rows up to the last GAS-imported day are skipped (history)
 * 2. values every day from the first new ledger row (or the first day without nav) to dateStr: holdings from the
 *    whole ledger (ledger.getLedgerHoldings), price 1 per unit, that day's fx
 * Between exports the holdings are the last known ones, repriced daily (only the newest cashback is missing).
 * Everything Crypto.com (transaction kinds, CSV import and parsing) lives inside this function.
 * Migrated from runCryptoCom in // portfolioData.gs
 *
 * @returns {Promise<boolean>} true if positions/nav were written for dateStr
 */
export async function runCryptoCom(portfolio, dateStr) {
  // Crypto.com App "Transaction Kind" -> what it is in the ledger. IN / OUT = deposit / withdrawal (CASHIN / CASHOUT for
  // fiat and stablecoins, ASSETIN / ASSETOUT for other crypto, like Kraken); TRANSACTION = a swap; SKIP = moves inside
  // the app (limit-order locks, CRO moved into / out of the card stake). An unknown kind stops the import.
  const CRYPTO_COM_KINDS = {
    referral_card_cashback: "REWARDS",
    rewards_platform_deposit_credited: "REWARDS",
    referral_gift: "REWARDS",
    reimbursement: "REWARDS",
    "finance.crypto_earn.loyalty_program_extra_interest_paid.crypto_wallet":
      "REWARDS",
    "reward.loyalty_program.trading_rebate.crypto_wallet": "REWARDS",
    crypto_earn_interest_paid: "INTEREST",
    "finance.dpos.non_compound_interest.crypto_wallet": "STAKING",
    "finance.lockup.dpos_non_compound_interest.crypto_wallet": "STAKING",
    "finance.lockup.dpos_compound_interest.crypto_wallet": "STAKING",
    crypto_deposit: "IN",
    exchange_to_crypto_transfer: "IN",
    dust_conversion_credited: "IN",
    crypto_withdrawal: "OUT",
    crypto_to_exchange_transfer: "OUT",
    dust_conversion_debited: "OUT",
    card_cashback_reverted: "OUT",
    reimbursement_reverted: "OUT",
    crypto_exchange: "TRANSACTION",
    viban_purchase: "TRANSACTION",
    "trading.limit_order.cash_account.purchase_commit": "TRANSACTION",
    "trading.limit_order.cash_account.purchase_lock": "SKIP",
    "trading.limit_order.cash_account.purchase_unlock": "SKIP",
    "finance.lockup.dpos_lock_upgrade.crypto_wallet": "SKIP",
    "finance.dpos.staking.crypto_wallet": "SKIP",
  };

  const portfolioId = portfolio.portfolio_id;
  const firstNewDate = await importCryptoComCsv(portfolio, dateStr);

  const { rows } = await query(
    `SELECT max(date)::text AS last_nav FROM nav WHERE portfolio_id = $1 AND date <= $2;`,
    [portfolioId, dateStr],
  );
  const dayAfterLastNav = rows[0].last_nav
    ? utils.addDays(rows[0].last_nav, 1)
    : utils.formatDateToISO(portfolio.inception_date);
  const startDate = [firstNewDate, dayAfterLastNav, dateStr]
    .filter(Boolean)
    .sort()[0];

  let days = 0;
  for (let date = startDate; date <= dateStr; date = utils.addDays(date, 1)) {
    const holdings = await ledger.getLedgerHoldings(portfolioId, date);
    const positions = [...holdings]
      .filter(([, quantity]) => quantity > 0)
      .map(([security_id, quantity]) => ({ security_id, quantity, price: 1 }));
    if (positions.length === 0) continue;
    await runGenericPortfolio(portfolio, positions, date);
    days++;
  }
  console.log(
    `[VALUATION] CRYPTO_COM: valued ${days} day(s) from ${startDate} to ${dateStr}.`,
  );
  return days > 0;

  /** Imports the new rows of the Crypto.com CSVs in Gmail; returns the earliest date written (null if none). */
  async function importCryptoComCsv(portfolio, dateStr) {
    const portfolioId = portfolio.portfolio_id;
    let files;
    try {
      files = await readLabelAttachments("cryptocom", /\.csv$/i);
    } catch (error) {
      console.warn(
        `[VALUATION] CRYPTO_COM: Gmail read failed (${error.message}), valuing the ledger already saved.`,
      );
      return null;
    }

    const { rows: saved } = await query(
      `SELECT external_id FROM transactions WHERE source = 'CRYPTO_COM' AND portfolio_id = $1
       UNION ALL
       SELECT external_id FROM capital_flows WHERE source = 'CRYPTO_COM' AND portfolio_id = $1;`,
      [portfolioId],
    );
    const savedIds = new Set(saved.map((row) => row.external_id));
    const { rows: gas } = await query(
      `SELECT max(date)::text AS last_date FROM (
         SELECT date FROM transactions WHERE source = 'GAS' AND portfolio_id = $1
         UNION ALL SELECT date FROM capital_flows WHERE source = 'GAS' AND portfolio_id = $1) ledger;`,
      [portfolioId],
    );
    const historyUntil = gas[0].last_date ?? "";
    const { rows: currencyRows } = await query(
      `SELECT currency_code, type FROM currencies;`,
    );
    const currencyTypes = new Map(
      currencyRows.map((row) => [row.currency_code, row.type]),
    );
    const isCashLike = (code) =>
      ["FIAT", "STABLECOIN"].includes(currencyTypes.get(code));

    let firstNewDate = null;
    let written = 0;
    for (const file of files) {
      for (const row of utils.parseCsv(file.content.toString("utf-8"))) {
        const kind = CRYPTO_COM_KINDS[row["Transaction Kind"]];
        if (!kind)
          throw new Error(
            `CRYPTO_COM: unknown Transaction Kind "${row["Transaction Kind"]}" (${file.filename}), add it to CRYPTO_COM_KINDS`,
          );
        if (kind === "SKIP") continue;

        const date = utils.formatDateToISO(
          new Date(`${row["Timestamp (UTC)"].replace(" ", "T")}Z`),
        );
        const externalId = crypto
          .createHash("sha1")
          .update(
            [
              row["Timestamp (UTC)"],
              row["Transaction Kind"],
              row.Currency,
              row.Amount,
              row["To Currency"],
              row["To Amount"],
            ].join("|"),
          )
          .digest("hex");
        if (date <= historyUntil || date > dateStr || savedIds.has(externalId))
          continue;
        savedIds.add(externalId);

        const amount = Math.abs(Number(row.Amount));
        const common = {
          date,
          portfolio_id: portfolioId,
          source: "CRYPTO_COM",
          external_id: externalId,
        };
        if (kind === "TRANSACTION") {
          // Instrument = the crypto side (like Kraken): fiat given -> BUY of the crypto received (the fiat lands in the
          // app first: CASHIN), otherwise SELL of the crypto given for the To Currency
          const toAmount = Math.abs(Number(row["To Amount"]));
          if (currencyTypes.get(row.Currency) === "FIAT") {
            await ledger.addCapitalFlow({
              ...common,
              external_id: `${externalId}:cashin`,
              capital_flow_type: "CASHIN",
              security_id: await ledger.cashSecurityFor(row.Currency),
              quantity: amount,
            });
            await ledger.addTransaction({
              ...common,
              transaction_type: "BUY",
              security_id: await ledger.cashSecurityFor(row["To Currency"]),
              quantity: toAmount,
              counter_currency: row.Currency,
              market_value_local: amount,
            });
          } else {
            await ledger.addTransaction({
              ...common,
              transaction_type: "SELL",
              security_id: await ledger.cashSecurityFor(row.Currency),
              quantity: amount,
              counter_currency: row["To Currency"],
              market_value_local: toAmount,
            });
          }
        } else {
          let flowType = kind;
          if (kind === "IN")
            flowType = isCashLike(row.Currency) ? "CASHIN" : "ASSETIN";
          if (kind === "OUT")
            flowType = isCashLike(row.Currency) ? "CASHOUT" : "ASSETOUT";
          await ledger.addCapitalFlow({
            ...common,
            capital_flow_type: flowType,
            security_id: await ledger.cashSecurityFor(row.Currency),
            quantity: amount,
          });
        }
        written++;
        if (!firstNewDate || date < firstNewDate) firstNewDate = date;
      }
    }
    console.log(
      `[VALUATION] CRYPTO_COM: ${files.length} CSV file(s), ${written} new row(s) written (history until ${historyUntil || "-"}).`,
    );
    return firstNewDate;
  }
}

/**
 * ALLIANZ (pension fund, no API): the full contributions export ("export.xls", from the Allianz site) is emailed to
 * Gmail, label allianz. Every run imports the rows not saved yet (importAllianzExport), then rolls the portfolio
 * (the created_at trigger re-rolls from the first new row). Replaces the hand-typed PENSION_CONTRIBUTION events.
 * Everything Allianz (fund names, export import) lives inside this function.
 * Migrated from processPensionContribution in // eventsProcessing.gs
 *
 * @returns {Promise<boolean>} true if positions/nav were written
 */
export async function runAllianz(portfolio, dateStr) {
  // Allianz "Linea" -> security_id
  const ALLIANZ_FUNDS = {
    "LINEA AZIONARIA": "ALLIANZ_AZIONARIA",
    "LINEA BILANCIATA": "ALLIANZ_BILANCIATA",
    "LINEA MULTIASSET": "ALLIANZ_MULTIASSET",
    "LINEA OBBLIGAZIONARIA LUNGO TERMINE": "ALLIANZ_OBBLT",
    "LINEA OBBLIGAZIONARIA BREVE TERMINE": "ALLIANZ_OBBST",
    "LINEA FLESSIBILE": "ALLIANZ_FLESSIBILE",
  };

  try {
    for (const file of await readLabelAttachments("allianz", /\.xls$/i))
      await importAllianzExport(
        portfolio,
        file.content,
        dateStr,
        file.filename,
      );
  } catch (error) {
    console.warn(
      `[VALUATION] ALLIANZ: Gmail read failed (${error.message}), valuing the ledger already saved.`,
    );
  }
  return runRoll(portfolio, dateStr);

  /**
   * Imports one Allianz export into the ledger. Per investment date (Data Valuta, up to dateStr): one CASHIN of the day's
   * total (employer + employee + TFR) and one BUY per fund (units summed, price = Valore Quota, the same for every row of
   * a fund and date), source ALLIANZ, external_id "<date>:cashin" / "<date>:<fund>" so re-imports never duplicate. The
   * unit prices also go to prices (official, they win over Yahoo on those days). Files that aren't Allianz exports
   * (another site's export.xls) are skipped by their header.
   *
   * @param {Object} portfolio - Row from portfolios
   * @param {Buffer} content - The .xls file
   * @param {string} dateStr - ISO date, last investment date imported
   * @param {string} [filename]
   * @returns {Promise<number>} rows written
   */
  async function importAllianzExport(
    portfolio,
    content,
    dateStr,
    filename = "export.xls",
  ) {
    const portfolioId = portfolio.portfolio_id;
    const [header, ...rows] = Object.values(utils.readXls(content))[0] ?? [];
    const col = (name) => header?.indexOf(name) ?? -1;
    const [valueDate, kind, amount, line, units, unitPrice] = [
      "Data Valuta",
      "Tipologia",
      "Importo",
      "Linea",
      "Numero Quote",
      "Valore Quota",
    ].map(col);
    if ([valueDate, kind, amount, line, units, unitPrice].includes(-1)) {
      console.warn(
        `[VALUATION] ALLIANZ: ${filename} is not an Allianz export (header ${JSON.stringify(header)}), skipped.`,
      );
      return 0;
    }

    const days = new Map(); // date -> { cash, funds: security_id -> { units, price } }
    for (const row of rows) {
      if (typeof row[valueDate] !== "number") continue;
      const date = utils.addDays("1899-12-30", row[valueDate]); // Excel serial date
      if (date > dateStr) continue;
      const securityId = ALLIANZ_FUNDS[row[line]];
      if (!securityId)
        throw new Error(
          `ALLIANZ: unknown fund "${row[line]}" (${filename}), add it to ALLIANZ_FUNDS`,
        );
      const day =
        days.get(date) ??
        days.set(date, { cash: 0, funds: new Map() }).get(date);
      day.cash += row[amount];
      const fund =
        day.funds.get(securityId) ??
        day.funds
          .set(securityId, { units: 0, value: 0, price: row[unitPrice] })
          .get(securityId);
      fund.units += row[units];
      fund.value += row[amount];
    }

    const { rows: saved } = await query(
      `SELECT external_id FROM transactions WHERE source = 'ALLIANZ' AND portfolio_id = $1
       UNION ALL SELECT external_id FROM capital_flows WHERE source = 'ALLIANZ' AND portfolio_id = $1;`,
      [portfolioId],
    );
    const savedIds = new Set(saved.map((row) => row.external_id));
    const prices = [];
    let written = 0;
    for (const [date, day] of [...days].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const common = { date, portfolio_id: portfolioId, source: "ALLIANZ" };
      if (!savedIds.has(`${date}:cashin`)) {
        await ledger.addCapitalFlow({
          ...common,
          external_id: `${date}:cashin`,
          capital_flow_type: "CASHIN",
          security_id: await ledger.cashSecurityFor(portfolio.currency),
          quantity: Number(day.cash.toFixed(2)),
        });
        written++;
      }
      for (const [securityId, fund] of day.funds) {
        prices.push({ date, security_id: securityId, price: fund.price, source: "ALLIANZ" });
        if (savedIds.has(`${date}:${securityId}`)) continue;
        await ledger.addTransaction({
          ...common,
          external_id: `${date}:${securityId}`,
          security_id: securityId,
          transaction_type: "BUY",
          quantity: Number(fund.units.toFixed(3)),
          transaction_price: fund.price,
          counter_currency: portfolio.currency,
          market_value_local: Number(fund.value.toFixed(2)),
        });
        written++;
      }
    }
    if (prices.length > 0) await replaceDataInDb(prices, "prices");
    console.log(
      `[VALUATION] ALLIANZ: ${filename}: ${days.size} investment dates, ${written} new ledger row(s).`,
    );
    return written;
  }
}

/**
 * TRADE_REPUBLIC (no API): the full "Transaction export.csv" from the app is emailed to Gmail, label tradeRepublic.
 * Every run rebuilds the ledger rows the export implies and syncs them (source TRADE_REPUBLIC, external_id = TR
 * transaction_id, "<date>:cash" for the daily cash line): new rows are written, rows whose numbers changed (a day
 * exported again with more card spends) are rewritten, then the portfolio rolls (created_at trigger).
 * - money in / out of the account (card spends and refunds, transfers, top-ups): ONE net CASHIN / CASHOUT per day
 * - BUY / SELL: transactions (fee in the transaction; the tax withheld on a sale -> CAPITAL_GAIN_TAX)
 * - saveback: TR pays the cash reward and buys with it the next day (crypto keeps a few cents): booked as REWARDS of
 *   the units bought (valued at the amount spent) + REWARDS of the cents left, so the saveback BUY is not a purchase
 *   and the portfolio's REWARDS = what the saveback earned. The 50 EUR savings plans stay BUYs
 * - interest: INTEREST (gross) + TAX; staking (FREE_RECEIPT): STAKING units; taxes: TAX (refunds: ADJUST_IN);
 *   card fees: MANAGEMENT_FEE (refunds: ADJUST_IN); "Tax Credit" cash: ADJUST_IN; MIGRATION deliveries net to zero
 * An unknown TR type stops the import.
 *
 * @returns {Promise<boolean>} true if positions/nav were written
 */
export async function runTradeRepublic(portfolio, dateStr) {
  // Money entering / leaving the account: netted into one cash flow per day
  const CASH_TYPES = [
    "CARD_TRANSACTION",
    "CARD_TRANSACTION_INTERNATIONAL",
    "CUSTOMER_INPAYMENT",
    "CUSTOMER_INBOUND",
    "CUSTOMER_OUTBOUND_REQUEST",
    "TRANSFER_INBOUND",
    "TRANSFER_OUTBOUND",
    "TRANSFER_INSTANT_INBOUND",
    "TRANSFER_INSTANT_OUTBOUND",
  ];

  try {
    for (const file of await readLabelAttachments("tradeRepublic", /\.csv$/i)) await importTradeRepublicCsv(file);
  } catch (error) {
    if (/unknown Trade Republic type/.test(error.message)) throw error;
    console.warn(`[VALUATION] TRADE_REPUBLIC: Gmail read failed (${error.message}), valuing the ledger already saved.`);
  }
  return runRoll(portfolio, dateStr);

  async function importTradeRepublicCsv(file) {
    const portfolioId = portfolio.portfolio_id;
    const rows = utils.parseCsv(file.content.toString("utf-8")).filter((row) => row.date && row.date <= dateStr);
    if (!rows.length || !("transaction_id" in rows[0]) || !("type" in rows[0])) {
      console.warn(`[VALUATION] TRADE_REPUBLIC: ${file.filename} is not a Trade Republic export, skipped.`);
      return;
    }
    const num = (value) => (value ? Number(value) : 0);
    const days = (from, to) => Math.round((new Date(to) - new Date(from)) / 86400000);

    // Saveback cash -> the BUY made with it within 5 days (same asset when the row names it, a few cents less at most)
    const buys = rows.filter((row) => row.type === "BUY");
    const savebackBuy = new Map(); // saveback transaction_id -> BUY row
    const pairedBuys = new Set();
    for (const saveback of rows.filter((row) => row.type === "BENEFITS_SAVEBACK")) {
      const reward = num(saveback.amount);
      const candidates = buys
        .filter((buy) => !pairedBuys.has(buy.transaction_id) && (!saveback.symbol || buy.symbol === saveback.symbol))
        .filter((buy) => days(saveback.date, buy.date) >= 0 && days(saveback.date, buy.date) <= 5)
        .filter((buy) => -num(buy.amount) <= reward + 0.005 && -num(buy.amount) >= reward - Math.max(0.1, 0.02 * reward))
        .sort((a, b) => days(saveback.date, a.date) - days(saveback.date, b.date) || Math.abs(reward + num(a.amount)) - Math.abs(reward + num(b.amount)));
      if (candidates.length) {
        savebackBuy.set(saveback.transaction_id, candidates[0]);
        pairedBuys.add(candidates[0].transaction_id);
      }
    }

    const target = []; // { table, external_id, type, quantity, options }
    const flow = (external_id, date, capital_flow_type, security_id, quantity, extra = {}) =>
      target.push({ table: "capital_flows", external_id, type: capital_flow_type, quantity, options: { date, capital_flow_type, security_id, quantity, ...extra } });
    const cashByDay = new Map();
    const migrations = new Map();
    for (const row of rows) {
      const id = row.transaction_id;
      const tax = num(row.tax);
      const fee = num(row.fee);
      if (CASH_TYPES.includes(row.type)) {
        cashByDay.set(row.date, (cashByDay.get(row.date) ?? 0) + num(row.amount) + fee + tax);
        continue;
      }
      switch (row.type) {
        case "BUY":
        case "SELL": {
          if (pairedBuys.has(id)) break; // booked with its saveback
          const isBuy = row.type === "BUY";
          target.push({
            table: "transactions",
            external_id: id,
            type: row.type,
            quantity: Math.abs(num(row.shares)),
            options: { date: row.date, security_id: row.symbol, transaction_type: row.type, quantity: Math.abs(num(row.shares)), transaction_price: num(row.price), counter_currency: portfolio.currency, market_value_local: Math.abs(num(row.amount)), fee: Math.abs(fee), fee_currency: portfolio.currency },
          });
          if (!isBuy && tax < 0) flow(`${id}:tax`, row.date, "CAPITAL_GAIN_TAX", "CASH_EUR", -tax);
          break;
        }
        case "BENEFITS_SAVEBACK": {
          const buy = savebackBuy.get(id);
          if (!buy) {
            flow(id, row.date, "REWARDS", "CASH_EUR", num(row.amount));
            break;
          }
          flow(id, buy.date, "REWARDS", buy.symbol, Math.abs(num(buy.shares)), { market_value_base: -num(buy.amount) });
          const cents = Number((num(row.amount) + num(buy.amount)).toFixed(2));
          if (cents > 0) flow(`${id}:cash`, row.date, "REWARDS", "CASH_EUR", cents);
          break;
        }
        case "INTEREST_PAYMENT":
          flow(id, row.date, "INTEREST", "CASH_EUR", num(row.amount));
          if (tax) flow(`${id}:tax`, row.date, tax < 0 ? "TAX" : "ADJUST_IN", "CASH_EUR", Math.abs(tax));
          break;
        case "FREE_RECEIPT":
          flow(id, row.date, "STAKING", row.symbol, num(row.shares));
          break;
        case "TAX":
        case "TAX_OPTIMIZATION":
          if (tax) flow(id, row.date, tax < 0 ? "TAX" : "ADJUST_IN", "CASH_EUR", Math.abs(tax));
          break;
        case "CARD_ORDERING_FEE":
          if (fee) flow(id, row.date, fee < 0 ? "MANAGEMENT_FEE" : "ADJUST_IN", "CASH_EUR", Math.abs(fee));
          break;
        case "MANUAL_CASH_TRANSFER":
          if (num(row.amount)) flow(id, row.date, num(row.amount) > 0 ? "ADJUST_IN" : "ADJUST_OUT", "CASH_EUR", Math.abs(num(row.amount)));
          break;
        case "MIGRATION": {
          const key = `${row.date}|${row.symbol}`;
          migrations.set(key, (migrations.get(key) ?? 0) + num(row.shares));
          break;
        }
        default:
          throw new Error(`unknown Trade Republic type "${row.type}" (${row.date}, ${id}): classify it in runTradeRepublic`);
      }
    }
    for (const [date, net] of cashByDay) {
      const amount = Number(net.toFixed(2));
      if (amount) flow(`${date}:cash`, date, amount > 0 ? "CASHIN" : "CASHOUT", "CASH_EUR", Math.abs(amount));
    }
    for (const [key, net] of migrations) {
      const [date, symbol] = key.split("|");
      if (Math.abs(net) > 1e-9) flow(`${key}:migration`, date, net > 0 ? "ASSETIN" : "ASSETOUT", symbol, Math.abs(net));
    }

    // Sync with what is saved: new -> written; same id with other numbers -> rewritten; the rest untouched
    const { rows: saved } = await query(
      `SELECT 'transactions' AS tbl, external_id, transaction_type::text AS type, quantity::float AS quantity FROM transactions WHERE source = 'TRADE_REPUBLIC' AND portfolio_id = $1
       UNION ALL
       SELECT 'capital_flows', external_id, capital_flow_type, quantity::float FROM capital_flows WHERE source = 'TRADE_REPUBLIC' AND portfolio_id = $1;`,
      [portfolioId],
    );
    const savedById = new Map(saved.map((row) => [`${row.tbl}|${row.external_id}`, row]));
    let written = 0;
    let rewritten = 0;
    for (const item of target) {
      const known = savedById.get(`${item.table}|${item.external_id}`);
      if (known && known.type === item.type && Math.abs(known.quantity - item.quantity) < 1e-9) continue;
      if (known) {
        await query(`DELETE FROM ${item.table} WHERE source = 'TRADE_REPUBLIC' AND portfolio_id = $1 AND external_id = $2`, [portfolioId, item.external_id]);
        rewritten++;
      }
      const options = { ...item.options, portfolio_id: portfolioId, source: "TRADE_REPUBLIC", external_id: item.external_id };
      await (item.table === "transactions" ? ledger.addTransaction(options) : ledger.addCapitalFlow(options));
      written++;
    }
    console.log(`[VALUATION] TRADE_REPUBLIC: ${file.filename}: ${rows.length} rows -> ${target.length} ledger rows, ${written} written (${rewritten} rewritten), ${savebackBuy.size} saveback(s) paired.`);
  }
}

/**
 * Writes a multi-position portfolio for one date: market values in security / portfolio currency / EUR, nav as
 * their sum, weights 0-100 of nav. Positions go through the replace block (date, portfolio_id).
 * Migrated from runGenericPortfolio + computeNav + calculateWeights in // portfolioData.gs
 *
 * @param {Object} portfolio - Row from portfolios
 * @param {Array<{security_id: string, quantity: number, price: number}>} positions
 * @param {string} dateStr - ISO date
 * @returns {Promise<boolean>} true (written)
 */
export async function runGenericPortfolio(portfolio, positions, dateStr) {
  const { rows, nav } = await buildPortfolioRows(portfolio, positions, dateStr);
  await writePositionsAndNav(rows, [nav]);
  console.log(
    `[VALUATION] ${portfolio.portfolio_id}: ${rows.length} positions -> nav ${nav.nav.toFixed(2)} (${nav.nav_eur.toFixed(2)} EUR).`,
  );
  return true;
}

/**
 * Writes positions + nav together, atomically (GAS wrote both sheets in the same step): a portfolio-day never has
 * positions without its nav or the other way round. Days with a nav but no positions (everything sold) also get their
 * old positions cleared, which the replace block alone can't do (it only clears the blocks of the incoming rows).
 */
async function writePositionsAndNav(positionRows, navRows) {
  await withSavepoint(async () => {
    const datesWithPositions = new Set(positionRows.map((row) => row.date));
    const emptyDays = navRows.filter(
      (row) => !datesWithPositions.has(row.date),
    );
    for (const row of emptyDays)
      await query(
        `DELETE FROM positions WHERE portfolio_id = $1 AND date = $2;`,
        [row.portfolio_id, row.date],
      );
    if (positionRows.length > 0)
      await replaceDataInDb(positionRows, "positions");
    await replaceDataInDb(navRows, "nav");
  });
}

/** positions + nav rows of one portfolio-day (market values local / base / EUR, weights 0-100 of nav), not written. */
async function buildPortfolioRows(portfolio, positions, dateStr) {
  const fxToEur = currencyConverter(portfolio.currency, "EUR", dateStr);
  const rows = [];
  for (const position of positions) {
    const security = await ledger.getSecurity(position.security_id);
    const marketValueLocal = await ledger.computeMarketValue(
      position.security_id,
      position.price,
      position.quantity,
    );
    const marketValueBase =
      marketValueLocal *
      currencyConverter(security.currency, portfolio.currency, dateStr);
    rows.push({
      date: dateStr,
      portfolio_id: portfolio.portfolio_id,
      security_id: position.security_id,
      quantity: position.quantity,
      price: position.price,
      market_value_local: marketValueLocal,
      market_value_base: marketValueBase,
      market_value_eur: marketValueBase * fxToEur,
    });
  }
  const nav = rows.reduce((sum, row) => sum + row.market_value_base, 0);
  for (const row of rows)
    row.weight = nav ? (row.market_value_base / nav) * 100 : 0;
  return {
    rows,
    nav: {
      date: dateStr,
      portfolio_id: portfolio.portfolio_id,
      nav,
      nav_eur: nav * fxToEur,
    },
  };
}

/**
 * Writes a single-position portfolio (weight 100) and its nav for one date.
 * The security is assumed to be in the portfolio currency (one-liners are base-currency cash), so base = local.
 * Positions go through the replace block (date, portfolio_id), so the whole portfolio-day is rewritten.
 * Migrated from runOneLinePortfolio in // portfolioData.gs
 *
 * @param {Object} portfolio - Row from portfolios
 * @param {string} securityId - e.g. CASH_CHF
 * @param {number} price
 * @param {number} quantity
 * @param {string} dateStr - ISO date
 * @returns {Promise<boolean>} true if positions/nav were written
 */
export async function runOneLinePortfolio(
  portfolio,
  securityId,
  price,
  quantity,
  dateStr,
) {
  const portfolioId = portfolio.portfolio_id;
  const fxToEur = currencyConverter(portfolio.currency, "EUR", dateStr);

  const marketValue = price * quantity;
  const marketValueEur = marketValue * fxToEur;

  await writePositionsAndNav(
    [
      {
        date: dateStr,
        portfolio_id: portfolioId,
        security_id: securityId,
        quantity,
        price,
        market_value_local: marketValue,
        market_value_base: marketValue,
        market_value_eur: marketValueEur,
        weight: 100,
      },
    ],
    [
      {
        date: dateStr,
        portfolio_id: portfolioId,
        nav: marketValue,
        nav_eur: marketValueEur,
      },
    ],
  );

  console.log(
    `[VALUATION] ${portfolioId}: ${quantity} ${securityId} -> nav ${marketValue} (${marketValueEur.toFixed(2)} EUR).`,
  );
  return true;
}
