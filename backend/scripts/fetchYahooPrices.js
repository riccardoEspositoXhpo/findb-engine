// scripts/fetchYahooPrices.js
import fs from "node:fs";
import path from "node:path";

// Mapping FinDB SECURITY_ID to Yahoo Finance Milan/Xetra tickers (all in EUR)
const TARGET_SECURITIES = [
  { securityId: "INRG", yahooTicker: "INRG.MI" },
  { securityId: "ROBO", yahooTicker: "ROBO.MI" },
  { securityId: "JEDI", yahooTicker: "JEDI.MI" }, // VanEck Space Innovators UCITS ETF on Borsa Italiana
  { securityId: "URNU", yahooTicker: "URNU.MI" },
  { securityId: "HEAL", yahooTicker: "HEAL.MI" },
  { securityId: "REMX", yahooTicker: "REMX.MI" }, // VanEck Rare Earth UCITS ETF on Borsa Italiana
];

// 2016-01-01T00:00:00Z UTC timestamp
const PERIOD1 = Math.floor(new Date("2016-01-01T00:00:00Z").getTime() / 1000);
const PERIOD2 = Math.floor(Date.now() / 1000);

/**
 * Converts a Unix epoch timestamp (seconds) into FinDB standard DD/MM/YYYY.
 */
function formatToFinDbDate(epochSeconds) {
  const d = new Date(epochSeconds * 1000);
  const day = String(d.getUTCDate()).padStart(2, "0");
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const year = d.getUTCFullYear();
  return `${day}/${month}/${year}`;
}

async function fetchYahooSeries(yahooTicker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    yahooTicker,
  )}?period1=${PERIOD1}&period2=${PERIOD2}&interval=1d&events=history`;

  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }

  const json = await res.json();
  const result = json?.chart?.result?.[0];

  if (!result || !result.timestamp) {
    return [];
  }

  const timestamps = result.timestamp;
  // Use adjusted close to account for any fund splits/distributions
  const closes =
    result.indicators?.adjclose?.[0]?.adjclose ||
    result.indicators?.quote?.[0]?.close ||
    [];

  const rows = [];
  for (let i = 0; i < timestamps.length; i++) {
    const rawPrice = closes[i];
    // Skip weekend / trading holiday null entries returned by Yahoo
    if (
      rawPrice === null ||
      rawPrice === undefined ||
      isNaN(rawPrice) ||
      rawPrice <= 0
    ) {
      continue;
    }

    rows.push({
      dateStr: formatToFinDbDate(timestamps[i]),
      price: Number(rawPrice.toFixed(4)),
    });
  }

  return rows;
}

async function run() {
  console.log(
    `[BACKFILL] Starting Yahoo Finance download for ${TARGET_SECURITIES.length} securities...`,
  );
  const allRows = [];

  for (const target of TARGET_SECURITIES) {
    process.stdout.write(
      `Fetching ${target.securityId} (${target.yahooTicker})... `,
    );
    try {
      const data = await fetchYahooSeries(target.yahooTicker);
      console.log(`OK! Retrieved ${data.length} prices.`);

      for (const item of data) {
        allRows.push({
          DATE: item.dateStr,
          PRICE: item.price,
          SECURITY_ID: target.securityId,
        });
      }
    } catch (err) {
      console.log(`FAILED! Error: ${err.message}`);
    }

    // Gentle 300ms pause to stay clear of rate limits
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  // Format to standard CSV format
  const header = "DATE,PRICE,SECURITY_ID";
  const lines = allRows.map((r) => `${r.DATE},${r.PRICE},${r.SECURITY_ID}`);
  const csvContent = [header, ...lines].join("\n");

  const outputPath = path.resolve("./backfilled_prices.csv");
  fs.writeFileSync(outputPath, csvContent, "utf8");

  console.log(
    `\n[SUCCESS] Wrote ${allRows.length} total rows to ${outputPath}`,
  );
}

run();
