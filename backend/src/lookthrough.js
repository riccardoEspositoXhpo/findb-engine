import YahooFinance from "yahoo-finance2";
import { load } from "cheerio";
import { query, withSavepoint } from "./db.js";
import { utils } from "./utils.js";
import { batchLog } from "./batchLog.js";
import { M3, M3_FONT, renderDynamicData, sendHtmlEmail } from "./qcNotification.js";

export const lookthrough = {
  run,
  buildShapes,
  sendReport,
  buildReportHtml,
};

// Every request says who we are (user, 2026-10-31: no browser disguise); one fund at a time, a pause between requests
const USER_AGENT = "findb-engine (personal use)";
const POLITE_DELAY_MS = 1500;
const OPEN_END = "2222-12-31";
const LOOKTHROUGH_ASSET_TYPES = ["ETF", "FUND", "STRUCTURED_PRODUCT"];
// A geography whose unknown part (justETF's "Other", Vanguard's countries below the top 15, FT regions without a
// currency) is above this share of the equity sleeve doesn't replace the current shape
const MAX_UNKNOWN = 0.25;
// Sleeves below this weight (%) don't need a source (their few points go to Equity Other / Fixed Income Other)
const MIN_SLEEVE_PCT = 5;
// Currency from geography only when the fund is mostly equity: the rest is assumed in the fund's currency
const MIN_EQUITY_FOR_CURRENCY_PCT = 75;
// A new interval only when a weight moves by more than this (percentage points)
const MIN_CHANGE_PCT = 0.05;
const ISSUERS = ["ISHARES", "XTRACKERS", "VANGUARD"];

// ============================================================================
// COUNTRY / REGION / CURRENCY MAPPING
// ============================================================================

const NA = "North America";
const EU = "Europe";
const AP = "Asia Pacific";
const EM = "Emerging Markets";
const LA = "Latin America";
const MEA = "Middle East and Africa";
// MSCI market classification, currency of the country's equities, names as the sources write them
const COUNTRIES = [
  [NA, "USD", "United States", "United States of America", "USA", "US"],
  [NA, "CAD", "Canada"],
  [EU, "GBP", "United Kingdom", "UK"],
  [EU, "CHF", "Switzerland"],
  [EU, "DKK", "Denmark"],
  [EU, "SEK", "Sweden"],
  [EU, "NOK", "Norway"],
  [EU, "EUR", "Germany"],
  [EU, "EUR", "France"],
  [EU, "EUR", "Netherlands"],
  [EU, "EUR", "Spain"],
  [EU, "EUR", "Italy"],
  [EU, "EUR", "Belgium"],
  [EU, "EUR", "Austria"],
  [EU, "EUR", "Ireland"],
  [EU, "EUR", "Finland"],
  [EU, "EUR", "Portugal"],
  [EU, "EUR", "Luxembourg"],
  [EM, "EUR", "Greece"],
  [EM, "PLN", "Poland"],
  [EM, "TRY", "Turkey", "Turkiye"],
  [EM, "HUF", "Hungary"],
  [EM, "CZK", "Czech Republic"],
  [AP, "JPY", "Japan"],
  [AP, "AUD", "Australia"],
  [AP, "NZD", "New Zealand"],
  [AP, "HKD", "Hong Kong"],
  [AP, "SGD", "Singapore"],
  [EM, "CNY", "China"],
  [EM, "TWD", "Taiwan"],
  [EM, "KRW", "Korea (South)", "South Korea", "Korea, Republic of", "Republic of Korea", "Korea"],
  [EM, "INR", "India"],
  [EM, "IDR", "Indonesia"],
  [EM, "THB", "Thailand"],
  [EM, "MYR", "Malaysia"],
  [EM, "PHP", "Philippines"],
  [LA, "BRL", "Brazil"],
  [LA, "MXN", "Mexico"],
  [LA, "CLP", "Chile"],
  [LA, "PEN", "Peru"],
  [LA, "COP", "Colombia"],
  [LA, "ARS", "Argentina"],
  [MEA, "ILS", "Israel"],
  [MEA, "ZAR", "South Africa"],
  [MEA, "SAR", "Saudi Arabia"],
  [MEA, "AED", "United Arab Emirates"],
  [MEA, "QAR", "Qatar"],
  [MEA, "KWD", "Kuwait"],
];
// FT (Morningstar) regions: groups of countries, currency only when the group has one
const REGION_GROUPS = [
  [EM, null, "Europe - Emerging", "Emerging Europe", "Asia - Emerging", "Emerging Asia"],
  [EU, null, "Europe - ex Euro"],
  [EU, "EUR", "Eurozone"],
  [LA, null, "Latin America"],
  [AP, null, "Asia - Developed", "Developed Asia"],
  [AP, "AUD", "Australasia"],
  [MEA, null, "Africa", "Middle East"],
];
const GEOGRAPHY = new Map();
for (const [region, currency, ...names] of [...COUNTRIES, ...REGION_GROUPS])
  for (const name of names) GEOGRAPHY.set(name.toLowerCase(), { region, currency });
