// test.js
import * as marketData from "./backend/src/marketData.js";
import * as price from "./backend/src/priceProviders.js";
import { importDatabase } from "./backend/src/db.js";

let sec = (await importDatabase("security_master")).filter(
  (s) => s.source === "EODHD",
);

console.log(sec);
// .filter((s) => s.source === "EODHD");

sec.forEach((s) => {
  let priceData = price.fetchSecurityPrice(s);
  console.log(s.security_id, priceData);
});
