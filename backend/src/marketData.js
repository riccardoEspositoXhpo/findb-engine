import { utils } from "./utils.js";
import { query, replaceDataInDb } from "./db.js";
import { config } from "../config.js";
import { fetchSecurityPrice } from "./priceProviders.js";

export const marketData = {
  run,
  calculateDailyFx,
  calculateCryptoDailyFx,
  loadFxRates,
  currencyConverter,
};

/**
 * Downloads prices for all eligible securities in security_master and commits via replaceDataInDb.
 * Migrated from calculatePrices in // securityData.gs
 *
 * @param {Date|string} [targetDate=new Date()] - Evaluation date
 * @param {Object} [options={}] - Optional filters, e.g. { runOnlyThisId: 'IUSQ' }
 */
export async function calculatePrices(targetDate = new Date(), options = {}) {
  const evalDate =
    targetDate instanceof Date ? targetDate : new Date(targetDate);
  const evalDateStr = utils.formatDateToISO(evalDate);

  console.log(
    `[PRICES BATCH] Starting security price calculation for date: ${evalDateStr}...`,
  );

  // 1. Load active priced securities from security_master
  const queryParams = [];
  let whereClause = `
    WHERE source IS NOT NULL
  `;

  if (options.runOnlyThisId) {
    queryParams.push(options.runOnlyThisId);
    whereClause += ` AND security_id = $1`;
  }

  const { rows: securities } = await query(
    `SELECT *
     FROM security_master
     ${whereClause}
     ORDER BY security_id ASC`,
    queryParams,
  );

  // 2. Filter by valuation schedule
  const eligibleSecurities = securities.filter((sec) => {
    if (options.runOnlyThisId) return true;
    return utils.doesItRunToday(sec, evalDate);
  });

  console.log(
    `[PRICES BATCH] Found ${eligibleSecurities.length} securities scheduled to run today.`,
  );
  if (eligibleSecurities.length === 0) return [];

  // 3. Fetch prices in bounded parallel chunks (10 at a time)
  const CONCURRENCY_LIMIT = 10;
  const finalPrices = [];

  for (let i = 0; i < eligibleSecurities.length; i += CONCURRENCY_LIMIT) {
    const chunk = eligibleSecurities.slice(i, i + CONCURRENCY_LIMIT);
    const settled = await Promise.allSettled(
      chunk.map(async (sec) => {
        try {
          return {
            sec,
            data: await fetchSecurityPrice(sec, evalDate),
          };
        } catch (err) {
          // Isolate single provider failures without breaking the batch
          console.warn(
            `[PRICES BATCH] Warning: Failed to fetch price for ${sec.security_id} (${sec.source}): ${err.message}`,
          );
          return { sec, data: null };
        }
      }),
    );

    for (const item of settled) {
      let issue = false;
      if (item.status === "rejected") {
        issue = true;
        console.error(
          `[PRICES BATCH] Provider error:`,
          item.reason?.message || item.reason,
        );
        continue;
      }

      const { sec, data } = item.value;
      // round to 5 decimal places to keep it clean
      const parsedPrice = Number(parseFloat(data?.price).toFixed(5));

      // Filter out 0 or NaN prices (matching finalPrices filter in // securityData.gs)
      if (!data || isNaN(parsedPrice) || parsedPrice <= 0) {
        issue = true;
        console.warn(
          `[PRICES BATCH] Skipping invalid/zero price for ${sec.security_id}`,
        );
        continue;
      }

      const priceDateStr = data.date || evalDateStr;

      finalPrices.push({
        date: priceDateStr,
        security_id: sec.security_id,
        price: parsedPrice,
      });

      // Log retroactive historical price updates
      if (priceDateStr !== evalDateStr) {
        issue = true;
        console.log(
          `[PRICES BATCH] Historical price for ${sec.security_id} on ${priceDateStr} (${parsedPrice}).`,
        );
      }

      if (!issue) {
        console.log(
          `[PRICES BATCH] Price for ${sec.security_id} on ${priceDateStr} (${parsedPrice})`,
        );
      }
    }
  }

  // 4. Commit to Postgres using our existing replaceDataInDb abstraction
  if (finalPrices.length > 0) {
    await replaceDataInDb(finalPrices, "prices");
    console.log(
      `[PRICES BATCH] Successfully upserted ${finalPrices.length} prices.`,
    );
  } else {
    console.warn(`[PRICES BATCH] No valid prices to commit.`);
  }

  return finalPrices;
}

