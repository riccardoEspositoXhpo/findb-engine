import crypto from "crypto";
import { utils } from "./utils.js";
import { importDatabase, query, replaceDataInDb } from "./db.js";
import { loadFxRates, currencyConverter } from "./marketData.js";
import { ledger } from "./ledger.js";
import { config } from "../config.js";

export const valuation = {
  run,
  runRoll,
  runBalance,
  runFile,
  runRecurringFlows,
  runCustom,
  runKraken,
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
 * ROLL: rebuilds positions from the previous day + transactions + capital flows, repriced with prices and fx.
 * Migrated from rollPositions / reconstructMarketValues in // portfolioData.gs
 *
 * @returns {Promise<boolean>} true if positions/nav were written
 */
export async function runRoll(portfolio, dateStr) {
  console.warn(
    `[VALUATION] ${portfolio.portfolio_id}: ROLL not migrated yet, skipping.`,
  );
  return false;
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
  if (rows.length === 0) throw new Error(`no BALANCE event on or before ${dateStr}`);

  const securityId = rows[0].security_id ?? `CASH_${portfolio.currency}`;
  return runOneLinePortfolio(portfolio, securityId, 1, Number(rows[0].quantity), dateStr);
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

  // Latest row per payment on or before the date
  const { rows } = await query(
    `
    SELECT DISTINCT ON (rf.payment_desc)
      rf.payment_desc, rf.security_id, rf.outstanding_amount, sm.currency
    FROM recurring_flows rf
    JOIN security_master sm ON sm.security_id = rf.security_id
    WHERE rf.portfolio_id = $1
      AND rf.start_date <= $2 AND $2 < rf.end_date
      AND rf.eval_date <= $2
    ORDER BY rf.payment_desc, rf.eval_date DESC;`,
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
 * CUSTOM: per-portfolio integrations. KRAKEN is ported; CRYPTO_COM (CSV + ROLL) and UNREALIZED_TAX (needs tax lots)
 * are not yet; IBKR is closed.
 * Migrated from runCustomPortfolio in // portfolioData.gs
 *
 * @returns {Promise<boolean>} true if positions/nav were written
 */
export async function runCustom(portfolio, dateStr) {
  switch (portfolio.portfolio_id) {
    case "KRAKEN":
      return runKraken(portfolio, dateStr);
    default:
      console.warn(`[VALUATION] ${portfolio.portfolio_id}: CUSTOM not migrated yet, skipping.`);
      return false;
  }
}

// Kraken's legacy asset codes (X / Z prefixed) -> engine currency codes. Explicit list: stripping any leading X/Z
// (GAS) would break real tickers like XAUT.
const KRAKEN_LEGACY_ASSETS = {
  XXBT: "BTC", XBT: "BTC", XETH: "ETH", XLTC: "LTC", XXRP: "XRP", XXLM: "XLM", XXMR: "XMR", XZEC: "ZEC",
  XXDG: "DOGE", XDG: "DOGE", XETC: "ETC", XMLN: "MLN", XREP: "REP",
  ZEUR: "EUR", ZUSD: "USD", ZGBP: "GBP", ZCAD: "CAD", ZJPY: "JPY",
};

// Ledger entries that only move money between Kraken wallets (spot <-> staking / earn): not flows
const KRAKEN_INTERNAL_SUBTYPES = ["spottostaking", "stakingfromspot", "stakingtospot", "spotfromstaking", "spendpoint",
  "allocation", "deallocation", "autoallocation", "migration"];

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
  if (!config.krakenApiKey || !config.krakenPrivateKey) throw new Error("KRAKEN_API_KEY / KRAKEN_PRIVATE_KEY not set");
  const nonce = String(Date.now() * 1000);
  const body = new URLSearchParams({ nonce, ...params }).toString();
  const sha256 = crypto.createHash("sha256").update(nonce + body).digest();
  const signature = crypto
    .createHmac("sha512", Buffer.from(config.krakenPrivateKey, "base64"))
    .update(Buffer.concat([Buffer.from(path), sha256]))
    .digest("base64");

  const response = await fetch(`https://api.kraken.com${path}`, {
    method: "POST",
    headers: { "API-Key": config.krakenApiKey, "API-Sign": signature, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await response.json();
  if (json.error?.length) throw new Error(`Kraken ${path}: ${json.error.join(", ")}`);
  return json.result;
}

/**
 * KRAKEN: syncs the Kraken ledger into transactions / capital flows (source KRAKEN), then values today's positions
 * from the live balance (one line per asset, price 1 per unit). The balance only exists "now": for a past date
 * the ledger is synced but no positions are written.
 * Migrated from runKraken in // portfolioData.gs
 *
 * @param {Object} portfolio - Row from portfolios
 * @param {string} dateStr - ISO date
 * @returns {Promise<boolean>} true if positions/nav were written
 */
export async function runKraken(portfolio, dateStr) {
  await syncKrakenLedger(portfolio, dateStr);

  if (dateStr !== utils.toRomeDateISO(Date.now())) {
    console.warn(`[VALUATION] KRAKEN: balance is only available for today, no positions written for ${dateStr}.`);
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
    positions.push({ security_id: await ledger.cashSecurityFor(code), quantity, price: 1 });
  }
  return runGenericPortfolio(portfolio, positions, dateStr);
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
  const lastDate = saved.length ? utils.formatDateToISO(new Date(Math.max(...saved.map((row) => new Date(row.date))))) : null;
  const startDay = new Date(`${lastDate ?? utils.formatDateToISO(portfolio.inception_date)}T00:00:00Z`);
  startDay.setUTCDate(startDay.getUTCDate() - 1);

  // All pages since startDay (Kraken returns 50 per page; pause between pages for the API rate limit)
  const entries = [];
  for (let offset = 0, total = 1; offset < total; offset += 50) {
    if (offset > 0) await new Promise((resolve) => setTimeout(resolve, 2500));
    const page = await callKrakenPrivate("/0/private/Ledgers", { start: String(startDay.getTime() / 1000), ofs: String(offset) });
    total = page.count;
    entries.push(...Object.entries(page.ledger).map(([id, entry]) => ({ id, ...entry })));
  }

  const { rows: currencyRows } = await query(`SELECT currency_code, type FROM currencies;`);
  const currencyTypes = new Map(currencyRows.map((row) => [row.currency_code, row.type]));
  const isCashLike = (code) => ["FIAT", "STABLECOIN"].includes(currencyTypes.get(code));

  const trades = {};
  let written = 0;
  for (const entry of entries) {
    const entryDate = utils.toRomeDateISO(entry.time * 1000);
    if (entryDate > dateStr) continue;
    const code = normalizeKrakenAsset(entry.asset);
    const amount = Number(entry.amount);
    const fee = Number(entry.fee ?? 0);

    if (entry.type === "trade") {
      (trades[entry.refid] ??= []).push({ code, amount, fee, date: entryDate });
      continue;
    }
    if (entry.type === "transfer" || KRAKEN_INTERNAL_SUBTYPES.includes(entry.subtype) || savedIds.has(entry.id)) continue;

    let flowType = "REWARDS";
    if (entry.type === "deposit") flowType = isCashLike(code) ? "CASHIN" : "ASSETIN";
    else if (entry.type === "withdrawal") flowType = isCashLike(code) ? "CASHOUT" : "ASSETOUT";
    else if (entry.type === "staking" || entry.type === "dividend") flowType = "STAKING";
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
      console.warn(`[VALUATION] KRAKEN: trade ${refid} has unbalanced legs, skipped.`);
      continue;
    }

    // Instrument = the crypto side; with fiat on one side, a crypto given away is a SELL
    const isSell = currencyTypes.get(received.code) === "FIAT" && currencyTypes.get(given.code) !== "FIAT";
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
      transaction_price: counterValue / quantity,
      fee: given.fee > 0 && received.fee > 0 ? given.fee + (received.fee * counterValue) / quantity : feeLeg.fee,
      fee_currency: given.fee > 0 && received.fee > 0 ? given.code : feeLeg.code,
      counter_currency: counter.code,
      market_value_local: counterValue,
      source: "KRAKEN",
      external_id: refid,
    });
    written++;
  }

  console.log(`[VALUATION] KRAKEN: ${entries.length} ledger entries since ${utils.formatDateToISO(startDay)}, ${written} new rows written.`);
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
  const fxToEur = currencyConverter(portfolio.currency, "EUR", dateStr);
  const rows = [];
  for (const position of positions) {
    const security = await ledger.getSecurity(position.security_id);
    const marketValueLocal = await ledger.computeMarketValue(position.security_id, position.price, position.quantity);
    const marketValueBase = marketValueLocal * currencyConverter(security.currency, portfolio.currency, dateStr);
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
  for (const row of rows) row.weight = nav ? (row.market_value_base / nav) * 100 : 0;

  if (rows.length > 0) await replaceDataInDb(rows, "positions");
  await replaceDataInDb([{ date: dateStr, portfolio_id: portfolio.portfolio_id, nav, nav_eur: nav * fxToEur }], "nav");

  console.log(`[VALUATION] ${portfolio.portfolio_id}: ${rows.length} positions -> nav ${nav.toFixed(2)} (${(nav * fxToEur).toFixed(2)} EUR).`);
  return true;
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

  await replaceDataInDb(
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
    "positions",
  );
  await replaceDataInDb(
    [
      {
        date: dateStr,
        portfolio_id: portfolioId,
        nav: marketValue,
        nav_eur: marketValueEur,
      },
    ],
    "nav",
  );

  console.log(
    `[VALUATION] ${portfolioId}: ${quantity} ${securityId} -> nav ${marketValue} (${marketValueEur.toFixed(2)} EUR).`,
  );
  return true;
}
