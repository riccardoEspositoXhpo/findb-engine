// test.js
import * as marketData from "./backend/src/marketData.js";
import * as price from "./backend/src/priceProviders.js";
import { importDatabase } from "./backend/src/db.js";

// let sec = (await importDatabase("security_master")).filter(
//   (s) => s.source === "EODHD" && s.security_id === "BLK",
// );

let sec = [
  {
    security_id: "BTP_15GEN27",
    source: "fondi",
    source_id: "1FADB397095",
    currency: "EUR",
    asset_type: "BOND",
  },
];

console.log(sec);
// .filter((s) => s.source === "EODHD");

sec.forEach(async (s) => {
  let priceData = await price.fetchSecurityPrice(s);
  console.log(s.security_id, priceData);
});