/**
 * Fetches EUR-base FX rates from Frankfurter API.
 * Automatically handles weekend gaps using the latest verified Friday fixing.
 *
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
 * @param {Date|string} [targetDate=new Date()] - Target valuation date
 * @returns {Promise<Array<Object>>} Stored FX records
 */
export async function calculateDailyFx(targetDate = new Date()) {
  const date = targetDate instanceof Date ? targetDate : new Date(targetDate);
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
 * Calls CoinMarketCap v2 quotes/{latest|historical} with the given query string and returns json.data.
 * Response is keyed by CMC id when querying by id, by symbol (array of matches) when querying by symbol.
 *
 * @param {string} queryString - e.g. "id=1,1027" or "symbol=BTC,ETH"
 * @param {"latest"|"historical"} [endpoint="latest"]
 * @returns {Promise<Object>} CMC data payload
 */
async function fetchCmcQuotes(queryString, endpoint = "latest") {
  const apiKey = config.cmcApiKey;
  if (!apiKey) {
    throw new Error(
      "[CRYPTO BATCH] Missing CMC_API_KEY in environment variables.",
    );
  }

  // skip_invalid avoids failing the whole batch on a single bad id/symbol
  const url = `https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/${endpoint}?${queryString}&convert=USD&skip_invalid=true`;
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
  return json.data || {};
}

/**
 * Fetches the CoinMarketCap daily close (quote stamped at D+1 00:00 UTC) for each CMC id.
 * Used when the batch runs for a past date.
 *
 * @param {Array<string>} ids - CMC ids
 * @param {string} dateStr - Target date YYYY-MM-DD
 * @returns {Promise<Object<string, number>>} CMC id -> USD close
 */
async function fetchCmcHistoricalCloses(ids, dateStr) {
  const closeStamp = new Date(`${dateStr}T00:00:00Z`);
  closeStamp.setUTCDate(closeStamp.getUTCDate() + 1);
  const closeIso = closeStamp.toISOString();

  const prices = {};
  const CHUNK_SIZE = 20;
  for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
    const chunk = ids.slice(i, i + CHUNK_SIZE).join(",");
    const data = await fetchCmcQuotes(
      `id=${chunk}&time_start=${dateStr}&time_end=${closeIso}&interval=daily`,
      "historical",
    );
    for (const [id, coin] of Object.entries(data)) {
      const close = (coin?.quotes || []).find(
        (q) => new Date(q.timestamp).toISOString() === closeIso,
      );
      if (close?.quote?.USD?.price) prices[id] = close.quote.USD.price;
    }
  }
  return prices;
}

