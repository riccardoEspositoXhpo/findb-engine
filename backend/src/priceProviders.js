/**
 * This file contains the configuration for the price providers used in the application.
 */
import * as cheerio from "cheerio";
import { config } from "../config.js";
import { utils } from "./utils.js";
import YahooFinance from "yahoo-finance2";

// ============================================================================
// INTERNAL SCRAPER PATHS & HEADERS
// ============================================================================

const HTTP_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9,it;q=0.8",
};

const BORSA_PRICE_SELECTOR =
  "#fullcontainer main section div:nth-of-type(3) div:nth-of-type(1) article div div div:nth-of-type(2) div span:nth-of-type(1) strong";

const SCRAPER_ROUTES = {
  BOT: {
    url: (id) =>
      `https://www.borsaitaliana.it/borsa/obbligazioni/mot/bot/scheda/${id}.html?lang=en`,
    priceSelector: BORSA_PRICE_SELECTOR,
  },
  BTP: {
    url: (id) =>
      `https://www.borsaitaliana.it/borsa/obbligazioni/mot/btp/scheda/${id}.html?lang=en`,
    priceSelector: BORSA_PRICE_SELECTOR,
  },
};

// ============================================================================
// INDIVIDUAL PROVIDER IMPLEMENTATIONS
// ============================================================================

/**
 * 1. EODHD Provider (7-day lookback window from // utilities.gs getEODHDprices)
 */
async function fetchFromEodhd(sec, targetDate) {
  const baseUrl = "https://eodhd.com/api/eod/";
  const token = config.eodhdToken;

  if (!token) throw new Error("EODHD API token is missing from environment.");

  const ticker = (sec.source_id || "").trim();
  if (!ticker)
    throw new Error(
      `Missing source_id (ticker) for EODHD security ${sec.security_id}`,
    );

  const endDate = new Date(targetDate);
  const startDate = new Date(endDate);
  startDate.setUTCDate(endDate.getUTCDate() - 7);

  const fromStr = utils.formatDateToISO(startDate);
  const toStr = utils.formatDateToISO(endDate);

  const url = `${baseUrl}${encodeURIComponent(ticker)}?api_token=${token}&fmt=json&from=${fromStr}&to=${toStr}`;
  const res = await fetch(url, { headers: HTTP_HEADERS });

  if (!res.ok) {
    throw new Error(
      `EODHD HTTP ${res.status} for ${sec.security_id} (${ticker})`,
    );
  }

  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) return null;

  const latest = data[data.length - 1];
  return {
    security_id: sec.security_id,
    date: latest.date,
    price: parseFloat(latest.adjusted_close),
  };
}

/**
 * Fetches latest daily market price and quote date using the yahoo-finance2 library.
 * Handles crumb and session management under the hood.
 *
 * @param {Object} sec - Security master record (expects security_id and optional source_id)
 * @param {Date|string} targetDate - Valuation date
 * @returns {Promise<{security_id: string, date: string, price: number}|null>}
 */
export async function fetchFromYahoo(sec, targetDate) {
  const ticker = (sec.source_id || sec.security_id).trim();
  const yahooFinance = new YahooFinance();

  // Define 10-day lookback window
  const period2 = new Date(targetDate);
  period2.setDate(period2.getDate() + 1);

  const period1 = new Date(targetDate);
  period1.setDate(period1.getDate() - 10);

  try {
    const result = await yahooFinance.chart(ticker, {
      period1: period1,
      period2: period2,
      interval: "1d",
    });

    const quotes = result?.quotes || [];

    // Traverse backwards to pick the most recent valid close price
    for (let i = quotes.length - 1; i >= 0; i--) {
      const bar = quotes[i];
      if (bar.close !== null && bar.close !== undefined && !isNaN(bar.close)) {
        return {
          security_id: sec.security_id,
          date: utils.formatDateToISO(new Date(bar.date)),
          price: parseFloat(bar.close),
        };
      }
    }

    // Fallback to meta regularMarketPrice if historical bars are missing
    if (result?.meta?.regularMarketPrice) {
      const marketDate = result.meta.regularMarketTime
        ? utils.formatDateToISO(new Date(result.meta.regularMarketTime * 1000))
        : utils.formatDateToISO(targetDate);

      return {
        security_id: sec.security_id,
        date: marketDate,
        price: parseFloat(result.meta.regularMarketPrice),
      };
    }

    console.warn(
      `[Yahoo] No valid price point found for ${sec.security_id} (${ticker})`,
    );
    return null;
  } catch (err) {
    console.warn(
      `[Yahoo] Fetch failed for ${sec.security_id} (${ticker}): ${err.message}`,
    );
    return null;
  }
}

