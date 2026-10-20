// test.js
import * as marketData from "./backend/src/marketData.js";
import * as price from "./backend/src/priceProviders.js";
import { importDatabase } from "./backend/src/db.js";
import { overnightQC } from "./backend/src/overnightQC.js";
import { sendQcEmail } from "./backend/src/qcNotification.js";
import { config } from "./backend/config.js";
// let sec = (await importDatabase("security_master")).filter(
//   (s) => s.source === "EODHD" && s.security_id === "BLK",
// );

const mockQcResults = {
  results: [
    {
      check: "hasCryptoRunToday",
      passed: true,
      summary: "All mandatory crypto rates present in fx_rates",
    },
    {
      check: "checkCryptoRatesFreshness",
      passed: false,
      summary: "Found 3 stale or missing crypto spot rates for today",
      message:
        "The following trading pairs failed quote extraction on CoinMarketCap:",
      // Array di oggetti dinamico!
      data: [
        {
          pair: "SOLUSDT",
          source: "COINMARKETCAP",
          last_seen: "2026-10-19",
          expected: "2026-10-20",
          status: "MISSING",
        },
        {
          pair: "ETHBTC",
          source: "COINMARKETCAP",
          last_seen: "2026-10-19",
          expected: "2026-10-20",
          status: "STALE_QUOTE",
        },
        {
          pair: "CROUSDC",
          source: "COINMARKETCAP",
          last_seen: "2026-10-18",
          expected: "2026-10-20",
          status: "EMPTY_FEED",
        },
      ],
      date: "2026-10-20",
    },
    {
      check: "checkWeightsSum",
      passed: true,
      summary: "Portfolio weights reconciled to 100%",
    },
  ],
};

// Test email dispatch:
await sendQcEmail(mockQcResults, "2026-10-20");