/**
 * Fetches batch quotes from CoinMarketCap and computes daily cross-rates against USDC.
 * Tokens are resolved by CMC id (security_master.source_id) to avoid ticker collisions;
 * tokens without an id fall back to the ambiguous symbol lookup.
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

  // 1. Fetch active cryptos and stablecoins with their CMC id (USDC always included as cross-rate base)
  const result = await query(`
    SELECT c.currency_code, sm.source_id
    FROM currencies c
    LEFT JOIN security_master sm ON sm.security_id = c.currency_code
    WHERE c.type IN ('CRYPTO', 'STABLECOIN')
      AND (c.is_active = true OR c.currency_code = 'USDC');
  `);

  const targetSymbols = result.rows
    .map((r) => r.currency_code)
    .filter((sym) => sym !== "USDC");

  if (targetSymbols.length === 0) {
    console.log("[CRYPTO BATCH] No active crypto/stablecoin currencies found.");
    return [];
  }

  // Split tokens: resolved by CMC id vs legacy symbol fallback
  const cmcIdBySymbol = {};
  const symbolFallback = [];
  for (const { currency_code, source_id } of result.rows) {
    if (source_id && /^\d+$/.test(String(source_id).trim())) {
      cmcIdBySymbol[currency_code] = String(source_id).trim();
    } else {
      symbolFallback.push(currency_code);
    }
  }
  if (!cmcIdBySymbol["USDC"] && !symbolFallback.includes("USDC")) {
    symbolFallback.push("USDC");
  }

  const idList = Object.values(cmcIdBySymbol);
  console.log(
    `[CRYPTO BATCH] Fetching CMC quotes for ${idList.length} tokens by id and ${symbolFallback.length} by symbol` +
      (symbolFallback.length ? ` (${symbolFallback.join(", ")})` : "") +
      "...",
  );

  // 2. Batch HTTP requests to CoinMarketCap v2 API (id and symbol params can't be mixed).
  // Past dates use the historical daily close: "latest" quotes would be stamped with a stale date.
  const isPastDate = dateStr < new Date().toISOString().slice(0, 10);
  if (isPastDate && symbolFallback.length) {
    console.warn(
      `[CRYPTO BATCH] Past date ${dateStr}: skipping ${symbolFallback.length} tokens without CMC id (${symbolFallback.join(", ")}).`,
    );
  }

  const [idPrices, symbolData] = await Promise.all([
    !idList.length
      ? {}
      : isPastDate
        ? fetchCmcHistoricalCloses(idList, dateStr)
        : fetchCmcQuotes(`id=${idList.join(",")}`).then((data) =>
            Object.fromEntries(
              Object.entries(data).map(([id, coin]) => [
                id,
                coin?.quote?.USD?.price,
              ]),
            ),
          ),
    symbolFallback.length && !isPastDate
      ? fetchCmcQuotes(`symbol=${symbolFallback.join(",")}`)
      : {},
  ]);

  // Extract prices in USD
  const usdPrices = {};
  for (const [sym, cmcId] of Object.entries(cmcIdBySymbol)) {
    const price = idPrices[cmcId];
    if (price) {
      usdPrices[sym] = Number(price);
    } else {
      console.warn(
        `[CRYPTO BATCH] Price missing from CMC for token "${sym}" (id ${cmcId}).`,
      );
    }
  }
  for (const sym of symbolFallback) {
    const matches = symbolData[sym] || [];
    if (matches.length > 1) {
      console.warn(
        `[CRYPTO BATCH] Ambiguous symbol "${sym}" (${matches.length} CMC matches, using first). Set security_master.source_id to the CMC id.`,
      );
    }
    if (matches[0]?.quote?.USD?.price) {
      usdPrices[sym] = Number(matches[0].quote.USD.price);
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

// In-memory fx cache (replaces GAS cachedDatabase for fxRateDaily/cryptoRateDaily):
// "BASE/QUOTE" -> [{ date: "YYYY-MM-DD", rate }] sorted by date ascending
let fxCache = null;
// Currency graph: currency -> Map(neighbour -> [{ pair, inverse }]) (a hop can be served by A/B or by 1 / B/A)
let fxGraph = null;
// "FROM>TO" -> routes that resolved at least once (shortest first, then date-specific fallbacks)
const fxRouteCache = new Map();
const fxWarnings = new Set();

// Synthetic bridge between the stablecoin quote and fiat, valid for any date (GAS: virtual USDCUSD = 1).
// Stored USDC/USD rows exist only since 2026-10-11; history before that is quoted vs USDT/USDC with no fiat link.
const FX_CONSTANT_PAIRS = { "USDC/USD": 1 };

/**
 * Loads the whole fx_rates table into memory. Must run before currencyConverter.
 * Without force it's a no-op when the cache is already loaded, so every consumer (valuation, aggregates, tax...)
 * can just call it first thing. Whoever writes fx_rates (marketData.run) reloads with { force: true }.
 * Goes through the active transaction, so dry runs see the rates written earlier in the same run.
 *
 * @param {Object} [options={}]
 * @param {boolean} [options.force=false] - Reload even if the cache is already loaded
 */
