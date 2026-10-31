/**
 * findb-engine daily batch process.
 *
 * - Master orchestrator for production cycle.
 * - Nothing stops the batch: every step runs through runStep (batchRunner.js: retry once, then batch log); the QC email reports the
 *   batch log, a crash email goes out when QC can't (or when the batch dies outside the steps).
 * - Dry run (transaction rollback), crash email, pool teardown and exit codes: runJob (batchRunner.js).
 */

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
import { runStep, runJob } from "../src/batchRunner.js";
import { batchLog } from "../src/batchLog.js";
import { dailyStats } from "../src/dailyStats.js";

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

runJob("Daily Batch", executePipeline);
