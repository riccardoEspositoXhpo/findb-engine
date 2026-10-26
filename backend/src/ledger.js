import { utils } from "./utils.js";
import { importDatabase, query, replaceDataInDb } from "./db.js";
import { currencyConverter } from "./marketData.js";

export const ledger = {
  addTransaction,
  addCapitalFlow,
  getSecurity,
  getPortfolio,
  getLatestPriceForDate,
  computeMarketValue,
  cashSecurityFor,
  getLedgerHoldings,
};

// Capital flow types that take quantity out of the portfolio (GAS OUTFLOWS = CASHOUT, ASSETOUT, ADJUST_OUT + FEES);
// every other type adds it
export const OUTFLOW_TYPES = [
  "CASHOUT",
  "ASSETOUT",
  "ADJUST_OUT",
  "TAX",
  "MANAGEMENT_FEE",
  "TRANSACTION_FEE",
  "FUNDING_FEE",
  "CAPITAL_GAIN_TAX",
  "INTEREST_PAID",
];

// Securities valued at 1 per unit (GAS CASH_AND_CRYPTO_SECURITIES + DEBT): no prices stored for them
const UNIT_VALUED_ASSET_TYPES = ["CASH", "DEBT", "CRYPTO"];

// Reference data cache (security_master, portfolios), loaded on first use
let securities = null;
let portfolios = null;

async function loadReferences() {
  if (securities) return;
  securities = await importDatabase("security_master", true);
  portfolios = await importDatabase("portfolios", true);
}

/** security_master row, or throws. */
export async function getSecurity(securityId) {
  await loadReferences();
  const security = securities.get(securityId);
  if (!security)
    throw new Error(`security ${securityId} not in security_master`);
  return security;
}

/** portfolios row, or throws. */
export async function getPortfolio(portfolioId) {
  await loadReferences();
  const portfolio = portfolios.get(portfolioId);
  if (!portfolio) throw new Error(`portfolio ${portfolioId} not in portfolios`);
  return portfolio;
}

/**
 * Cash security holding a currency: CASH_<ccy> for fiat, the token itself for crypto (BTC, USDC...).
 * Equivalent of cashMap[currency] in // local.gs
 */
export async function cashSecurityFor(currency) {
  await loadReferences();
  if (securities.has(`CASH_${currency}`)) return `CASH_${currency}`;
  if (securities.has(currency)) return currency;
  throw new Error(`no cash security for currency ${currency}`);
}

/**
 * Latest price on or before the date; 1 for unit-valued securities (cash, debt, crypto).
 *
 */
export async function getLatestPriceForDate(securityId, dateStr) {
  const security = await getSecurity(securityId);
  if (UNIT_VALUED_ASSET_TYPES.includes(security.asset_type)) return 1;

  const { rows } = await query(
    `SELECT price FROM prices WHERE security_id = $1 AND date <= $2 ORDER BY date DESC LIMIT 1;`,
    [securityId, dateStr],
  );
  if (rows.length === 0)
    throw new Error(`no price for ${securityId} on or before ${dateStr}`);
  return Number(rows[0].price);
}

/**
 * Market value in the security currency: price x quantity, or face x price / 100 per unit for percent-priced bonds.
 * Migrated from computeMarketValue in // securityData.gs
 */
export async function computeMarketValue(securityId, price, quantity) {
  const security = await getSecurity(securityId);
  if (security.price_pct)
    return (quantity * Number(security.face) * price) / 100;
  return price * quantity;
}

/** Who writes the row: EVENT when it comes from an event, otherwise it must be given (GAS, IBKR, KRAKEN...). */
function ledgerSource(options) {
  if (options.source) return options.source;
  if (options.event_id) return "EVENT";
  throw new Error("ledger rows need a source (or an event_id)");
}

/**
 * Writes a BUY / SELL transaction, filling what isn't given:
 * - transaction_price: latest price on or before the date
 * - counter_currency / fee_currency: the security currency (currency codes, GAS used cash SECURITY_IDs)
 * - fee_value_base = fee x fx(fee ccy -> portfolio ccy)
 * - market_value_local = market value x fx(security ccy -> counter ccy)   (in counter currency)
 * - market_value_base = local x fx(counter ccy -> portfolio ccy), market_value_eur = base x fx(portfolio ccy -> EUR)
 * No id juggling or duplicate checks as in GAS: rows carry their provenance (source + event_id, or source +
 * external_id for brokers, unique per portfolio).
 * Migrated from addTransaction in // portfolioData.gs
 *
 * @param {Object} options - date, portfolio_id, security_id, transaction_type, quantity (+ optional overrides,
 *   event_id, source, external_id)
 * @param {{write?: boolean}} [opts] - write: false only computes the row (one-time bulk loads write it themselves)
 * @returns {Promise<Object>} the row written
 */