// FT region table: these rows are the sums of the rows below them
const FT_PARENT_REGIONS = new Set(["americas", "greater asia", "greater europe"]);
// Holding asset classes (issuer files) -> ASSET_CLASS_LT
const HOLDING_ASSET_CLASSES = {
  equity: "Equity", equities: "Equity", stock: "Equity", "fixed income": "Fixed Income", bond: "Fixed Income", bonds: "Fixed Income",
  cash: "Liquidity", "money market": "Liquidity", fx: "Liquidity", futures: "Liquidity", future: "Liquidity",
  "cash collateral and margins": "Liquidity", "cash and/or derivatives": "Liquidity",
};
const GOVERNMENT_SECTORS = /treasur|government|sovereign|agency|supranational|municipal/i;
const EQUITY_CLASSIFICATIONS = {
  [NA]: "Equity North America", [EU]: "Equity Europe", [AP]: "Equity Asia Pacific", [EM]: "Equity Emerging Markets",
  [LA]: "Equity Latin America", [MEA]: "Equity Middle East and Africa",
};

// ============================================================================
// RUN
// ============================================================================

/**
 * Monthly lookthrough step (monthlyBatch): for every fund held, the lookthrough shapes (CURRENCY_LT, ASSET_CLASS_LT,
 * REGION_LT, ASSET_CLASSIFICATION_LT) from the best source of each dimension (buildShapes), written as a new interval
 * starting today when they changed (the previous one is closed: history kept). The daily breakdowns pick them up that
 * night. Funds without ISIN or issuer feed (pension lines) keep their static rows; a source that fails is logged and
 * skipped (the shape stays as it was).
 *
 * @param {Date|string} [targetDate=new Date()]
 * @returns {Promise<{date: string, funds: Array<Object>}>} one report row per fund
 */
