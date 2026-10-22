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

marketData.calculateCryptoDailyFx(new Date("2026-10-12"));
