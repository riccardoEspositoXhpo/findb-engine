/**
 * findb-engine daily batch process.
 *
 * - Master orchestrator for production cycle.
 * - Supports end-to-end dry run verification via transaction rollback.
 * - Handles graceful database pool termination and exit codes.
 */

import { pool, withTransaction } from "../src/db.js";
import { config } from "../config.js";
import { overnightQC } from "../src/overnightQC.js";
import { marketData } from "../src/marketData.js";
import { sendQcEmail } from "../src/qcNotification.js";

async function executePipeline() {
  // 1. Master Market Data Pipeline (fx rates, crypto, prices)
  await marketData.run(config.date);

  // 2. Overnight Quality Control Engine
  // In dry-run mode, QC queries the same uncommitted transaction client and verifies actual data
  const qcResults = await overnightQC.runAll(config.date);

  const checks = qcResults?.results || [];
  const passed = checks.filter((c) => c.passed).length;
  const total = checks.length;
  const criticals = checks.filter(
    (c) => !c.passed && c.severity === "CRITICAL",
  ).length;

  console.log(
    `[QC ENGINE] ${passed}/${total} checks passed (${criticals} critical failures).`,
  );

  // 3. Dispatch QC status digest (suppressed during CI dry-run)
  if (config.dryRun) {
    console.log(
      "[FinDB Daily Batch] DRY-RUN active: Skipping email transmission.",
    );
  } else {
    await sendQcEmail(qcResults, config.date);
  }
}

async function runDailyBatch() {
  const startTime = Date.now();
  let exitCode = 0;
  console.log(
    `=== [FinDB Daily Batch] Starting execution (dryRun=${Boolean(config.dryRun)}) ===`,
  );

  try {
    if (config.dryRun) {
      // Execute the entire pipeline end-to-end within an isolated transaction that rolls back cleanly
      await withTransaction(executePipeline, { rollback: true });
    } else {
      // Production live execution: commits as each process writes
      await executePipeline();
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(
      `=== [FinDB Daily Batch] Completed successfully in ${duration}s ===`,
    );
  } catch (error) {
    console.error(
      "=== [FinDB Daily Batch] Fatal error during execution ===",
      error,
    );
    exitCode = 1; // Mark process as failed for Cloud Run / GitHub Actions alerting
  } finally {
    // Teardown: drain pool connections cleanly before process termination
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

    // Guaranteed termination signal for container runtime
    process.exit(exitCode);
  }
}

runDailyBatch();
