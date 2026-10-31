/**
 * findb-engine daily batch process.
 *
 * - Master orchestrator for production cycle.
 * - Nothing stops the batch: every step runs through runStep (retry once, then batch log); the QC email reports the
 *   batch log, a crash email goes out when QC can't (or when the batch dies outside the steps).
 * - Supports end-to-end dry run verification via transaction rollback.
 * - Handles graceful database pool termination and exit codes.
 */

import { pool, withTransaction, withSavepoint } from "../src/db.js";
import { config } from "../config.js";
import { overnightQC } from "../src/overnightQC.js";
import { marketData } from "../src/marketData.js";
import { events } from "../src/events.js";
import { scrapeEmails } from "../src/scrapeEmails.js";
import { valuation } from "../src/valuation.js";
import { aggregates } from "../src/aggregates.js";
import { taxes } from "../src/taxes.js";
import { performance } from "../src/performance.js";
import { risk } from "../src/risk.js";
import { breakdowns } from "../src/breakdowns.js";
import { sendQcEmail, sendCrashEmail } from "../src/qcNotification.js";
import { batchLog } from "../src/batchLog.js";
import { dailyStats } from "../src/dailyStats.js";

// A failing step is retried once after this pause (GAS retried every step twice)
const RETRY_DELAY_MS = 10_000;

/**
 * Runs one batch step so that nothing stops the batch (user, 2026-10-31): a throw is retried once, then recorded in
 * the batch log (QC email: checkBatchErrors) and the batch moves on with the data already in the DB. In a dry run the
 * step runs in a savepoint: a failed query would otherwise abort the whole rollback transaction for the steps after.
 *
 * @returns {Promise<*>} the step's result, or undefined when it failed twice
 */
async function runStep(name, fn) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const result = await (config.dryRun ? withSavepoint(fn) : fn());
      if (attempt === 2) batchLog.warn(name, null, "failed on the first attempt, the retry succeeded.");
      return result;
    } catch (error) {
      console.error(`[FinDB Daily Batch] ${name} failed (attempt ${attempt}):`, error);
      if (attempt === 2) batchLog.error(name, null, `step crashed twice, skipped: ${error.message}`);
      else await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
}

async function executePipeline() {
  const date = config.date;

  // 1. Master Market Data Pipeline (fx rates, crypto, prices)
  await runStep("marketData", () => marketData.run(date));

  // 2. Emails -> events (bank / card balances)
  await runStep("scrapeEmails", () => scrapeEmails.run(date));

  // 3. Events: generate automatic events (scheduled_events, recurring_flows), then process every pending event
  // into the ledger. Must run before valuation, which reads the ledger.
  await runStep("events", () => events.run(date));

  // 4. Portfolio valuation: positions + nav for every portfolio that runs today (its frequency, or triggered by an
  // instalment / event), dispatched on valuation_method. ROLL portfolios restart from the earliest past date that
  // changed since their last run (ledger, prices, fx: getRollStartDate). A failing portfolio is logged and skipped.
  await runStep("valuation", () => valuation.run(date));

  // 5. Taxes: position lots from the whole ledger (average cost, crypto LIFO), yearly tax items, and the UNREALIZED_TAX portfolio (estimated
  // tax on today's unrealized gains), so it must run after valuation and before the aggregates
  await runStep("taxes", () => taxes.run(date));

  // 6. Aggregate NAVs (aggregate_tree over portfolio navs; restarts from the earliest past nav / fx written since
  // its last run)
  await runStep("aggregates", () => aggregates.run(date));

  // 7. Performance: security, portfolio and aggregate returns, then the nav returns (needs the portfolio and aggregate
  // navs). Every level restarts from the earliest data written since its last run.
  await runStep("performance", () => performance.run(date));

  // 8. Risk: ex-ante snapshots (volatility, drawdowns, VaR / ES, stress, tail capture) of the securities held, the
  // performance portfolios and the aggregates, on today's composition and positions
  await runStep("risk", () => risk.run(date));

  // 9. Breakdowns: security, portfolio and aggregate breakdowns as intervals (a new one only when the whole-percent
  // weights change); portfolios / aggregates restart from the earliest nav written since their last run
  await runStep("breakdowns", () => breakdowns.run(date));

  // n. Overnight Quality Control Engine (the batch log goes in as checkBatchErrors / checkBatchWarnings)
  // In dry-run mode, QC queries the same uncommitted transaction client and verifies actual data
  const qcResults = await runStep("overnightQC", () => overnightQC.runAll(date));

  if (qcResults) {
    const checks = qcResults.results || [];
    const passed = checks.filter((c) => c.passed).length;
    const criticals = checks.filter((c) => !c.passed && c.severity === "CRITICAL").length;
    console.log(`[QC ENGINE] ${passed}/${checks.length} checks passed (${criticals} critical failures).`);
  }

  // Emails (suppressed during CI dry-run): the QC digest, else the crash email with the batch log; then the net worth
  if (config.dryRun) {
    console.log("[FinDB Daily Batch] DRY-RUN active: Skipping email transmission.");
    return;
  }
  if (qcResults) await runStep("qcEmail", () => sendQcEmail(qcResults, date));
  if (!qcResults || batchLog.entries("ERROR").some((entry) => entry.step === "qcEmail"))
    await sendCrashEmail(new Error("QC could not run or its email could not be sent: batch log below."), batchLog.entries(), date).catch(
      (error) => console.error("[FinDB Daily Batch] Crash email failed too:", error),
    );
  // "Daily FinDB": liquid net worth and its change from yesterday
  await runStep("netWorthEmail", () => dailyStats.run(date));
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
    // Something outside the steps died (database unreachable, ...): the QC email never went out, send the crash email
    if (!config.dryRun)
      await sendCrashEmail(error, batchLog.entries(), config.date).catch((emailError) =>
        console.error("[FinDB Daily Batch] Crash email failed too:", emailError),
      );
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
