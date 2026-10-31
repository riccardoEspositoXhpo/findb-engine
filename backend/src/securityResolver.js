import YahooFinance from "yahoo-finance2";
import { config } from "../config.js";
import { query } from "./db.js";
import { ledger } from "./ledger.js";
import { batchLog } from "./batchLog.js";
import { utils } from "./utils.js";

export const securityResolver = {
  resolveSecurity,
  resolveCurrencyHolding,
};

const ISIN_PATTERN = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;
// EODHD listing preference when an ISIN trades in several places: Xetra first (like the securities already held)
const EXCHANGE_PREFERENCE = ["XETRA", "F", "EUFUND", "MI", "AS", "PA", "LSE"];
// Asset types from the provider security types
const ASSET_TYPES = { ETF: "ETF", FUND: "FUND", MUTUALFUND: "FUND", "Common Stock": "STOCK", EQUITY: "STOCK", BOND: "BOND" };

/**
 * security_id for a raw identifier as it arrives from a source (user, 2026-10-31: security_id is the user's internal
 * name; nothing that arrives may break the batch): an existing security_id, else the security with that ISIN, else a
 * crypto / currency code (its holding security, created from CoinMarketCap when new), else a new security created
 * from the providers (ISIN: EODHD / Yahoo) or a bare placeholder. New securities get reviewed = false + a review_note
 * (QC checkSecuritiesToReview) and a batch log warning. Never throws on provider failures: the placeholder is enough.
 *
 * @param {string} ref - raw identifier (security_id, ISIN, crypto code, name)
 * @param {Object} context - { origin: 'DIRECTA' / 'KRAKEN' / 'EVENT'..., portfolioId, kind: 'crypto' | 'isin' | 'name',
 *   name: description from the source, currency: trading currency from the source }
 * @returns {Promise<string>} security_id
 */
export async function resolveSecurity(ref, context = {}) {
  const id = String(ref ?? "").trim();
  if (!id) throw new Error("empty security reference");
  if (await ledger.securityExists(id)) return id;
  const byIsin = await ledger.securityByIsin(id.toUpperCase());
  if (byIsin) return byIsin;
  if (context.kind === "crypto" || (await isCurrencyCode(id))) return resolveCurrencyHolding(id, context);
  if (context.kind === "isin" || ISIN_PATTERN.test(id)) return createFromIsin(id.toUpperCase(), context);
  // Nothing in the identifier itself: the portfolio decides (a crypto portfolio's new code is a token)
  if (!context.kind && (await preferredSource(context.portfolioId)) === "CMC") return resolveCurrencyHolding(id, context);
  return createPlaceholder(id, context, null);
}

/**
 * Security holding a currency code (EUR -> its CASH security, BTC -> its CRYPTO security). A code not in currencies is
 * a new crypto: added to currencies (the trigger creates its security, source CMC) with its CoinMarketCap id.
 */
export async function resolveCurrencyHolding(code, context = {}) {
  try {
    return await ledger.cashSecurityFor(code);
  } catch {
    // new token
  }
  const cmc = await lookupCmc(code);
  await query(
    `INSERT INTO currencies (currency_code, currency_name, type, is_active) VALUES ($1, $2, 'CRYPTO', true) ON CONFLICT (currency_code) DO NOTHING;`,
    [code, cmc?.name ?? code],
  );
  const note = `Auto-created from ${context.origin ?? "?"} on ${utils.formatDateToISO(new Date())}: ${cmc ? `CoinMarketCap ${cmc.id} "${cmc.name}" (rank ${cmc.rank ?? "n/a"}${cmc.alternatives ? `, also: ${cmc.alternatives}` : ""})` : "not found on CoinMarketCap"}`;
  await query(
    `UPDATE security_master SET source = 'CMC', source_id = $2, reviewed = false, review_note = $3 WHERE asset_type = 'CRYPTO' AND currency = $1;`,
    [code, cmc ? String(cmc.id) : null, note],
  );
  ledger.reloadReferences();
  batchLog.warn("securities", code, `new crypto created (${note}), review it in security_master.`);
  return ledger.cashSecurityFor(code);
}

/** New security from an ISIN: the listing from EODHD (else Yahoo), source as the portfolio's other securities. */
async function createFromIsin(isin, context) {
  const preferred = await preferredSource(context.portfolioId);
  let found = null;
  try {
    found = await lookupEodhd(isin, preferred);
  } catch (error) {
    batchLog.warn("securities", isin, `EODHD lookup failed: ${error.message}`);
  }
  if (!found) {
    try {
      found = await lookupYahoo(isin);
    } catch (error) {
      batchLog.warn("securities", isin, `Yahoo lookup failed: ${error.message}`);
    }
  }
  return createPlaceholder(isin, { ...context, kind: "isin" }, found);
}

/**
 * Inserts the security: id = the raw identifier, provider data where found, "Other" for the classifications (the user
 * curates them), currency from the provider / the source / the portfolio (must be a known currency).
 */