export async function loadFxRates({ force = false } = {}) {
  if (fxCache && !force) return;

  const { rows } = await query(`
    SELECT to_char(date, 'YYYY-MM-DD') AS date, base_currency, quote_currency, rate
    FROM fx_rates
    ORDER BY base_currency, quote_currency, date`);

  fxCache = new Map();
  for (const row of rows) {
    const pair = `${row.base_currency}/${row.quote_currency}`;
    if (!fxCache.has(pair)) fxCache.set(pair, []);
    fxCache.get(pair).push({ date: row.date, rate: Number(row.rate) });
  }

  fxGraph = new Map();
  const addEdge = (from, to, pair, inverse) => {
    if (!fxGraph.has(from)) fxGraph.set(from, new Map());
    const neighbours = fxGraph.get(from);
    if (!neighbours.has(to)) neighbours.set(to, []);
    neighbours.get(to).push({ pair, inverse });
  };
  for (const pair of new Set([...fxCache.keys(), ...Object.keys(FX_CONSTANT_PAIRS)])) {
    const [base, quote] = pair.split("/");
    addEdge(base, quote, pair, false);
    addEdge(quote, base, pair, true);
  }

  fxRouteCache.clear();
  fxWarnings.clear();
  console.log(`[FX CONVERTER] Loaded ${rows.length} rates across ${fxCache.size} pairs.`);
}

/** Latest { date, rate } on or before dateStr (binary search, no staleness limit), or null. */
function getLatestFxRate(pair, dateStr) {
  if (pair in FX_CONSTANT_PAIRS) return { date: dateStr, rate: FX_CONSTANT_PAIRS[pair] };

  const series = fxCache.get(pair);
  if (!series || series[0].date > dateStr) return null;

  let lo = 0;
  let hi = series.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (series[mid].date <= dateStr) lo = mid;
    else hi = mid - 1;
  }
  return series[lo];
}

/**
 * Rate for one hop (from -> to) on a date: tries every stored direction (A/B, or 1 / B/A) and keeps the most recent
 * observation on or before the date. Null if no direction has data yet.
 */
function getHopRate(from, to, dateStr) {
  let best = null;
  for (const { pair, inverse } of fxGraph.get(from)?.get(to) || []) {
    const observation = getLatestFxRate(pair, dateStr);
    if (observation && (!best || observation.date > best.date)) {
      best = { date: observation.date, rate: inverse ? 1 / observation.rate : observation.rate };
    }
  }
  return best ? best.rate : null;
}

/**
 * Shortest conversion route (BFS) through the currency graph. With dateStr, only hops that have a rate on or
 * before that date are walked (history is quoted vs USDT, recent data vs USDC).
 * Migrated from buildCurrencyGraph + findShortestCurrencyPath in // fxRates.gs
 *
 * @returns {Array<string>|null} Currencies along the route, e.g. ["BTC", "USDC", "USD", "EUR"]
 */
function findFxRoute(currencyFrom, currencyTo, dateStr = null) {
  const visited = new Set([currencyFrom]);
  const queue = [[currencyFrom]];
  while (queue.length > 0) {
    const route = queue.shift();
    const node = route[route.length - 1];
    if (node === currencyTo) return route;

    for (const neighbour of fxGraph.get(node)?.keys() || []) {
      if (visited.has(neighbour)) continue;
      if (dateStr && getHopRate(node, neighbour, dateStr) === null) continue;
      visited.add(neighbour);
      queue.push([...route, neighbour]);
    }
  }
  return null;
}