export async function addTransaction(options, { write = true } = {}) {
  const dateStr = utils.formatDateToISO(options.date);
  const security = await getSecurity(options.security_id);
  const portfolio = await getPortfolio(options.portfolio_id);

  const transactionPrice =
    options.transaction_price ??
    (await getLatestPriceForDate(options.security_id, dateStr));
  const counterCurrency = options.counter_currency ?? security.currency;
  const feeCurrency = options.fee_currency ?? security.currency;
  const fee = options.fee ?? 0;

  const marketValueLocal =
    options.market_value_local ??
    (await computeMarketValue(
      options.security_id,
      transactionPrice,
      options.quantity,
    )) * currencyConverter(security.currency, counterCurrency, dateStr);
  const marketValueBase =
    options.market_value_base ??
    marketValueLocal *
      currencyConverter(counterCurrency, portfolio.currency, dateStr);

  const row = {
    date: dateStr,
    portfolio_id: options.portfolio_id,
    security_id: options.security_id,
    transaction_type: options.transaction_type,
    quantity: options.quantity,
    transaction_price: transactionPrice,
    fee_currency: feeCurrency,
    fee,
    fee_value_base:
      options.fee_value_base ??
      fee * currencyConverter(feeCurrency, portfolio.currency, dateStr),
    counter_currency: counterCurrency,
    market_value_local: marketValueLocal,
    market_value_base: marketValueBase,
    market_value_eur:
      marketValueBase * currencyConverter(portfolio.currency, "EUR", dateStr),
    event_id: options.event_id ?? null,
    external_id: options.external_id ?? null,
    source: ledgerSource(options),
  };
  if (write) await replaceDataInDb([row], "transactions");
  return row;
}

/**
 * Writes a capital flow (CASHIN, CASHOUT, ASSETIN, DIVIDEND, TAX...), filling what isn't given:
 * - market_value_local = market value at the latest price on or before the date (security currency)
 * - market_value_base = local x fx(security ccy -> portfolio ccy), market_value_eur = base x fx(portfolio ccy -> EUR)
 * Migrated from addCapitalFlow in // portfolioData.gs
 *
 * @param {Object} options - date, portfolio_id, capital_flow_type, security_id, quantity (+ optional overrides,
 *   event_id, source, external_id)
 * @param {{write?: boolean}} [opts] - write: false only computes the row (one-time bulk loads write it themselves)
 * @returns {Promise<Object>} the row written
 */
export async function addCapitalFlow(options, { write = true } = {}) {
  const dateStr = utils.formatDateToISO(options.date);
  const security = await getSecurity(options.security_id);
  const portfolio = await getPortfolio(options.portfolio_id);

  const marketValueLocal =
    options.market_value_local ??
    (await computeMarketValue(
      options.security_id,
      await getLatestPriceForDate(options.security_id, dateStr),
      options.quantity,
    ));
  const marketValueBase =
    options.market_value_base ??
    marketValueLocal *
      currencyConverter(security.currency, portfolio.currency, dateStr);

  const row = {
    date: dateStr,
    portfolio_id: options.portfolio_id,
    capital_flow_type: options.capital_flow_type,
    security_id: options.security_id,
    quantity: options.quantity,
    market_value_local: marketValueLocal,
    market_value_base: marketValueBase,
    market_value_eur:
      marketValueBase * currencyConverter(portfolio.currency, "EUR", dateStr),
    event_id: options.event_id ?? null,
    external_id: options.external_id ?? null,
    source: ledgerSource(options),
  };
  if (write) await replaceDataInDb([row], "capital_flows");
  return row;
}

/**
 * Quantity held per security on dateStr, from the whole ledger up to that day: flows in/out, BUY +qty / SELL -qty on
 * the security, the counter leg -/+ market_value_local on the counter currency's cash security, fees out of the fee
 * currency. Exact for portfolios whose ledger is complete (crypto apps): the quantity side of ROLL.
 *
 * @param {string} portfolioId
 * @param {string} dateStr - ISO date
 * @returns {Promise<Map<string, number>>} security_id -> quantity (zero balances dropped)
 */
export async function getLedgerHoldings(portfolioId, dateStr) {
  const { rows: flows } = await query(
    `SELECT security_id, capital_flow_type, quantity FROM capital_flows WHERE portfolio_id = $1 AND date <= $2;`,
    [portfolioId, dateStr],
  );
  const { rows: transactions } = await query(
    `SELECT security_id, transaction_type, quantity, counter_currency, market_value_local, fee_currency, fee
     FROM transactions WHERE portfolio_id = $1 AND date <= $2;`,
    [portfolioId, dateStr],
  );

  const holdings = new Map();
  const add = (securityId, quantity) =>
    holdings.set(
      securityId,
      (holdings.get(securityId) ?? 0) + Number(quantity),
    );
  for (const flow of flows)
    add(
      flow.security_id,
      OUTFLOW_TYPES.includes(flow.capital_flow_type)
        ? -flow.quantity
        : flow.quantity,
    );
  for (const tx of transactions) {
    const sign = tx.transaction_type === "BUY" ? 1 : -1;
    add(tx.security_id, sign * tx.quantity);
    add(
      await cashSecurityFor(tx.counter_currency),
      -sign * tx.market_value_local,
    );
    if (Number(tx.fee)) add(await cashSecurityFor(tx.fee_currency), -tx.fee);
  }
  for (const [securityId, quantity] of holdings)
    if (Math.abs(quantity) < 1e-9) holdings.delete(securityId);
  return holdings;
}
