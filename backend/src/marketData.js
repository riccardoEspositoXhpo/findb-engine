import * as utils from "./utils.js";
import { query, replaceDataInDb } from "./db.js";
import { config } from "../config.js";

/**
 * Fetches EUR-base FX rates from Frankfurter API.
 * Automatically handles weekend gaps using the latest verified Friday fixing.
 *
 * @param {Date} dateObj - Target evaluation date
 * @returns {Promise<Object<string, number>>} Currency -> Rate map against EUR
 */
async function fetchBceFxRates(dateObj) {
  const day = dateObj.getDay();
  const isWeekend = day === 0 || day === 6;
  const targetDateStr = dateObj.toISOString().slice(0, 10);

  let endpoint = targetDateStr;

  if (isWeekend) {
    // 1. Calculate expected preceding Friday
    const daysToSubtract = day === 0 ? 2 : 1;
    const fridayDate = new Date(dateObj);
    fridayDate.setDate(fridayDate.getDate() - daysToSubtract);
    const expectedFridayStr = fridayDate.toISOString().slice(0, 10);

    // 2. Query /latest on weekends
    const url = "https://api.frankfurter.dev/v1/latest?base=EUR";
    console.log(
      `[FX BCE] Weekend detected (${targetDateStr}). Querying latest fixing via ${url}...`,
    );

    const response = await utils.fetchWithRetry(url);
    if (!response.ok) {
      throw new Error(
        `[FX BCE] API call failed with status ${response.status}`,
      );
    }

    const data = await response.json();

    // 3. Freshness guardrail: verify Friday rate was not down/stale
    if (data.date !== expectedFridayStr) {
      throw new Error(
        `[FX BCE] Stale data detected! Expected Friday fixing (${expectedFridayStr}), ` +
          `but API returned fixing for (${data.date}). Aborting write.`,
      );
    }

    console.log(
      `[FX BCE] Verified Friday fixing (${data.date}). Rolling forward to ${targetDateStr}.`,
    );
    const rates = data.rates || {};
    rates["EUR"] = 1.0;
    return rates;
  }

  // 4. Standard weekday execution: query target date directly
  const isToday = targetDateStr === new Date().toISOString().slice(0, 10);
  endpoint = isToday ? "latest" : targetDateStr;

  const url = `https://api.frankfurter.dev/v1/${endpoint}?base=EUR`;
  const response = await utils.fetchWithRetry(url);

  if (!response.ok) {
    throw new Error(
      `[FX BCE] API call failed for ${targetDateStr} with status ${response.status}`,
    );
  }

  const data = await response.json();
  const rates = data.rates || {};
  rates["EUR"] = 1.0;
  return rates;
}

/**
 * Dynamically queries active FIAT currencies and generates all N * (N - 1) permutation pairs.
 *
 * @returns {Promise<Array<[string, string]>>} Array of [base_currency, quote_currency] tuples
 */
async function getDynamicFiatPairs() {
  const result = await query(`
    SELECT currency_code 
    FROM currencies 
    WHERE type = 'FIAT' AND is_active = true
    ORDER BY currency_code ASC;
  `);

  const fiats = result.rows.map((row) => row.currency_code);
  const pairs = [];

  // Generate all cross-currency permutations, skipping identity (e.g. EUR/EUR)
  for (let i = 0; i < fiats.length; i++) {
    for (let j = 0; j < fiats.length; j++) {
      if (i !== j) {
        pairs.push([fiats[i], fiats[j]]);
      }
    }
  }

  return pairs;
}

/**
 * Computes daily cross-rates for all active FIAT pairs and executes a bulk UPSERT into fx_rates.
 *
 * @param {Object} [options={}]
 * @param {Date|string} [options.date=new Date()] - Target valuation date
 * @returns {Promise<Array<Object>>} Stored FX records
 */
export async function calculateDailyFx(options = {}) {
  const date = options.date ? new Date(options.date) : new Date();
  const dateStr = date.toISOString().split("T")[0];

  console.log(`[FX BATCH] Processing dynamic daily FX for date: ${dateStr}...`);

  // 1. Resolve dynamic pairs from DB and fetch BCE rates in parallel
  const [targetPairs, bceRates] = await Promise.all([
    getDynamicFiatPairs(),
    fetchBceFxRates(date),
  ]);

  console.log(
    `[FX BATCH] Discovered ${targetPairs.length} dynamic FIAT pairs to evaluate.`,
  );

  // 2. Compute algebraic cross-rates (quoteRate / baseRate)
  const fxRecords = [];
  for (const [baseCcy, quoteCcy] of targetPairs) {
    const baseRate = bceRates[baseCcy];
    const quoteRate = bceRates[quoteCcy];

    if (baseRate !== undefined && quoteRate !== undefined && baseRate !== 0) {
      const crossRate = Number((quoteRate / baseRate).toFixed(6));
      fxRecords.push({
        date: dateStr,
        base_currency: baseCcy,
        quote_currency: quoteCcy,
        rate: crossRate,
      });
    } else {
      console.warn(
        `[FX BATCH] Missing rate for pair ${baseCcy}/${quoteCcy} (Base: ${baseRate}, Quote: ${quoteRate})`,
      );
    }
  }

  if (fxRecords.length === 0) {
    console.log("[FX BATCH] No valid FX records computed.");
    return [];
  }

  // 3. Atomic persistence via universal UPSERT helper
  await replaceDataInDb(fxRecords, "fx_rates");
  console.log(
    `[FX BATCH] Successfully persisted ${fxRecords.length} records into "fx_rates".`,
  );

  return fxRecords;
}

