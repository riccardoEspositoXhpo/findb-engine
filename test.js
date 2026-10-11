// test.js
import * as marketData from "./backend/src/marketData.js";

console.log("[TEST] Starting marketData.run in Dry-Run mode...");

try {
  const records = await marketData.run(new Date("2026-10-01"));
  console.log("[TEST] Output records:", records);
  console.log(`[TEST] Successfully generated ${records.length} cross-rates!`);
} catch (error) {
  console.error("[TEST] Execution failed:", error);
}