/** Multiplies the hop rates along a route, or null if any hop has no rate on or before the date. */
function rateAlongRoute(route, dateStr) {
  let rate = 1;
  for (let i = 0; i < route.length - 1; i++) {
    const hopRate = getHopRate(route[i], route[i + 1], dateStr);
    if (hopRate === null) return null;
    rate *= hopRate;
  }
  return rate;
}

function warnFxOnce(key, message) {
  if (fxWarnings.has(key)) return;
  fxWarnings.add(key);
  console.warn(message);
}

/**
 * Converts any fiat/crypto/stablecoin currency into any other for a date: direct pair, inverse pair, or the shortest
 * chain (e.g. SOL -> USDC -> USD -> EUR). Each hop uses its latest rate on or before the date (no staleness limit).
 * Stablecoins use their real market rate (USDT via USDT/USDC); only USDC/USD is a constant 1.
 * Migrated from currencyConverter in // fxRates.gs
 *
 * @param {string} currencyFrom - Currency code (not a SECURITY_ID: CASH_EUR -> EUR is the caller's job)
 * @param {string} currencyTo - Currency code
 * @param {Date|string} [date=new Date()] - Valuation date
 * @returns {number|null} Rate (1 unit of currencyFrom in currencyTo), or null if unresolvable (GAS returned 0)
 */
export function currencyConverter(currencyFrom, currencyTo, date = new Date()) {
  if (!fxCache) {
    throw new Error("[FX CONVERTER] fx cache not loaded: call loadFxRates() first.");
  }
  if (currencyFrom === currencyTo) return 1;

  const dateStr = utils.formatDateToISO(date);
  const routeKey = `${currencyFrom}>${currencyTo}`;

  // Fast path: routes that already worked for this pair, starting with the shortest one ignoring dates
  if (!fxRouteCache.has(routeKey)) {
    const shortestRoute = findFxRoute(currencyFrom, currencyTo);
    fxRouteCache.set(routeKey, shortestRoute ? [shortestRoute] : []);
  }
  const knownRoutes = fxRouteCache.get(routeKey);
  if (knownRoutes.length === 0) {
    warnFxOnce(routeKey, `[FX CONVERTER] No conversion route between ${currencyFrom} and ${currencyTo}.`);
    return null;
  }
  for (const route of knownRoutes) {
    const rate = rateAlongRoute(route, dateStr);
    if (rate !== null) return rate;
  }

  // Slow path: re-route using only hops with data on or before the date (e.g. history quoted vs USDT)
  const datedRoute = findFxRoute(currencyFrom, currencyTo, dateStr);
  if (!datedRoute) {
    warnFxOnce(
      `${routeKey}@${dateStr.slice(0, 7)}`,
      `[FX CONVERTER] No ${currencyFrom} -> ${currencyTo} rate on or before ${dateStr}.`,
    );
    return null;
  }
  knownRoutes.push(datedRoute);
  return rateAlongRoute(datedRoute, dateStr);
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
  const [fiatRecords, cryptoRecords, priceRecords] = await Promise.all([
    calculateDailyFx(targetDate),
    calculateCryptoDailyFx(targetDate),
    calculatePrices(targetDate),
  ]);

  // New rates were just written: reload the in-memory fx cache for everything downstream
  await loadFxRates({ force: true });

  const elapsedSeconds = ((performance.now() - startTime) / 1000).toFixed(2);
  console.log(
    `[MARKET DATA] Pipeline complete in ${elapsedSeconds}s. ` +
      `Persisted ${fiatRecords.length} FIAT and ${cryptoRecords.length} Crypto rates.`,
  );

  return { fiatRecords, cryptoRecords, priceRecords };
}
