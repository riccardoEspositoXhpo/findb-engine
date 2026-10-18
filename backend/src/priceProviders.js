/**
 * This file contains the configuration for the price providers used in the application.
 */
import * as cheerio from "cheerio";
import { config } from "../config.js";
import { utils } from "./utils.js";

// ============================================================================
// INTERNAL SCRAPER PATHS & HEADERS (Abstracted from // local.gs XMLPATHS)
// ============================================================================

const HTTP_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9,it;q=0.8",
};

const BORSA_PRICE_SELECTOR =
  "#fullcontainer main section div:nth-of-type(3) div:nth-of-type(1) article div div div:nth-of-type(2) div span:nth-of-type(1) strong";

const SCRAPER_ROUTES = {
  BORSA_ITALIANA: {
    url: (id) =>
      `https://www.borsaitaliana.it/borsa/etf/scheda/${id}.html?lang=en`,
    priceSelector: BORSA_PRICE_SELECTOR,
  },
  EUROTLX: {
    url: (id) =>
      `https://www.borsaitaliana.it/borsa/obbligazioni/eurotlx/scheda/${id}.html?lang=en`,
    priceSelector: BORSA_PRICE_SELECTOR,
  },
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
  PIR_50: {
    url: () =>
      "https://www.borsaitaliana.it/borsa/fondi/dettaglio/1FADB397095.html?lang=it",
    priceSelector: "span.t-text.-black-warm-60.-formatPrice",
    dateSelector:
      ".l-screen.-sm-6.-md-6.u-pt.summary-fase span.t-text.-block.-size-xs.-xs strong",
  },
  MORNINGSTAR: {
    url: (loc) =>
      `https://www.morningstar.it/it/funds/snapshot/snapshot.aspx?id=${loc}&investmentType=SA`,
    priceSelector: "#overviewQuickstatsDiv tr:nth-child(2) td.line.text",
    dateSelector: "#overviewQuickstatsDiv tr:nth-child(2) td.line.heading",
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

  const fromStr = utils.toIsoDate(startDate);
  const toStr = utils.toIsoDate(endDate);

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
 * 2. Yahoo Finance v8 Chart JSON API Provider (for 0P0000CWZR.F)
 */
async function fetchFromYahoo(sec, targetDate) {
  const ticker = (sec.source_id || sec.security_id).trim();
  const period2 = Math.floor(new Date(targetDate).getTime() / 1000) + 86400;
  const period1 = period2 - 10 * 86400; // 10-day lookback

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${period1}&period2=${period2}&interval=1d`;
  const res = await fetch(url, { headers: HTTP_HEADERS });

  if (!res.ok) {
    throw new Error(
      `Yahoo API HTTP ${res.status} for ${sec.security_id} (${ticker})`,
    );
  }

  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) return null;

  const timestamps = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];

  for (let i = timestamps.length - 1; i >= 0; i--) {
    if (closes[i] !== null && closes[i] !== undefined && !isNaN(closes[i])) {
      return {
        security_id: sec.security_id,
        date: utils.toIsoDate(new Date(timestamps[i] * 1000)),
        price: parseFloat(closes[i]),
      };
    }
  }

  if (result.meta?.regularMarketPrice) {
    const marketDate = result.meta.regularMarketTime
      ? utils.toIsoDate(new Date(result.meta.regularMarketTime * 1000))
      : utils.toIsoDate(targetDate);
    return {
      security_id: sec.security_id,
      date: marketDate,
      price: parseFloat(result.meta.regularMarketPrice),
    };
  }

  return null;
}

/**
 * 3. HTML/Cheerio Scraper Provider (Borsa Italiana BTP/BOT/EuroTLX/ETF, PIR_50, Morningstar)
 */
async function fetchFromHtmlScraper(sec, targetDate) {
  const secId = sec.security_id;
  const loc = (sec.source_id || "").trim();
  const fallbackDate = utils.toIsoDate(targetDate);

  // Route A: PIR_50
  if (loc === "PIR_50") {
    const res = await fetch(SCRAPER_ROUTES.PIR_50.url(), {
      headers: HTTP_HEADERS,
    });
    if (!res.ok) throw new Error(`PIR_50 HTTP ${res.status}`);
    const $ = cheerio.load(await res.text());

    const rawPrice = $(SCRAPER_ROUTES.PIR_50.priceSelector).first().text();
    const rawDate = $(SCRAPER_ROUTES.PIR_50.dateSelector).first().text();

    return {
      security_id: secId,
      date: convertDateFormat(rawDate, "DD/MM/YY") || fallbackDate,
      price: convertITtoUSNumber(rawPrice),
    };
  }

  // Route B: Morningstar (ALLIANZ_* or explicit MORNINGSTAR source)
  if (secId.startsWith("ALLIANZ") || sec.source === "MORNINGSTAR") {
    const res = await fetch(SCRAPER_ROUTES.MORNINGSTAR.url(loc), {
      headers: HTTP_HEADERS,
    });
    if (!res.ok) throw new Error(`Morningstar HTTP ${res.status} for ${secId}`);
    const $ = cheerio.load(await res.text());

    const rawPrice = $(SCRAPER_ROUTES.MORNINGSTAR.priceSelector).first().text();
    const rawDate = $(SCRAPER_ROUTES.MORNINGSTAR.dateSelector)
      .first()
      .text()
      .replace(/NAV/gi, "")
      .replace(/Prezzo di chiusura/gi, "")
      .trim();

    return {
      security_id: secId,
      date: convertDateFormat(rawDate, "DD/MM/YYYY") || fallbackDate,
      price: convertITtoUSNumber(rawPrice),
    };
  }

  // Route C: Borsa Italiana (BTP, BOT, EUROTLX, BORSA_ITALIANA)
  const routeKey = SCRAPER_ROUTES[loc] ? loc : "BORSA_ITALIANA";
  const cfg = SCRAPER_ROUTES[routeKey];

  const res = await fetch(cfg.url(secId), { headers: HTTP_HEADERS });
  if (!res.ok)
    throw new Error(
      `Borsa Italiana (${routeKey}) HTTP ${res.status} for ${secId}`,
    );
  const $ = cheerio.load(await res.text());

  let rawPrice = $(cfg.priceSelector).first().text().trim();
  if (!rawPrice) {
    rawPrice = $("span.t-text.-size-lg strong, span.-formatPrice")
      .first()
      .text()
      .trim();
  }

  const price =
    rawPrice.includes(",") && !rawPrice.includes(".")
      ? convertITtoUSNumber(rawPrice)
      : parseFloat(rawPrice.replace(/,/g, ""));

  return {
    security_id: secId,
    date: fallbackDate,
    price,
  };
}

/**
 * 4. Trustnet Provider for Aegon AGN4648
 * Parses "Mid price: 154.32p (DD/MM/YYYY)" and converts GBX pence to GBP (/ 100)
 */
async function fetchFromTrustnet(sec, targetDate) {
  const trustnetUrl =
    sec.source_id && sec.source_id.startsWith("http")
      ? sec.source_id.trim()
      : "https://www.trustnet.com/factsheets/P/P4Y4/aegon-lifepath-flexi-2046-2048-pn-q";

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
    ? convertDateFormat(match[2], "DD/MM/YYYY")
    : utils.toIsoDate(targetDate);

  return {
    security_id: sec.security_id,
    date: quoteDate,
    price: priceGbp,
  };
}

// ============================================================================
// PUBLIC DISPATCHER
// ============================================================================

/**
 * Routes a security_master row to its corresponding price provider.
 */
export async function fetchSecurityPrice(sec, targetDate = new Date()) {
  const source = (sec.source || "").toUpperCase().trim();

  if (sec.security_id === "AGN4648" || source === "TRUSTNET") {
    return fetchFromTrustnet(sec, targetDate);
  }

  switch (source) {
    case "EODHD":
      return fetchFromEodhd(sec, targetDate);
    case "YAHOO":
      return fetchFromYahoo(sec, targetDate);
    case "IMPORTXML":
    case "BORSA_ITALIANA":
    case "MORNINGSTAR":
      return fetchFromHtmlScraper(sec, targetDate);
    default:
      console.warn(
        `[PRICE PROVIDERS] Unsupported source '${source}' for ${sec.security_id}`,
      );
      return null;
  }
}
