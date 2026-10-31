/**
 * Batch log: every error / warning of the nightly batch in one place, so nothing fails silently (user, 2026-10-31).
 * The step wrapper (runStep, batchRunner.js) records a whole step crashing; the steps record their own per-entity failures
 * (a portfolio, an event, a price feed) and skips. The QC checks checkBatchErrors (CRITICAL) / checkBatchWarnings
 * (WARNING) put them in the QC email; the crash email (batchRunner.js / dailyBatch.js) lists them when QC can't run.
 * In memory: one batch = one process.
 */
const entries = [];

export const batchLog = {
  error: (step, entity, message) => record("ERROR", step, entity, message),
  warn: (step, entity, message) => record("WARNING", step, entity, message),
  entries: (level) => entries.filter((entry) => !level || entry.level === level),
  clear: () => entries.splice(0),
};

/** Stores the entry and prints it like before (console.error / console.warn, in the Cloud Run logs). */
function record(level, step, entity, message) {
  const text = message instanceof Error ? message.message : String(message);
  entries.push({ level, step, entity: entity ?? null, message: text, at: new Date().toISOString() });
  (level === "ERROR" ? console.error : console.warn)(`[${step.toUpperCase()}]${entity ? ` ${entity}:` : ""} ${text}`);
}