export async function run(targetDate = new Date()) {
  const dateStr = utils.formatDateToISO(targetDate);
  const catalog = new Map();
  for (const row of (await query(`SELECT breakdown, sector FROM breakdown_catalog WHERE breakdown LIKE '%\\_LT';`)).rows)
    (catalog.get(row.breakdown) ?? catalog.set(row.breakdown, new Set()).get(row.breakdown)).add(row.sector);
  const { rows: funds } = await query(
    `SELECT s.*, round(sum(p.market_value_eur))::float AS value_eur
     FROM positions p
     JOIN (SELECT portfolio_id, max(date) AS date FROM nav WHERE date <= $1 GROUP BY 1) latest ON latest.portfolio_id = p.portfolio_id AND latest.date = p.date
     JOIN portfolios f ON f.portfolio_id = p.portfolio_id
     JOIN security_master s ON s.security_id = p.security_id
     WHERE f.closed_date IS NULL AND abs(p.quantity) > 1e-5 AND s.asset_type = ANY($2)
     GROUP BY s.security_id ORDER BY value_eur DESC;`,
    [dateStr, LOOKTHROUGH_ASSET_TYPES],
  );

  const report = [];
  for (const fund of funds) {
    const row = { fund: fund.security_id, value_eur: fund.value_eur, sources: {}, as_of: null, changed: [], status: "updated" };
    report.push(row);
    if (fund.lookthrough_source === "OFF") {
      row.status = "off";
      continue;
    }
    if (!fund.isin && !ISSUERS.includes(fund.lookthrough_source)) {
      row.status = "static";
      continue;
    }
    const fragments = [];
    const failures = [];
    for (const [name, adapter] of adaptersFor(fund)) {
      try {
        const fragment = await adapter(fund);
        if (fragment) fragments.push(fragment);
      } catch (error) {
        console.warn(`[LOOKTHROUGH] ${fund.security_id}: ${name} failed: ${error.message}`);
        failures.push(`${name}: ${error.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, POLITE_DELAY_MS));
    }
    const shapes = buildShapes(fund, fragments, catalog, dateStr);
    // A source failing for a fund another source covers is noise; a fund left without data is a warning
    if (!shapes.size) {
      row.status = "no data";
      batchLog.warn("lookthrough", fund.security_id, `no source answered, the current lookthrough stays${failures.length ? ` (${failures.join("; ")})` : ""}.`);
      continue;
    }
    if (ISSUERS.includes(fund.lookthrough_source) && !fragments.some((fragment) => fragment.source === fund.lookthrough_source))
      batchLog.warn("lookthrough", fund.security_id, `issuer file failed, generic sources used (${failures.join("; ")}).`);
    try {
      await withSavepoint(async () => {
        for (const [breakdown, shape] of shapes) {
          row.sources[breakdown] = shape.source;
          if (!row.as_of || shape.asOf < row.as_of) row.as_of = shape.asOf;
          if (await writeShape(fund.security_id, breakdown, shape, dateStr)) row.changed.push(breakdown);
        }
      });
      if (!row.changed.length) row.status = "unchanged";
    } catch (error) {
      row.status = "failed";
      batchLog.warn("lookthrough", fund.security_id, `write failed: ${error.message}`);
    }
  }
  const counts = Object.groupBy(report, (row) => row.status);
  console.log(
    `[LOOKTHROUGH] ${funds.length} funds: ${Object.entries(counts).map(([status, rows]) => `${rows.length} ${status}`).join(", ")}.`,
  );
  return { date: dateStr, funds: report };
}

/**
 * Sources of a fund in priority order: its issuer file, else the generic ones by ISIN (Yahoo: asset split; FT: mostly
 * mutual funds; justETF: ETFs; each one answers null for what it doesn't list). Vanguard's page has no asset split: Yahoo adds it. (fondsweb was dropped: its bot protection rejects
 * scripted requests, user 2026-10-31: no workarounds.)
 */
function adaptersFor(fund) {
  const issuer = { ISHARES: fetchIshares, XTRACKERS: fetchXtrackers, VANGUARD: fetchVanguard }[fund.lookthrough_source];
  if (fund.lookthrough_source === "VANGUARD") return [["VANGUARD", issuer], ["YAHOO", fetchYahoo]];
  if (issuer) return [[fund.lookthrough_source, issuer]];
  return [["YAHOO", fetchYahoo], ["FT", fetchFt], ["JUSTETF", fetchJustEtf]];
}

/**
 * Writes one shape as of today when it differs from the one active today: the active interval is closed today, a rerun
 * the same day replaces today's rows.
 *
 * @returns {Promise<boolean>} true when written
 */
async function writeShape(securityId, breakdown, shape, dateStr) {
  const { rows: current } = await query(
    `SELECT sector, weight::float AS weight FROM lookthrough_data WHERE security_id = $1 AND breakdown = $2 AND start_date <= $3 AND end_date > $3;`,
    [securityId, breakdown, dateStr],
  );
  const same =
    current.length === shape.sectors.size &&
    current.every((row) => Math.abs((shape.sectors.get(row.sector) ?? NaN) - row.weight) <= MIN_CHANGE_PCT);
  if (same) return false;
  await query(`DELETE FROM lookthrough_data WHERE security_id = $1 AND breakdown = $2 AND start_date >= $3;`, [securityId, breakdown, dateStr]);
  await query(`UPDATE lookthrough_data SET end_date = $3 WHERE security_id = $1 AND breakdown = $2 AND end_date > $3;`, [securityId, breakdown, dateStr]);
  const rows = [...shape.sectors];
  await query(
    `INSERT INTO lookthrough_data (start_date, end_date, security_id, breakdown, sector, weight, source, as_of)
     VALUES ${rows.map((_, i) => `($1, $2, $3, $4, $${i * 2 + 7}, $${i * 2 + 8}, $5, $6)`).join(", ")};`,
    [dateStr, OPEN_END, securityId, breakdown, shape.source, shape.asOf, ...rows.flat()],
  );
  return true;
}

// ============================================================================
// SHAPES (the soup: each dimension from the best source that has it)
// ============================================================================

/**
 * Lookthrough shapes of a fund from its source fragments (user, 2026-10-31: one source per dimension, never two
 * averaged). The asset split sizes the sleeves; equity is spread by its geography, bonds by government / corporate.
 * Bonds have no region (user): they take the fund's region attribute, cash "No Region".
 * - ASSET_CLASS_LT: issuer file > Yahoo > FT
 * - equity geography: issuer file > FT regions > justETF countries (each with at most MAX_UNKNOWN unknown)
 * - CURRENCY_LT: the issuer file's holding currencies, else (mostly equity funds) equity by its geography + the rest in
 *   the fund's currency
 * - ASSET_CLASSIFICATION_LT: equity by region, bonds government / corporate (issuer file)
 * A dimension is written only when every material sleeve (>= MIN_SLEEVE_PCT) has a source: a shape that would be
 * mostly "Other" never replaces the current one (static rows, proxy, attributes). Small leftovers go to Equity Other /
 * Fixed Income Other; sectors outside breakdown_catalog to "Other".
 *
 * @param {Object} fund - security_master row
 * @param {Array<Object>} fragments - { source, asOf, assets, geography, geographyBasis, currencies, bonds } in priority order
 * @param {Map<string, Set<string>>} catalog - breakdown -> sectors
 * @param {string} dateStr - as-of date of the sources that don't publish one (Yahoo, Xtrackers)
 * @returns {Map<string, {sectors: Map<string, number>, source: string, asOf: string}>}
 */
export function buildShapes(fund, fragments, catalog, dateStr) {
  const shapes = new Map();
  const assetsFrom = fragments.find((fragment) => fragment.assets);
  if (!assetsFrom) return shapes;
  const assets = assetsFrom.assets;
  const equity = assets.get("Equity") ?? 0;
  const liquidity = assets.get("Liquidity") ?? 0;
  const fixedIncome = assets.get("Fixed Income") ?? 0;
  const rest = 100 - equity - liquidity; // bonds and other: the fund's own region / currency
  const issuer = fragments.find((fragment) => ISSUERS.includes(fragment.source));
  const bySource = (source) => fragments.find((fragment) => fragment.source === source);
  const [geographyFrom, geography] =
    [issuer, bySource("FT"), bySource("JUSTETF")]
      .filter((fragment) => fragment?.geography)
      .map((fragment) => [fragment, equityGeography(fragment.geography, fragment.geographyBasis)])
      .find(([, candidate]) => candidate.unknown <= MAX_UNKNOWN) ?? [];
  const bondsFrom = issuer?.bonds ? issuer : null;
  const equityKnown = geography || equity < MIN_SLEEVE_PCT;
  const bondsKnown = bondsFrom || fixedIncome < MIN_SLEEVE_PCT;

  const shape = (breakdown, parts, used) => {
    const sectors = new Map();
    for (const [sector, weight] of parts) {
      const known = catalog.get(breakdown)?.has(sector) ? sector : "Other";
      sectors.set(known, (sectors.get(known) ?? 0) + weight);
    }
    // Crumbs (< 0.05 points) go to "Other", so every shape sums to 100
    for (const [sector, weight] of sectors)
      if (Math.abs(weight) < 0.05 && sector !== "Other") {
        sectors.delete(sector);
        sectors.set("Other", (sectors.get("Other") ?? 0) + weight);
      }
    for (const [sector, weight] of sectors) {
      if (Math.abs(weight) < 0.005) sectors.delete(sector);
      else sectors.set(sector, Math.round(weight * 100) / 100);
    }
    const sources = [...new Set(used.filter(Boolean))];
    const dates = sources.map((fragment) => fragment.asOf ?? dateStr).sort();
    shapes.set(breakdown, { sectors, source: sources.map((fragment) => fragment.source).join("+"), asOf: dates[0] });
  };
  const spread = (total, fractions) => [...fractions].map(([sector, fraction]) => [sector, total * fraction]);

  shape("ASSET_CLASS_LT", [...assets], [assetsFrom]);

  if (equityKnown)
    shape(
      "REGION_LT",
      [...(geography ? spread(equity, geography.regions) : [["Other", equity]]), [fund.region, rest], ["No Region", liquidity]],
      [assetsFrom, geographyFrom],
    );

  if (issuer?.currencies) shape("CURRENCY_LT", [...issuer.currencies], [issuer]);
  else if (equityKnown && (geography?.currencyUnknown ?? 0) <= MAX_UNKNOWN && equity + liquidity >= MIN_EQUITY_FOR_CURRENCY_PCT)
    shape(
      "CURRENCY_LT",
      [...(geography ? spread(equity, geography.currencies) : [["Other", equity]]), [fund.currency, rest + liquidity]],
      [assetsFrom, geographyFrom],
    );

  if (equityKnown && bondsKnown) {
    const equityParts = geography
      ? spread(equity, geography.regions).map(([region, weight]) => [EQUITY_CLASSIFICATIONS[region] ?? "Equity Other", weight])
      : [["Equity Other", equity]];
    const bondParts = bondsFrom
      ? [
          ["Fixed Income Developed Government", fixedIncome * bondsFrom.bonds.government],
          ["Fixed Income Developed Corporate", fixedIncome * bondsFrom.bonds.corporate],
        ]
      : [["Fixed Income Other", fixedIncome]];
    shape(
      "ASSET_CLASSIFICATION_LT",
      [...equityParts, ...bondParts, ["Liquidity", liquidity], ["Other", 100 - equity - fixedIncome - liquidity]],
      [assetsFrom, geographyFrom, bondsFrom],
    );
  }
  return shapes;
}

/**
 * Equity geography (country / region name -> weight) as fractions of the equity sleeve: regions and currencies, names
 * the mapping doesn't know (justETF "Other") in "Other"; cash rows dropped. Basis "sleeve" (issuer holdings, FT regions):
 * the weights cover the whole sleeve, scaled to it; "fund" (Vanguard's top 15, justETF's top countries): % of the fund,
 * the gap to 100 is unknown.
 */
function equityGeography(geography, basis) {
  const regions = new Map();
  const currencies = new Map();
  let total = 0;
  let unknown = 0;
  let currencyUnknown = 0;
  for (const [name, weight] of geography) {
    if (!(weight > 0) || /^(cash|other)$/i.test(name)) continue;
    total += weight;
    const known = GEOGRAPHY.get(name.toLowerCase());
    if (!known) unknown += weight;
    if (!known?.currency) currencyUnknown += weight;
    add(regions, known?.region ?? "Other", weight);
    add(currencies, known?.currency ?? "Other", weight);
  }
  const covered = basis === "fund" ? Math.max(total, 100) : total;
  if (!covered) return { regions, currencies, unknown: 1, currencyUnknown: 1 };
  if (covered > total) {
    add(regions, "Other", covered - total);
    add(currencies, "Other", covered - total);
    unknown += covered - total;
    currencyUnknown += covered - total;
  }
  for (const map of [regions, currencies]) for (const [key, weight] of map) map.set(key, weight / covered);
  return { regions, currencies, unknown: unknown / covered, currencyUnknown: currencyUnknown / covered };
}

// ============================================================================
// SOURCES (each returns a fragment, or null when it has nothing for the fund)
// ============================================================================

/** iShares holdings CSV: every holding with asset class, location, market currency (and sector, for bonds). */
async function fetchIshares(fund) {
  const text = await fetchText(`https://www.ishares.com/uk/individual/en/products/${fund.lookthrough_source_id}/x/latest-holdings.csv`);
  const [first, ...lines] = text.split(/\r?\n/); // Fund Holdings as of,"29/Oct/2026" / blank line / header / rows
  const rows = utils.parseCsv(lines.join("\n").trim());
  return fromHoldings(
    "ISHARES",
    parseDate(first.match(/"([^"]+)"/)?.[1]),
    rows.map((row) => ({
      weight: toNumber(row["Weight (%)"]),
      assetClass: row["Asset Class"],
      sector: row.Sector,
      country: row.Location,
      currency: row["Market Currency"],
    })),
  );
}

/** Xtrackers constituents export (xlsx, by ISIN): weighting as a fraction; no as-of date in the file (daily). */
async function fetchXtrackers(fund) {
  const response = await politeFetch(`https://etf.dws.com/etfdata/export/GBR/ENG/excel/product/constituent/${fund.isin}/`);
  const sheets = utils.readXlsx(Buffer.from(await response.arrayBuffer()));
  const rows = Object.values(sheets).find((sheet) => sheet.some((row) => row.includes("Weighting")));
  if (!rows) throw new Error("no Weighting column in the export");
  const headerIndex = rows.findIndex((row) => row.includes("Weighting"));
  const column = Object.fromEntries(rows[headerIndex].map((name, i) => [name, i]));
  return fromHoldings(
    "XTRACKERS",
    null,
    rows.slice(headerIndex + 1).map((row) => ({
      weight: Number(row[column.Weighting]) * 100,
      assetClass: row[column["Type of Security"]],
      sector: row[column["Industry Classification"]],
      country: row[column.Country],
      currency: row[column.Currency],
    })),
  );
}

/** Vanguard product page: the market allocation table (top 15 countries, % of the fund); equity funds only. */
async function fetchVanguard(fund) {
  const $ = load(await fetchText(`https://www.vanguard.co.uk/professional/product/etf/equity/${fund.lookthrough_source_id}`));
  const table = $("table")
    .filter((_, element) => /Country/.test($(element).find("th").first().text()))
    .first();
  const geography = new Map();
  table.find("tbody tr").each((_, element) => {
    const cells = $(element).find("td, th").map((_, cell) => $(cell).text().trim()).get();
    const weight = toNumber(cells[2]);
    if (cells[0] && Number.isFinite(weight)) add(geography, cells[0], weight);
  });
  if (!geography.size) throw new Error("market allocation table not found");
  const asOf = parseDate($("body").text().replace(/\s+/g, " ").match(/Market allocation As at (\d{1,2} \w+ \d{4})/)?.[1]);
  return { source: "VANGUARD", asOf, geography, geographyBasis: "fund" };
}

/** Yahoo (Morningstar data): the asset split only (stock / bond / cash / other); no as-of date. */
async function fetchYahoo(fund) {
  const yahoo = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
  let symbol = fund.source === "YAHOO" ? fund.source_id : null;
  if (!symbol && fund.isin) symbol = (await yahoo.search(fund.isin, { quotesCount: 3, newsCount: 0 })).quotes?.find((quote) => quote.symbol)?.symbol;
  if (!symbol) return null;
  const { topHoldings: holdings } = await yahoo.quoteSummary(symbol, { modules: ["topHoldings"] }, { validateResult: false });
  if (!holdings) return null;
  const assets = new Map([
    ["Equity", (holdings.stockPosition ?? 0) + (holdings.preferredPosition ?? 0)],
    ["Fixed Income", (holdings.bondPosition ?? 0) + (holdings.convertiblePosition ?? 0)],
    ["Liquidity", holdings.cashPosition ?? 0],
    ["Other", holdings.otherPosition ?? 0],
  ]);
  return { source: "YAHOO", asOf: null, assets: normalize(assets) };
}

/** FT tearsheet (Morningstar data): asset allocation and the regions of the equity sleeve, with their as-of dates. */
async function fetchFt(fund) {
  for (const currency of new Set([fund.currency, "EUR", "USD", "GBP"])) {
    const response = await politeFetch(`https://markets.ft.com/data/funds/tearsheet/holdings?s=${fund.isin}:${currency}`, { allowMissing: true });
    if (!response) continue;
    const $ = load(await response.text());
    const geography = new Map();
    $("#regions-panel tbody tr").each((_, element) => {
      const cells = $(element).find("td").map((_, cell) => $(cell).text().trim()).get();
      const weight = toNumber(cells[1]);
      if (!FT_PARENT_REGIONS.has(cells[0]?.toLowerCase()) && weight > 0) add(geography, cells[0], weight);
    });
    const FT_ASSETS = { "non-uk stock": "Equity", "uk stock": "Equity", "non-uk bond": "Fixed Income", "uk bond": "Fixed Income", cash: "Liquidity", other: "Other" };
    const assets = new Map();
    $("table")
      .filter((_, element) => $(element).text().includes("Non-UK stock"))
      .first()
      .find("tbody tr")
      .each((_, element) => {
        const cells = $(element).find("td").map((_, cell) => $(cell).text().trim()).get();
        const assetClass = FT_ASSETS[cells[0]?.toLowerCase()];
        if (assetClass) add(assets, assetClass, toNumber(cells[1]) || 0);
      });
    if (!geography.size && !assets.size) continue;
    const dates = [...$.root().text().matchAll(/As of (\w{3} \d{1,2} \d{4})/g)].map((m) => parseDate(m[1])).filter(Boolean).sort();
    return {
      source: "FT",
      asOf: dates[0] ?? null,
      assets: assets.size ? normalize(assets) : null,
      geography: geography.size ? geography : null,
      geographyBasis: "sleeve",
    };
  }
  return null;
}

/** justETF ETF profile: the top countries (% of the fund, the rest as "Other"); no as-of date. */
async function fetchJustEtf(fund) {
  const $ = load(await fetchText(`https://www.justetf.com/en/etf-profile.html?isin=${fund.isin}`));
  const heading = $("h2, h3").filter((_, element) => $(element).text().trim() === "Countries").first();
  const geography = new Map();
  heading
    .nextAll("table")
    .first()
    .find("tr")
    .each((_, element) => {
      const cells = $(element).find("td").map((_, cell) => $(cell).text().trim()).get();
      const weight = toNumber(cells[1]);
      if (cells[0] && Number.isFinite(weight)) add(geography, cells[0], weight);
    });
  return geography.size ? { source: "JUSTETF", asOf: null, geography, geographyBasis: "fund" } : null;
}

/** Fragment from a full holdings list: asset split, equity countries, currencies of the whole fund, government / corporate bonds. */
function fromHoldings(source, asOf, holdings) {
  const assets = new Map();
  const geography = new Map();
  const currencies = new Map();
  let government = 0;
  let corporate = 0;
  for (const holding of holdings) {
    if (!Number.isFinite(holding.weight) || !holding.weight) continue;
    const assetClass = HOLDING_ASSET_CLASSES[String(holding.assetClass ?? "").trim().toLowerCase()] ?? "Other";
    add(assets, assetClass, holding.weight);
    if (holding.currency && holding.currency !== "-") add(currencies, holding.currency, holding.weight);
    if (assetClass === "Equity") add(geography, holding.country || "unknown", holding.weight);
    if (assetClass === "Fixed Income") {
      if (GOVERNMENT_SECTORS.test(holding.sector ?? "")) government += holding.weight;
      else corporate += holding.weight;
    }
  }
  if (!assets.size) throw new Error("no holdings in the file");
  return {
    source,
    asOf,
    assets: normalize(assets),
    geography: geography.size ? geography : null,
    geographyBasis: "sleeve",
    currencies: currencies.size ? normalize(currencies) : null,
    bonds: government + corporate ? { government: government / (government + corporate), corporate: corporate / (government + corporate) } : null,
  };
}

// ============================================================================
// HELPERS
// ============================================================================

const add = (map, key, weight) => map.set(key, (map.get(key) ?? 0) + weight);

/** Weights scaled to sum to 100 (a negative cash leg stays negative). */
function normalize(map) {
  const total = [...map.values()].reduce((sum, weight) => sum + weight, 0);
  if (!(total > 0)) return null;
  return new Map([...map].filter(([, weight]) => weight).map(([key, weight]) => [key, (weight * 100) / total]));
}

const toNumber = (text) => Number.parseFloat(String(text ?? "").replace(/[,%\s]/g, ""));

const MONTHS = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
/** "29/Oct/2026", "30 Sept 2026", "Jul 31 2026" -> ISO date (null when unreadable). */
function parseDate(text) {
  const parts = String(text ?? "").split(/[\s/]+/);
  const month = parts.map((part) => MONTHS[part.slice(0, 3).toLowerCase()]).find(Boolean);
  const day = parts.find((part) => /^\d{1,2}$/.test(part));
  const year = parts.find((part) => /^\d{4}$/.test(part));
  return month && day && year ? `${year}-${month}-${day.padStart(2, "0")}` : null;
}

/**
 * GET with our user agent and retries on 429 / 5xx. A 404 (fund not on that site) returns null with allowMissing;
 * anything else not OK throws.
 */
async function politeFetch(url, { allowMissing = false } = {}) {
  const response = await utils.fetchWithRetry(url, { headers: { "User-Agent": USER_AGENT } });
  if (response.status === 404 && allowMissing) return null;
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).host}`);
  return response;
}

const fetchText = async (url) => (await politeFetch(url)).text();

// ============================================================================
// REPORT EMAIL
// ============================================================================

/** Monthly report: what changed, from which source, and the batch log. */
export async function sendReport(result, targetDate = new Date()) {
  const warnings = batchLog.entries().length;
  const updated = (result?.funds ?? []).filter((row) => row.changed.length).length;
  const status = !result ? "FAILED" : warnings ? `${updated} updated · ${warnings} warning${warnings > 1 ? "s" : ""}` : `${updated} updated`;
  await sendHtmlEmail(`findb-engine: monthly lookthrough [${status}]`, buildReportHtml(result, batchLog.entries(), targetDate));
}

export function buildReportHtml(result, entries, targetDate = new Date()) {
  const dateStr = utils.formatDateToISO(targetDate);
  const funds = result?.funds ?? [];
  const rows = funds.map((row) => ({
    fund: row.fund,
    "€": Math.round(row.value_eur ?? 0).toLocaleString("en-US"),
    status: row.status,
    sources: [...new Set(Object.values(row.sources).flatMap((source) => source.split("+")))].join(" + "),
    "as of": row.as_of ?? "",
    changed: Object.keys(row.sources).length ? `${row.changed.length}/${Object.keys(row.sources).length}` : "",
  }));
  const card = (title, body) => `
          <tr>
            <td class="section" style="padding: 8px 24px 16px 24px;">
              <div style="margin: 0 0 8px 4px; font-size: 14px; font-weight: 500; color: ${M3.primary};">${title}</div>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${M3.surfaceContainerLowest}" style="table-layout: fixed; background-color: ${M3.surfaceContainerLowest}; border-radius: 16px;">
                <tr><td style="padding: 16px;">${body}</td></tr>
              </table>
            </td>
          </tr>`;
  const empty = (text) => `<div style="font-size: 14px; color: ${M3.onSurfaceVariant};">${text}</div>`;
  const updated = funds.filter((row) => row.changed.length).length;
  const pill = !result
    ? [M3.error, M3.onError, "FAILED"]
    : entries.length
      ? [M3.warningContainer, M3.onWarningContainer, `${entries.length} WARNING${entries.length > 1 ? "S" : ""}`]
      : [M3.successContainer, M3.onSuccessContainer, "OK"];
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light">
  <title>Monthly lookthrough - ${dateStr}</title>
  <style>
    body { margin: 0 !important; padding: 0 !important; background-color: ${M3.surface}; }
    @media only screen and (max-width: 600px) { .section { padding-left: 16px !important; padding-right: 16px !important; } }
  </style>
</head>
<body style="margin: 0; padding: 0; background-color: ${M3.surface};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${M3.surface}" style="background-color: ${M3.surface}; width: 100%;">
    <tr>
      <td align="center" style="padding: 24px 8px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${M3.surfaceContainerLow}" style="width: 100%; max-width: 640px; table-layout: fixed; background-color: ${M3.surfaceContainerLow}; border-radius: 28px; font-family: ${M3_FONT}; color: ${M3.onSurface};">
          <tr>
            <td class="section" style="padding: 24px 24px 8px 24px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
                <td valign="middle">
                  <div style="font-size: 22px; line-height: 28px; color: ${M3.onSurface};">Monthly lookthrough</div>
                  <div style="font-size: 14px; line-height: 20px; color: ${M3.onSurfaceVariant}; margin-top: 2px;">${dateStr} &bull; ${funds.length} funds held, ${updated} updated</div>
                </td>
                <td valign="middle" align="right">
                  <span style="display: inline-block; padding: 8px 16px; border-radius: 8px; background-color: ${pill[0]}; color: ${pill[1]}; font-size: 14px; font-weight: 500; white-space: nowrap;">${pill[2]}</span>
                </td>
              </tr></table>
            </td>
          </tr>
          ${card("Funds", rows.length ? renderDynamicData(rows, 50) : empty(result ? "No funds held." : "The lookthrough step crashed: see the batch log."))}
          ${card("Batch log", entries.length ? renderDynamicData(entries.map(({ level, entity, message }) => ({ level, fund: entity, message })), 50) : empty("Nothing to report."))}
          <tr>
            <td class="section" style="padding: 16px 24px 24px 24px; border-top: 1px solid ${M3.outlineVariant}; font-size: 12px; color: ${M3.outline}; text-align: center;">
              findb-engine &bull; monthly batch &bull; new shapes start today, the daily breakdowns pick them up tonight
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
}
