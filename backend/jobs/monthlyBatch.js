/**
 * findb-engine monthly batch process (Cloud Run job findb-monthjob, same image as the daily one).
 *
 * - Lookthrough: the funds' shapes from the issuer files / Yahoo / FT / fondsweb (src/lookthrough.js), new intervals
 *   starting today; the daily batch's breakdowns pick them up the same night. No dependency between the two jobs: if
 *   this one fails, the daily keeps using last month's shapes.
 * - Report email with the sources used and the batch log; crash email when it can't go out.
 * - Dry run (transaction rollback), pool teardown and exit codes: runJob (batchRunner.js).
 */

import { config } from "#config";
import { lookthrough } from "#analytics/lookthrough/index.js";
import { sendCrashEmail } from "#notifications/qcEmail.js";
import { runStep, runJob } from "#core/batchRunner.js";
import { batchLog } from "#core/batchLog.js";

async function executePipeline() {
  const date = config.date;

  // 1. Lookthrough shapes of the funds held
  const result = await runStep("lookthrough", () => lookthrough.run(date));

  // Email (suppressed during CI dry-run): the report, else the crash email with the batch log
  if (config.dryRun) {
    console.log(`[FinDB Monthly Batch] DRY-RUN active: Skipping email transmission. ${JSON.stringify(result?.funds?.map((row) => [row.fund, row.status, row.changed.length]))}`);
    return;
  }
  await runStep("reportEmail", () => lookthrough.sendReport(result, date));
  if (batchLog.entries("ERROR").some((entry) => entry.step === "reportEmail"))
    await sendCrashEmail(new Error("The monthly report could not be sent: batch log below."), batchLog.entries(), date, "Monthly Batch").catch(
      (error) => console.error("[FinDB Monthly Batch] Crash email failed too:", error),
    );
}

runJob("Monthly Batch", executePipeline);