async function createPlaceholder(id, context, found) {
  const portfolio = context.portfolioId ? await ledger.getPortfolio(context.portfolioId).catch(() => null) : null;
  const candidates = [found?.currency, context.currency, portfolio?.currency, "EUR"].filter(Boolean);
  const { rows: known } = await query(`SELECT currency_code FROM currencies WHERE currency_code = ANY($1);`, [candidates]);
  const currency = candidates.find((code) => known.some((row) => row.currency_code === code));
  const note =
    `Auto-created from ${context.origin ?? "?"} on ${utils.formatDateToISO(new Date())}` +
    (found ? `: ${found.provider} ${found.ticker} "${found.name}" (${found.type ?? "?"}, ${found.currency ?? "?"})` : ": no provider match");
  await query(
    `INSERT INTO security_master (security_id, security_description, asset_type, currency, source, source_id, isin,
       asset_class, region, asset_classification, italy_exposure, reviewed, review_note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'Other', 'Other', 'Other', false, false, $8)
     ON CONFLICT (security_id) DO NOTHING;`,
    [
      id,
      found?.name ?? context.name ?? id,
      ASSET_TYPES[found?.type] ?? "Other",
      currency,
      context.kind === "name" ? context.source ?? null : found?.source ?? null,
      context.kind === "name" ? context.sourceId ?? null : found?.ticker ?? null,
      context.kind === "isin" ? id : null,
      note,
    ],
  );
  ledger.reloadReferences();
  batchLog.warn("securities", id, `new security created (${note}), review it in security_master.`);
  return id;
}

async function isCurrencyCode(code) {
  const { rows } = await query(`SELECT 1 FROM currencies WHERE currency_code = $1;`, [code]);
  return rows.length > 0;
}

/** CMC, YAHOO or EODHD: what most of the portfolio's securities use (each source maps to one provider; YAHOO when none). */
async function preferredSource(portfolioId) {
  if (!portfolioId) return "YAHOO";
  const { rows } = await query(
    `SELECT s.source, count(*) AS n
     FROM (SELECT security_id FROM transactions WHERE portfolio_id = $1 UNION SELECT security_id FROM capital_flows WHERE portfolio_id = $1) t
     JOIN security_master s USING (security_id) WHERE s.source IN ('CMC', 'YAHOO', 'EODHD') GROUP BY 1 ORDER BY 2 DESC LIMIT 1;`,
    [portfolioId],
  );
  return rows[0]?.source ?? "YAHOO";
}

/** EODHD search by ISIN: the preferred listing; as a Yahoo ticker (Xetra CODE.DE, checked) when the portfolio uses Yahoo. */
async function lookupEodhd(isin, preferred) {
  if (!config.eodhdToken) return null;
  const response = await fetch(`https://eodhd.com/api/search/${isin}?api_token=${config.eodhdToken}&fmt=json&limit=20`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const hits = (await response.json()).filter((hit) => !hit.ISIN || hit.ISIN === isin);
  if (!hits.length) return null;
  const rank = (hit) => {
    const index = EXCHANGE_PREFERENCE.indexOf(hit.Exchange);
    return index < 0 ? EXCHANGE_PREFERENCE.length : index;
  };
  const hit = [...hits].sort((a, b) => rank(a) - rank(b))[0];
  const found = { provider: "EODHD", source: "EODHD", ticker: `${hit.Code}.${hit.Exchange}`, name: hit.Name, type: hit.Type, currency: hit.Currency };
  if (preferred === "YAHOO" && hit.Exchange === "XETRA") {
    try {
      const quote = await new YahooFinance({ suppressNotices: ["yahooSurvey"] }).quote(`${hit.Code}.DE`);
      if (quote?.regularMarketPrice) return { ...found, provider: "EODHD + Yahoo", source: "YAHOO", ticker: `${hit.Code}.DE`, currency: quote.currency ?? hit.Currency };
    } catch {
      // keep the EODHD listing
    }
  }
  return found;
}

/** Yahoo search by ISIN: the first listing (Yahoo has fewer European exchanges than EODHD). */
async function lookupYahoo(isin) {
  const result = await new YahooFinance({ suppressNotices: ["yahooSurvey"] }).search(isin, { quotesCount: 5, newsCount: 0 });
  const hit = result.quotes?.find((quote) => quote.symbol);
  if (!hit) return null;
  const quote = await new YahooFinance({ suppressNotices: ["yahooSurvey"] }).quote(hit.symbol).catch(() => null);
  return { provider: "Yahoo", source: "YAHOO", ticker: hit.symbol, name: hit.longname ?? hit.shortname, type: hit.quoteType, currency: quote?.currency };
}

/** CoinMarketCap map by symbol: the active coin with the best rank (others listed in the note). */
async function lookupCmc(symbol) {
  if (!config.cmcApiKey) return null;
  try {
    const response = await fetch(`https://pro-api.coinmarketcap.com/v1/cryptocurrency/map?symbol=${encodeURIComponent(symbol)}`, {
      headers: { "X-CMC_PRO_API_KEY": config.cmcApiKey, Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const coins = ((await response.json()).data ?? []).filter((coin) => coin.is_active);
    if (!coins.length) return null;
    coins.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
    const alternatives = coins.slice(1, 4).map((coin) => `${coin.id} ${coin.name}`).join(", ");
    return { id: coins[0].id, name: coins[0].name, rank: coins[0].rank, alternatives };
  } catch (error) {
    batchLog.warn("securities", symbol, `CoinMarketCap lookup failed: ${error.message}`);
    return null;
  }
}