/**
 * Fetches batch quotes from CoinMarketCap and computes daily cross-rates against USDC.
 * Automatically handles both CRYPTO and STABLECOIN assets in a single API call.
 *
 * @param {Date|string} [targetDate=new Date()] Optional evaluation date
 * @returns {Promise<Array<Object>>} Computed fx records persisted to DB
 */
export async function calculateCryptoDailyFx(targetDate = new Date()) {
  const dateStr = (
    targetDate instanceof Date ? targetDate : new Date(targetDate)
  )
    .toISOString()
    .slice(0, 10);

  // 1. Fetch active cryptos and stablecoins from DB (excluding USDC base)
  const result = await query(`
    SELECT currency_code 
    FROM currencies 
    WHERE type IN ('CRYPTO', 'STABLECOIN') 
      AND is_active = true 
      AND currency_code != 'USDC';
  `);

  if (result.rows.length === 0) {
    console.log("[CRYPTO BATCH] No active crypto/stablecoin currencies found.");
    return [];
  }

  const targetSymbols = result.rows.map((r) => r.currency_code);
  // Always include USDC in the query to calculate cross-rate and bridge
  const allSymbols = Array.from(new Set([...targetSymbols, "USDC"]));

  console.log(
    `[CRYPTO BATCH] Fetching CMC quotes for ${allSymbols.length} tokens: ${allSymbols.join(", ")}...`,
  );

  // 2. Single batch HTTP request to CoinMarketCap v2 API
  const apiKey = config.cmcApiKey;
  if (!apiKey) {
    throw new Error(
      "[CRYPTO BATCH] Missing CMC_API_KEY in environment variables.",
    );
  }

  const url = `https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest?symbol=${allSymbols.join(",")}&convert=USD`;
  const response = await utils.fetchWithRetry(url, {
    method: "GET",
    headers: {
      "X-CMC_PRO_API_KEY": apiKey,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `[CRYPTO BATCH] CMC API failed with status ${response.status}: ${errorBody}`,
    );
  }

  const json = await response.json();
  const data = json.data || {};

  // Extract prices in USD
  const usdPrices = {};
  for (const sym of allSymbols) {
    if (data[sym] && data[sym][0]?.quote?.USD?.price) {
      usdPrices[sym] = Number(data[sym][0].quote.USD.price);
    } else {
      console.warn(`[CRYPTO BATCH] Price missing from CMC for token "${sym}".`);
    }
  }

  const usdcUsdPrice = usdPrices["USDC"] || 1.0;
  const fxRecords = [];

  // 3. Build TOKEN/USDC records
  for (const sym of targetSymbols) {
    const tokenUsdPrice = usdPrices[sym];
    if (tokenUsdPrice !== undefined) {
      const crossRate = tokenUsdPrice / usdcUsdPrice;
      fxRecords.push({
        date: dateStr,
        base_currency: sym,
        quote_currency: "USDC",
        rate: Number(crossRate.toFixed(8)),
      });
    }
  }

  // 4. Synthetic bridge rate to connect crypto ecosystem with FIAT USD
  fxRecords.push({
    date: dateStr,
    base_currency: "USDC",
    quote_currency: "USD",
    rate: 1.0,
  });

  // 5. Atomic persistence via universal UPSERT helper
  await replaceDataInDb(fxRecords, "fx_rates");
  console.log(
    `[CRYPTO BATCH] Persisted ${fxRecords.length} crypto rates into "fx_rates".`,
  );

  return fxRecords;
}

/**
 * Master Market Data runner for daily batch execution.
 * Triggers BCE and CoinMarketCap FX pipelines concurrently via Promise.all.
 *
 * @param {Date|string} [targetDate=new Date()] Optional evaluation date
 * @returns {Promise<{fiatRecords: Array<Object>, cryptoRecords: Array<Object>}>}
 */
export async function run(targetDate = new Date()) {
  console.log(
    `[MARKET DATA] Starting market data pipeline for ${new Date(targetDate).toISOString().slice(0, 10)}...`,
  );
  const startTime = performance.now();

  // Parallel network I/O execution for maximum throughput
  const [fiatRecords, cryptoRecords] = await Promise.all([
    calculateDailyFx(targetDate),
    calculateCryptoDailyFx(targetDate),
  ]);

  const elapsedSeconds = ((performance.now() - startTime) / 1000).toFixed(2);
  console.log(
    `[MARKET DATA] Pipeline complete in ${elapsedSeconds}s. ` +
      `Persisted ${fiatRecords.length} FIAT and ${cryptoRecords.length} Crypto rates.`,
  );

  return { fiatRecords, cryptoRecords };
}