/**
 * 3. HTML/Cheerio Scraper for Borsa Italiana
 * Routes requests dynamically using sec.source (e.g. BOT, BTP).
 * Uses sec.source_id (typically the ISIN or fund code) to build URLs.
 *
 * @param {Object} sec - Security master record (security_id, source, source_id)
 * @param {Date|string} targetDate - Valuation date
 * @returns {Promise<{security_id: string, date: string, price: number}|null>}
 */
export async function fetchFromBorsaItaliana(sec, targetDate) {
  const secId = sec.security_id;
  const source = (sec.source || "").trim().toUpperCase();
  // Prefer source_id (e.g. ISIN or Morningstar ID) for URL building, fallback to security_id
  const lookupId = (sec.source_id || sec.security_id).trim();
  const fallbackDate = utils.formatDateToISO(targetDate);

  try {
    // --------------------------------------------------
    // Route: Borsa Italiana (BTP, BOT, EUROTLX, BORSA_ITALIANA)
    // --------------------------------------------------
    const routeKey = source;
    const cfg = SCRAPER_ROUTES[routeKey];

    if (!cfg) {
      console.warn(
        `[HTML Scraper] No scraper route configured for source '${source}' (${secId})`,
      );
      return null;
    }

    const res = await fetch(cfg.url(lookupId), {
      headers: HTTP_HEADERS,
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      console.warn(
        `[Borsa Italiana - ${routeKey}] HTTP ${res.status} for ${secId} (${lookupId})`,
      );
      return null;
    }

    const $ = cheerio.load(await res.text());

    let rawPrice = $(cfg.priceSelector).first().text().trim();
    if (!rawPrice) {
      rawPrice = $("span.t-text.-size-lg strong, span.-formatPrice")
        .first()
        .text()
        .trim();
    }

    if (!rawPrice) {
      console.warn(
        `[Borsa Italiana - ${routeKey}] Price selector missed for ${secId} (${lookupId})`,
      );
      return null;
    }

    const price =
      rawPrice.includes(",") && !rawPrice.includes(".")
        ? utils.convertItalianFloat(rawPrice)
        : parseFloat(rawPrice.replace(/,/g, ""));

    return {
      security_id: secId,
      date: fallbackDate,
      price,
    };
  } catch (err) {
    console.warn(
      `[HTML Scraper] Error scraping ${secId} (${source}/${lookupId}): ${err.message}`,
    );
    return null;
  }
}

/**
 * 4. Trustnet Provider for Aegon AGN4648
 * Parses "Mid price: 154.32p (DD/MM/YYYY)" and converts GBX pence to GBP (/ 100)
 */
async function fetchFromTrustnet(sec, targetDate) {
  const trustnetUrl =
    "https://www.trustnet.com/factsheets/P/P4Y4/aegon-blackrock-lifepath-flexi-2046-2048-blk-pn-q";

  const res = await fetch(`https://r.jina.ai/${trustnetUrl}`, {
    headers: { ...HTTP_HEADERS, "X-Return-Format": "text" },
  });

  if (!res.ok) {
    throw new Error(
      `Trustnet fetch failed with HTTP ${res.status} for ${sec.security_id}`,
    );
  }

  const text = await res.text();
  const match = text.match(
    /Mid\s*price\s*:\s*([\d.,]+)\s*p?\s*(?:\(?(\d{2}\/\d{2}\/\d{4})\)?)?/i,
  );

  if (!match) {
    throw new Error(
      `Could not extract 'Mid price:' from Trustnet for ${sec.security_id}`,
    );
  }

  const rawPence = parseFloat(match[1].replace(/,/g, ""));
  const priceGbp = Number((rawPence / 100).toFixed(6));
  const quoteDate = match[2]
    ? utils.formatDateToISO(match[2], "DD/MM/YYYY")
    : utils.formatDateToISO(targetDate);

  return {
    security_id: sec.security_id,
    date: quoteDate,
    price: priceGbp,
  };
}

// ============================================================================
// DIVIDEND PROVIDERS (same source and ticker as the price)
// ============================================================================

/**
 * EODHD /api/div: every distribution between from and to. `date` is the ex-dividend date; unadjustedValue is the
 * amount actually paid per unit (value is split-adjusted), matching the raw prices we store.
 *
 * @returns {Promise<Array<{ex_date: string, pay_date: string|null, amount: number, currency: string}>>}
 */
async function fetchDividendsFromEodhd(sec, from, to) {
  const ticker = (sec.source_id || "").trim();
  if (!config.eodhdToken) throw new Error("EODHD API token is missing from environment.");
  if (!ticker) throw new Error(`Missing source_id (ticker) for EODHD security ${sec.security_id}`);

  const url = `https://eodhd.com/api/div/${encodeURIComponent(ticker)}?api_token=${config.eodhdToken}&fmt=json&from=${from}&to=${to}`;
  const res = await fetch(url, { headers: HTTP_HEADERS });
  if (!res.ok) throw new Error(`EODHD dividends HTTP ${res.status} for ${sec.security_id} (${ticker})`);
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data.map((div) => ({
    ex_date: div.date,
    pay_date: div.paymentDate || null,
    amount: parseFloat(div.unadjustedValue ?? div.value),
    currency: div.currency || sec.currency,
  }));
}

/**
 * Yahoo chart events: distributions between from and to (event date = ex-dividend date), in the quote currency.
 *
 * @returns {Promise<Array<{ex_date: string, pay_date: null, amount: number, currency: string}>>}
 */
async function fetchDividendsFromYahoo(sec, from, to) {
  const ticker = (sec.source_id || sec.security_id).trim();
  const yahooFinance = new YahooFinance();
  const result = await yahooFinance.chart(ticker, {
    period1: new Date(`${from}T00:00:00Z`),
    period2: new Date(`${utils.addDays(to, 1)}T00:00:00Z`),
    interval: "1d",
    events: "div",
  });
  return (result?.events?.dividends || []).map((div) => ({
    ex_date: utils.formatDateToISO(new Date(div.date)),
    pay_date: null,
    amount: parseFloat(div.amount),
    currency: result?.meta?.currency || sec.currency,
  }));
}

/**
 * Routes a security_master row to the dividend feed of its price source. Sources without one return [].
 *
 * @param {Object} sec - Security master record
 * @param {string} from - ISO date, first ex-date wanted
 * @param {string} to - ISO date, last ex-date wanted
 */
export async function fetchSecurityDividends(sec, from, to) {
  switch ((sec.source || "").toUpperCase().trim()) {
    case "EODHD":
      return fetchDividendsFromEodhd(sec, from, to);
    case "YAHOO":
      return fetchDividendsFromYahoo(sec, from, to);
    default:
      return [];
  }
}

// ============================================================================
// PUBLIC DISPATCHER
// ============================================================================

/**
 * Routes a security_master row to its corresponding price provider.
 */
export async function fetchSecurityPrice(sec, targetDate = new Date()) {
  const source = (sec.source || "").toUpperCase().trim();

  switch (source) {
    case "EODHD":
      return fetchFromEodhd(sec, targetDate);
    case "YAHOO":
      return fetchFromYahoo(sec, targetDate);
    case "TRUSTNET":
      return fetchFromTrustnet(sec, targetDate);
    case "BOT":
      return fetchFromBorsaItaliana(sec, targetDate);
    case "BTP":
      return fetchFromBorsaItaliana(sec, targetDate);
    case "EUROTLX":
      return fetchFromBorsaItaliana(sec, targetDate);
    case "BORSA_ITALIANA":
      return fetchFromBorsaItaliana(sec, targetDate);
    case "MORNINGSTAR":
      return fetchFromBorsaItaliana(sec, targetDate);
    default:
      console.warn(
        `[PRICE PROVIDERS] Unsupported source '${source}' for ${sec.security_id}`,
      );
      return null;
  }
}
