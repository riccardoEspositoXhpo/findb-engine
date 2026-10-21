/**
 * findb-engine daily batch process.
 *
 * - Master orchestrator for production cycle.
 * - Handles graceful database pool termination and exit codes.
 */

import { pool } from "../src/db.js";
import { config } from "../config.js";
import { overnightQC } from "../src/overnightQC.js";
import { marketData } from "../src/marketData.js";
import { sendQcEmail } from "../src/qcNotification.js";

async function runDailyBatch() {
  const startTime = Date.now();
  let exitCode = 0;
  console.log("=== [FinDB Daily Batch] Starting execution ===");

  try {
    // 1. Master Market Data Pipeline (fx rates, prices)
    await marketData.run(config.date);

    // n. Overnight QC Process
    const qcResults = await overnightQC.runAll(config.date);

    // Final QC email
    await sendQcEmail(qcResults, config.date);

    // TBD - decide if any failed check is critical / warning / etc.

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(
      `=== [FinDB Daily Batch] Completed successfully in ${duration}s ===`,
    );
  } catch (error) {
    console.error(
      "=== [FinDB Daily Batch] Fatal error during execution ===",
      error,
    );
    exitCode = 1; // Mark process as failed for Cloud Run / scheduler alerting
  } finally {
    // 2. Teardown: drain pool connections cleanly before process termination
    try {
      console.log("[FinDB Daily Batch] Draining database pool connections...");
      await pool.end();
    } catch (poolError) {
      console.error(
        "[FinDB Daily Batch] Error while ending connection pool:",
        poolError,
      );
      exitCode = 1;
    }

    // 3. Guaranteed termination signal for container runtime
    process.exit(exitCode);
  }
}

runDailyBatch();
