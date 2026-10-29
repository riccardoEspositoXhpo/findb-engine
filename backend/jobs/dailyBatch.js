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
import { events } from "../src/events.js";
import { scrapeEmails } from "../src/scrapeEmails.js";
import { valuation } from "../src/valuation.js";
import { aggregates } from "../src/aggregates.js";
import { taxes } from "../src/taxes.js";
import { performance } from "../src/performance.js";
import { sendQcEmail } from "../src/qcNotification.js";

async function executePipeline() {
  // 1. Master Market Data Pipeline (fx rates, crypto, prices)
  await marketData.run(config.date);

  // 2. Emails -> events (bank / card balances). A Gmail failure is logged, not fatal.
  await scrapeEmails.run(config.date);

  // 3. Events: generate automatic events (scheduled_events, recurring_flows), then process every pending event
  // into the ledger. Must run before valuation, which reads the ledger.
  await events.run(config.date);

  // 4. Portfolio valuation: positions + nav for every portfolio that runs today (its frequency, or triggered by an
  // instalment / event), dispatched on valuation_method. ROLL portfolios restart from the earliest past date that
  // changed since their last run (ledger, prices, fx: getRollStartDate). A failing portfolio is logged and skipped.
  await valuation.run(config.date);

  // 5. Taxes: position lots from the whole ledger (average cost, crypto LIFO), yearly tax items, and the UNREALIZED_TAX portfolio (estimated
  // tax on today's unrealized gains), so it must run after valuation and before the aggregates
  await taxes.run(config.date);

  // 6. Aggregate NAVs (aggregate_tree over portfolio navs; restarts from the earliest past nav / fx written since
  // its last run)
  await aggregates.run(config.date);

  // 7. Performance: security, portfolio and aggregate returns, then the nav returns (needs the portfolio and aggregate
  // navs). Every level restarts from the earliest data written since its last run.
  await performance.run(config.date);

  // n. Overnight Quality Control Engine
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

  // 7. Dispatch QC status digest (suppressed during CI dry-run)
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
