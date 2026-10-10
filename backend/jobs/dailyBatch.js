import { runTestQuery } from "./testQuery.js";

async function runDailyBatch() {
  const startTime = Date.now();
  console.log("=== [FinDB Daily Batch] Starting execution ===");

  try {
    // Step temporaneo di test: esegue la query su Supabase
    await runTestQuery();

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`=== [FinDB Daily Batch] Completed successfully in ${duration}s ===`);
    process.exit(0);
  } catch (error) {
    console.error("=== [FinDB Daily Batch] Fatal error during execution ===", error);
    process.exit(1);
  }
}

runDailyBatch();