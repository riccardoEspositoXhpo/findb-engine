import { describe, test, expect, afterAll } from "vitest";
import db from "../src/db.js";
import { overnightQC } from "../src/overnightQC.js";

describe("FinDB Overnight Quality Control (QC) Suite", () => {
  // Always close the Postgres connection pool cleanly after all tests finish
  afterAll(async () => {
    if (db && typeof db.end === "function") {
      await db.end();
    }
  });

  // ==========================================================================
  // 1. MARKET DATA & FX CHECKS
  // ==========================================================================
  describe("1. Market Data & FX Rates", () => {
    test("hasCryptoRunToday: Crypto FX rates are present for today (24/7)", async () => {
      const result = await overnightQC.hasCryptoRunToday(new Date());

      expect(
        result.passed,
        `[QC FAIL] Expected Crypto FX rates in 'fx_rates' for ${result.date}, but found ${result.count} rows.`,
      ).toBe(true);
    });

    // Upcoming FX & Market Data checks
    test.todo(
      "hasFiatFxRunToday: ECB Fiat FX rates are present for today (Weekdays)",
    );
    test.todo(
      "isFxTimeSeriesContinuous: No missing dates in fx_rates time series",
    );
    test.todo(
      "isLatestFxOutOfBounds: Daily FX rate move does not exceed spike threshold",
    );
  });

  // ==========================================================================
  // 2. SECURITY MASTER & PRICES CHECKS
  // ==========================================================================
  describe("2. Security Master & Prices", () => {
    test.todo(
      "hasPricesRunToday: Eligible daily securities have prices for today",
    );
    test.todo(
      "isLatestPriceOutOfBounds: No security price spiked/crashed > threshold vs previous close",
    );
    test.todo("checkSecurityBreakdownsSum: Security breakdowns sum to 100%");
  });

  // ==========================================================================
  // 3. PORTFOLIOS, POSITIONS & NAV CHECKS
  // ==========================================================================
  describe("3. Portfolios, Positions & NAV", () => {
    test.todo(
      "hasPositionsRunToday: Active daily portfolios have positions for today",
    );
    test.todo("hasNavRunToday: Active daily portfolios have NAV for today");
    test.todo(
      "doesNavMatchSumOfPositions: Portfolio NAV equals sum(MARKET_VALUE_BASE)",
    );
    test.todo("checkPositionWeightsSum: Portfolio position weights sum to 1.0");
    test.todo("checkPortfolioBreakdownsSum: Portfolio breakdowns sum to 100%");
  });

  // ==========================================================================
  // 4. AGGREGATES, LOTS & RISK CHECKS
  // ==========================================================================
  describe("4. Aggregates, Lots & Risk", () => {
    test.todo("hasAggregateNavRunToday: Aggregate NAVs are present for today");
    test.todo(
      "isLatestAggregateNavOutOfBounds: Aggregate NAV daily move is within bounds",
    );
    test.todo("hasOpenLotsRunToday: Open lots table is updated");
  });
});
