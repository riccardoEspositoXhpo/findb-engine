// ============================================================================
// GENERAL UTILITIES (Migrated from // utilities.gs)
// ============================================================================





import db, { replaceDataInSheet } from "./db.js";
import { doesItRunToday } from "./utilities.js";
import { fetchSecurityPrice } from "./priceProviders.js";

/**
 * Downloads prices for all eligible securities in security_master and commits via replaceDataInSheet.
 * Migrated from calculatePrices in // securityData.gs
 *
 * @param {Date|string} [targetDate=new Date()] - Evaluation date
 * @param {Object} [options={}] - Optional filters, e.g. { runOnlyThisId: 'IUSQ' }
 */
export async function calculatePrices(targetDate = new Date(), options = {}) {
  const evalDate =
    targetDate instanceof Date ? targetDate : new Date(targetDate);
  const evalDateStr = utils.toISODate(evalDate);

  console.log(
    `[PRICES BATCH] Starting security price calculation for date: ${evalDateStr}...`,
  );

  // 1. Load active priced securities from security_master
  const queryParams = [];
  let whereClause = `
    WHERE source IS NOT NULL
      AND UPPER(TRIM(source)) NOT IN ('NA', 'NONE', 'FXRATEDAILY', 'CRYPTORATEDAILY', '')
      AND UPPER(TRIM(asset_type)) NOT IN ('CASH', 'CRYPTO', 'DEBT')
  `;

  if (options.runOnlyThisId) {
    queryParams.push(options.runOnlyThisId);
    whereClause += ` AND security_id = $1`;
  }

  const { rows: securities } = await db.query(
    `SELECT security_id, source, location, valuation_frequency, valuation_day, asset_type
     FROM security_master
     ${whereClause}
     ORDER BY security_id ASC`,
    queryParams,
  );

  // 2. Filter by valuation schedule
  const eligibleSecurities = securities.filter((sec) => {
    if (options.runOnlyThisId) return true;
    return doesItRunToday(sec, evalDate);
  });

  console.log(
    `[PRICES BATCH] Found ${eligibleSecurities.length} securities scheduled to run today.`,
  );
  if (eligibleSecurities.length === 0) return [];

  // 3. Fetch prices in bounded parallel chunks (10 at a time)
  const CONCURRENCY_LIMIT = 10;
  const finalPrices = [];

  for (let i = 0; i < eligibleSecurities.length; i += CONCURRENCY_LIMIT) {
    const chunk = eligibleSecurities.slice(i, i + CONCURRENCY_LIMIT);
    const settled = await Promise.allSettled(
      chunk.map(async (sec) => ({
        sec,
        data: await fetchSecurityPrice(sec, evalDate),
      })),
    );

    for (const item of settled) {
      if (item.status === "rejected") {
        console.error(
          `[PRICES BATCH] Provider error:`,
          item.reason?.message || item.reason,
        );
        continue;
      }

      const { sec, data } = item.value;
      const parsedPrice = parseFloat(data?.price);

      // Filter out 0 or NaN prices (matching finalPrices filter in // securityData.gs)
      if (!data || isNaN(parsedPrice) || parsedPrice <= 0) {
        console.warn(
          `[PRICES BATCH] Skipping invalid/zero price for ${sec.security_id}`,
        );
        continue;
      }

      const priceDateStr = data.date || evalDateStr;

      finalPrices.push({
        date: priceDateStr,
        security_id: sec.security_id,
        price: parsedPrice,
      });

      // Log retroactive historical price updates
      if (priceDateStr !== evalDateStr) {
        console.log(
          `[PRICES BATCH] Historical price detected for ${sec.security_id} on ${priceDateStr} (${parsedPrice}).`,
        );
      }
    }
  }

  // 4. Commit to Postgres using our existing replaceDataInSheet abstraction
  if (finalPrices.length > 0) {
    await replaceDataInSheet(finalPrices, "prices");
    console.log(
      `[PRICES BATCH] Successfully upserted ${finalPrices.length} prices via replaceDataInSheet.`,
    );
  } else {
    console.warn(`[PRICES BATCH] No valid prices to commit.`);
  }

  return finalPrices;
}
