/**
 * Shared shell of the Cloud Run jobs (dailyBatch, monthlyBatch): the step wrapper and the job lifecycle (dry run in a
 * rolled-back transaction, crash email when the job dies outside its steps, pool teardown, exit code).
 */

import { pool, withTransaction, withSavepoint } from "#core/db.js";
import { config } from "#config";
import { sendCrashEmail } from "#notifications/qcEmail.js";
import { batchLog } from "#core/batchLog.js";

export const batchRunner = { runStep, runJob };

// A failing step is retried once after this pause (GAS retried every step twice)
const RETRY_DELAY_MS = 10_000;

/**
 * Runs one batch step so that nothing stops the batch (user, 2026-10-31): a throw is retried once, then recorded in
 * the batch log (QC email: checkBatchErrors) and the batch moves on with the data already in the DB. In a dry run the
 * step runs in a savepoint: a failed query would otherwise abort the whole rollback transaction for the steps after.
 *
 * @returns {Promise<*>} the step's result, or undefined when it failed twice
 */
export async function runStep(name, fn) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const result = await (config.dryRun ? withSavepoint(fn) : fn());
      if (attempt === 2) batchLog.warn(name, null, "failed on the first attempt, the retry succeeded.");
      return result;
    } catch (error) {
      console.error(`[FinDB] ${name} failed (attempt ${attempt}):`, error);
      if (attempt === 2) batchLog.error(name, null, `step crashed twice, skipped: ${error.message}`);
      else await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
}

/**
 * Job lifecycle: the pipeline in a rolled-back transaction when DRY_RUN (CI), else live (each step commits as it
 * writes); a throw outside the steps (database unreachable, ...) sends the crash email; the pool is drained and the
 * process exits 1 on failure (Cloud Run / GitHub Actions alerting).
 *
 * @param {string} label - job name for the logs and the crash email ("Daily Batch", "Monthly Batch")
 * @param {Function} pipeline - async () => void
 */
export async function runJob(label, pipeline) {
  const startTime = Date.now();
  let exitCode = 0;
  console.log(`=== [FinDB ${label}] Starting execution (dryRun=${Boolean(config.dryRun)}) ===`);
  try {
    if (config.dryRun) await withTransaction(pipeline, { rollback: true });
    else await pipeline();
    console.log(`=== [FinDB ${label}] Completed successfully in ${((Date.now() - startTime) / 1000).toFixed(2)}s ===`);
  } catch (error) {
    console.error(`=== [FinDB ${label}] Fatal error during execution ===`, error);
    exitCode = 1;
    if (!config.dryRun)
      await sendCrashEmail(error, batchLog.entries(), config.date, label).catch((emailError) =>
        console.error(`[FinDB ${label}] Crash email failed too:`, emailError),
      );
  } finally {
    try {
      console.log(`[FinDB ${label}] Draining database pool connections...`);
      await pool.end();
    } catch (poolError) {
      console.error(`[FinDB ${label}] Error while ending connection pool:`, poolError);
      exitCode = 1;
    }
    process.exit(exitCode);
  }
}
