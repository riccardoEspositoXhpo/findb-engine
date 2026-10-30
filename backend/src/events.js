import { utils } from "./utils.js";
import { query, replaceDataInDb, withSavepoint } from "./db.js";
import { loadFxRates, currencyConverter } from "./marketData.js";
import { ledger } from "./ledger.js";

export const events = {
  run,
  generateScheduledEvents,
  generateRecurringFlowEvents,
  processEvents,
  insertNewEvents,
};

/**
 * Daily events step, runs before valuation (everything that moves the ledger converges into events).
 * 1. generate events from the automatic sources (scheduled_events, recurring_flows)
 * 2. process every unprocessed event (any date up to targetDate) into transactions / capital_flows
 * Migrated from runPortfolioEvents in // portfolioData.gs
 *
 * @param {Date|string} [targetDate=new Date()] - Evaluation date
 * @returns {Promise<{scheduled: number, recurring: number, processed: number, pending: number, failed: number}>}
 */
export async function run(targetDate = new Date()) {
  const dateStr = utils.formatDateToISO(targetDate);
  console.log(`[EVENTS] Starting events for ${dateStr}...`);

  const scheduled = await generateScheduledEvents(dateStr);
  const recurring = await generateRecurringFlowEvents(dateStr);
  const { processed, pending, failed } = await processEvents(dateStr);

  console.log(
    `[EVENTS] Done for ${dateStr}: created ${scheduled} scheduled + ${recurring} recurring payment events; ` +
      `processed ${processed}, pending ${pending}, failed ${failed}.`,
  );
  return { scheduled, recurring, processed, pending, failed };
}

// One handler per event_type: (event) -> true when the event was turned into ledger rows.
// Not migrated yet -> false, the event stays unprocessed and is retried every night.
// Migrated from eventHandler in // eventsProcessing.gs (PORTFOLIO_INCOME dropped: unused; PENSION_CONTRIBUTION dropped:
// ALLIANZ is imported from the Allianz export, valuation.runAllianz)
const EVENT_HANDLERS = {
  INFLOW: processFlow,
  OUTFLOW: processFlow,
  REWARDS: processFlow,
  INTEREST: processFlow,
  CASH_TRANSFER: processCashTransfer,
  COUPON_TRANSFER: processCouponTransfer,
  PURCHASE: processPurchase,
  SALE: processSale,
  BALANCE: forceCashBalance,
  MATURED_SECURITY: replaceMaturedSecurity,
  RECURRING_PAYMENT: processRecurringPayment,
  TAX_PAID: recordTaxPayment,
};

/**
 * TAX_PAID -> tax_payments: the declared tax of a year (capital gains + IVAFE through the tax return) is paid, on the
 * event's date, from portfolio_id. tax_year from event_metadata.tax_year, else the year before the payment. quantity =
 * the amount actually paid if known (0 = unknown): only kept for reference, REALIZED_TAX drops the whole estimate.
 * Not a ledger row: the paying account's balance shows the money leaving (user, 2026-10-30).
 */
async function recordTaxPayment(event) {
  const paidOn = effectiveDate(event);
  const taxYear = Number(event.event_metadata?.tax_year ?? Number(paidOn.slice(0, 4)) - 1);
  await replaceDataInDb(
    [{ tax_year: taxYear, paid_on: paidOn, amount_eur: Number(event.quantity) || null, portfolio_id: event.portfolio_id, event_id: event.event_id, notes: event.event_notes ?? null }],
    "tax_payments",
  );
  console.log(`[EVENTS] Tax year ${taxYear} paid on ${paidOn} (event ${event.event_id}).`);
  return true;
}

/** The date the event takes effect: process_date if set, else date (GAS: PROCESS_DATE !== "" ? PROCESS_DATE : DATE). */
function effectiveDate(event) {
  return utils.formatDateToISO(event.process_date ?? event.date);
}

/** Quantity of a security held on the date, from the ledger (0 if not held): exact whatever valuation ran. */
async function getHeldQuantity(portfolioId, securityId, dateStr) {
  return (
    (await ledger.getLedgerHoldings(portfolioId, dateStr)).get(securityId) ?? 0
  );
}

/**
 * INFLOW / OUTFLOW / REWARDS / INTEREST -> one capital flow. Cash (or crypto) moves are CASHIN / CASHOUT, any other
 * security ASSETIN / ASSETOUT; REWARDS and INTEREST keep their type. No security = base-currency cash.
 * Migrated from processFlow in // eventsProcessing.gs
 */
async function processFlow(event) {
  const portfolio = await ledger.getPortfolio(event.portfolio_id);
  const securityId =
    event.security_id ?? (await ledger.cashSecurityFor(portfolio.currency));

  let flowType = event.event_type;
  if (flowType === "INFLOW" || flowType === "OUTFLOW") {
    const security = await ledger.getSecurity(securityId);
    const isCash = ["CASH", "CRYPTO"].includes(security.asset_type); // GAS cashMap: cash + crypto securities
    if (isCash) flowType = event.event_type === "INFLOW" ? "CASHIN" : "CASHOUT";
    else flowType = event.event_type === "INFLOW" ? "ASSETIN" : "ASSETOUT";
  }

  await ledger.addCapitalFlow({
    date: effectiveDate(event),
    portfolio_id: event.portfolio_id,
    capital_flow_type: flowType,
    security_id: securityId,
    quantity: Number(event.quantity),
    event_id: event.event_id,
  });
  return true;
}

/**
 * CASH_TRANSFER -> CASHIN on portfolio_id, CASHOUT on source_portfolio_id, same security and quantity.
 * No security = base-currency cash of the receiving portfolio.
 * Migrated from processCashTransfer in // eventsProcessing.gs
 */
async function processCashTransfer(event) {
  if (!event.source_portfolio_id)
    throw new Error("CASH_TRANSFER needs a source_portfolio_id");
  const portfolio = await ledger.getPortfolio(event.portfolio_id);
  const securityId =
    event.security_id ?? (await ledger.cashSecurityFor(portfolio.currency));
  const common = {
    date: effectiveDate(event),
    security_id: securityId,
    quantity: Number(event.quantity),
    event_id: event.event_id,
  };

  await ledger.addCapitalFlow({
    ...common,
    portfolio_id: event.portfolio_id,
    capital_flow_type: "CASHIN",
  });
  await ledger.addCapitalFlow({
    ...common,
    portfolio_id: event.source_portfolio_id,
    capital_flow_type: "CASHOUT",
  });
  return true;
}

/**
 * COUPON_TRANSFER -> on the source: COUPON (income, counts in performance) + CASHOUT of the same cash; on the target:
 * CASHIN. GAS hardcoded CASH_EUR; here the event security if given, else CASH_EUR.
 * Migrated from processCouponTransfer in // eventsProcessing.gs
 */
async function processCouponTransfer(event) {
  if (!event.source_portfolio_id)
    throw new Error("COUPON_TRANSFER needs a source_portfolio_id");
  const common = {
    date: effectiveDate(event),
    security_id: event.security_id ?? "CASH_EUR",
    quantity: Number(event.quantity),
    event_id: event.event_id,
  };

  await ledger.addCapitalFlow({
    ...common,
    portfolio_id: event.source_portfolio_id,
    capital_flow_type: "COUPON",
  });
  await ledger.addCapitalFlow({
    ...common,
    portfolio_id: event.source_portfolio_id,
    capital_flow_type: "CASHOUT",
  });
  await ledger.addCapitalFlow({
    ...common,
    portfolio_id: event.portfolio_id,
    capital_flow_type: "CASHIN",
  });
  return true;
}

/**
 * Fees for a buy / sell: fees_override when given, else the Borsa Italiana rule for the event location (BOT, BTP),
 * else 0. GAS: an empty FEES_OVERRIDE ("" >= 0 is true) always won and the location lookup was broken, so computed
 * fees never applied.
 * Migrated from processFees in // eventsProcessing.gs
 */
async function computeFees(event, price) {
  // Fees for bonds bought on Borsa Italiana when no fees_override is given (% of market value, minimum)
  // Migrated from XMLPATHS[location].fees in // local.gs
  const FEE_RULES = {
    BOT: { pct: 0.065, min: 0 },
    BTP: { pct: 0.035, min: 3 },
  };
  if (event.fees_override !== null && event.fees_override !== undefined)
    return Number(event.fees_override);
  const rule = FEE_RULES[event.location];
  if (!rule) return 0;
  const marketValue = await ledger.computeMarketValue(
    event.security_id,
    price,
    Number(event.quantity),
  );
  return Math.max((marketValue * rule.pct) / 100, rule.min);
}

/**
 * When the cash of a buy / sell lives in another portfolio (source_portfolio_id): the money moves between the two
 * accounts. Buy: CASHOUT from the source, CASHIN to the portfolio of market value + fees; sell: the reverse of market
 * value - fees. Each side in its own portfolio currency (GAS used the portfolio-currency amount on both sides).
 * Migrated from transactionToFlowSeparateAccounts in // eventsProcessing.gs
 */
async function moveCashBetweenAccounts(event, transaction) {
  if (
    !event.source_portfolio_id ||
    event.source_portfolio_id === event.portfolio_id
  )
    return;

  const isBuy = transaction.transaction_type === "BUY";
  const portfolio = await ledger.getPortfolio(event.portfolio_id);
  const source = await ledger.getPortfolio(event.source_portfolio_id);
  const dateStr = transaction.date;

  const amountBase =
    transaction.market_value_base +
    (isBuy ? 1 : -1) * transaction.fee_value_base;
  const amountSource =
    amountBase *
    currencyConverter(portfolio.currency, source.currency, dateStr);

  await ledger.addCapitalFlow({
    date: dateStr,
    portfolio_id: source.portfolio_id,
    capital_flow_type: isBuy ? "CASHOUT" : "CASHIN",
    security_id: await ledger.cashSecurityFor(source.currency),
    quantity: amountSource,
    event_id: event.event_id,
  });
  await ledger.addCapitalFlow({
    date: dateStr,
    portfolio_id: portfolio.portfolio_id,
    capital_flow_type: isBuy ? "CASHIN" : "CASHOUT",
    security_id: await ledger.cashSecurityFor(portfolio.currency),
    quantity: amountBase,
    event_id: event.event_id,
  });
}

/**
 * PURCHASE -> BUY transaction (+ cash from the source portfolio, + capital gain tax withheld on BOTs).
 * Price: event price, else latest. Counter / fee currency: the security currency, or the portfolio currency with
 * event_metadata.purchaseInBaseCcy. GAS also auto-added unknown BOT / BTP securities to securityMaster by scraping
 * Borsa Italiana: not ported, the security must exist.
 * Migrated from processPurchaseEvent in // eventsProcessing.gs
 */
async function processPurchase(event) {
  const dateStr = effectiveDate(event);
  const portfolio = await ledger.getPortfolio(event.portfolio_id);
  const security = await ledger.getSecurity(event.security_id);
  const quantity = Number(event.quantity);

  const price =
    event.price ??
    (await ledger.getLatestPriceForDate(event.security_id, dateStr));
  const fee = await computeFees(event, price);
  const tradeCurrency = event.event_metadata?.purchaseInBaseCcy
    ? portfolio.currency
    : security.currency;

  const transaction = await ledger.addTransaction({
    date: dateStr,
    portfolio_id: event.portfolio_id,
    security_id: event.security_id,
    transaction_type: "BUY",
    quantity,
    transaction_price: price,
    fee,
    counter_currency: tradeCurrency,
    fee_currency: tradeCurrency,
    event_id: event.event_id,
  });
  await moveCashBetweenAccounts(event, transaction);

  // Capital gain tax withheld at purchase (%), on the expected profit to maturity. GAS: XMLPATHS.BOT.taxAtSource
  const TAX_AT_SOURCE = { BOT: 12.5 };
  const taxRate = TAX_AT_SOURCE[event.location];
  if (taxRate) {
    // Expected profit to maturity: redemption (face x quantity) - (purchase value + fees). GAS multiplied by 12.5
    // instead of 12.5%.
    const purchaseValue =
      (await ledger.computeMarketValue(event.security_id, price, quantity)) +
      fee;
    const expectedProfit =
      Number(security.face ?? 1000) * quantity - purchaseValue;
    await ledger.addCapitalFlow({
      date: dateStr,
      portfolio_id: event.portfolio_id,
      capital_flow_type: "CAPITAL_GAIN_TAX",
      security_id: await ledger.cashSecurityFor(security.currency),
      quantity: (expectedProfit * taxRate) / 100,
      event_id: event.event_id,
    });
  }
  return true;
}

/**
 * SALE -> SELL transaction (+ cash to the source portfolio, + the capital gain tax the broker withheld,
 * event_metadata.tax_withheld, as a CAPITAL_GAIN_TAX flow). The security must be held on that day.
 * GAS dated the transaction on DATE even when PROCESS_DATE was set; here everything uses the effective date.
 * Migrated from processSaleEvent in // eventsProcessing.gs
 */
async function processSale(event) {
  const dateStr = effectiveDate(event);
  const security = await ledger.getSecurity(event.security_id);
  if (
    (await getHeldQuantity(event.portfolio_id, event.security_id, dateStr)) ===
    0
  ) {
    throw new Error(
      `selling ${event.security_id}, not found in the latest positions of ${event.portfolio_id}`,
    );
  }

  const price =
    event.price ??
    (await ledger.getLatestPriceForDate(event.security_id, dateStr));
  const transaction = await ledger.addTransaction({
    date: dateStr,
    portfolio_id: event.portfolio_id,
    security_id: event.security_id,
    transaction_type: "SELL",
    quantity: Number(event.quantity),
    transaction_price: price,
    fee: await computeFees(event, price),
    counter_currency: security.currency,
    fee_currency: security.currency,
    event_id: event.event_id,
  });
  await moveCashBetweenAccounts(event, transaction);

  const taxWithheld = Number(event.event_metadata?.tax_withheld ?? 0);
  if (taxWithheld > 0) {
    await ledger.addCapitalFlow({
      date: dateStr,
      portfolio_id: event.portfolio_id,
      capital_flow_type: "CAPITAL_GAIN_TAX",
      security_id: await ledger.cashSecurityFor(security.currency),
      quantity: taxWithheld,
      event_id: event.event_id,
    });
  }
  return true;
}

/**
 * BALANCE -> forces the portfolio's base-currency cash to event.quantity with an ADJUST_IN / ADJUST_OUT flow of the
 * difference from the cash held on that day per the ledger (independent of whether valuation ran before events).
 * On FILE portfolios the event is the valuation (valuation.runFile reads it): no ledger rows.
 * Migrated from forceCashBalance in // eventsProcessing.gs
 */
async function forceCashBalance(event) {
  const dateStr = effectiveDate(event);
  const portfolio = await ledger.getPortfolio(event.portfolio_id);

  // FILE portfolios are valued from the latest BALANCE event itself: an ADJUST flow would duplicate the movements
  // already in their ledger (e.g. the CASHOUT of a transfer), so nothing is written
  if (portfolio.valuation_method === "FILE") return true;
  const cashSecurityId = await ledger.cashSecurityFor(portfolio.currency);

  const cashHeld =
    (await ledger.getLedgerHoldings(event.portfolio_id, dateStr)).get(
      cashSecurityId,
    ) ?? 0;
  const adjustment = Number((Number(event.quantity) - cashHeld).toFixed(8));
  if (adjustment === 0) return true;

  await ledger.addCapitalFlow({
    date: dateStr,
    portfolio_id: event.portfolio_id,
    capital_flow_type: adjustment > 0 ? "ADJUST_IN" : "ADJUST_OUT",
    security_id: cashSecurityId,
    quantity: Math.abs(adjustment),
    event_id: event.event_id,
  });
  return true;
}

/**
 * MATURED_SECURITY -> SELL of the whole held quantity at redemption (par: price 100 for percent-priced bonds, else
 * face), then the proceeds move to source_portfolio_id if given. GAS only computed the sale without writing it (the
 * bond stayed in the portfolio forever) and used the currency code as SECURITY_ID for the cash flows.
 * Migrated from replaceMaturedSecurities in // eventsProcessing.gs
 */
async function replaceMaturedSecurity(event) {
  const dateStr = effectiveDate(event);
  const security = await ledger.getSecurity(event.security_id);
  const heldQuantity = await getHeldQuantity(
    event.portfolio_id,
    event.security_id,
    dateStr,
  );
  if (heldQuantity === 0)
    throw new Error(
      `${event.security_id} not held in ${event.portfolio_id} on ${dateStr}`,
    );

  const transaction = await ledger.addTransaction({
    date: dateStr,
    portfolio_id: event.portfolio_id,
    security_id: event.security_id,
    transaction_type: "SELL",
    quantity: heldQuantity,
    transaction_price: security.price_pct ? 100 : Number(security.face),
    fee: 0,
    counter_currency: security.currency,
    fee_currency: security.currency,
    event_id: event.event_id,
  });

  if (
    event.source_portfolio_id &&
    event.source_portfolio_id !== event.portfolio_id
  ) {
    const common = {
      date: dateStr,
      security_id: await ledger.cashSecurityFor(security.currency),
      quantity: transaction.market_value_local,
      event_id: event.event_id,
    };
    await ledger.addCapitalFlow({
      ...common,
      portfolio_id: event.portfolio_id,
      capital_flow_type: "CASHOUT",
    });
    await ledger.addCapitalFlow({
      ...common,
      portfolio_id: event.source_portfolio_id,
      capital_flow_type: "CASHIN",
    });
  }
  return true;
}

/**
 * RECURRING_PAYMENT (generated from recurring_flows) -> the instalment moves between the loan / receivable portfolio
 * and the linked account (source_portfolio_id, optional):
 * - loan (DEBT security): CASHIN of the payment on the loan (debt goes down, net PnL = -interest); the linked account
 *   pays INTEREST_PAID (interest), CASHOUT (principal) and TAX, in cash of the loan currency
 * - receivable (any other security): CASHOUT of the payment on the receivable; the linked account gets CASHIN
 * GAS swapped interest and principal on the linked account, used DEBT_EUR as the linked cash, and wrote CASHIN on
 * receivables (wrong sign).
 * Migrated from the payment-day branch of runRecurringFlows in // portfolioData.gs
 */
async function processRecurringPayment(event) {
  const dateStr = effectiveDate(event);
  const security = await ledger.getSecurity(event.security_id);
  const isLoan = security.asset_type === "DEBT";
  const payment = Number(event.quantity);
  const metadata = event.event_metadata ?? {};

  await ledger.addCapitalFlow({
    date: dateStr,
    portfolio_id: event.portfolio_id,
    capital_flow_type: isLoan ? "CASHIN" : "CASHOUT",
    security_id: event.security_id,
    quantity: payment,
    event_id: event.event_id,
  });

  if (!event.source_portfolio_id) return true;
  const linkedCash = {
    date: dateStr,
    portfolio_id: event.source_portfolio_id,
    security_id: await ledger.cashSecurityFor(security.currency),
    event_id: event.event_id,
  };
  if (!isLoan) {
    await ledger.addCapitalFlow({
      ...linkedCash,
      capital_flow_type: "CASHIN",
      quantity: payment,
    });
    return true;
  }
  const legs = [
    ["INTEREST_PAID", Number(metadata.interest ?? 0)],
    ["CASHOUT", Number(metadata.principal ?? 0)],
    ["TAX", Number(metadata.tax ?? 0)],
  ];
  for (const [flowType, amount] of legs) {
    if (amount > 0)
      await ledger.addCapitalFlow({
        ...linkedCash,
        capital_flow_type: flowType,
        quantity: amount,
      });
  }
  return true;
}

/**
 * Processes every event with processed_at NULL and date <= dateStr, oldest first: runs the handler for its type and
 * stamps processed_at, atomically per event. Unlike GAS (only events dated today), missed nights and late-entered
 * events are picked up. Ledger rows are dated on the effective date (process_date ?? date) and carry the event_id.
 * TODO: an event with an effective date (process_date ?? date) in the past must make ROLL recompute that portfolio
 * from that date (GAS runStartDate flag).
 * Migrated from the event loop of runPortfolioEvents in // portfolioData.gs
 *
 * @param {string} dateStr - ISO date, last event date to process
 * @returns {Promise<{processed: number, pending: number, failed: number}>}
 */
export async function processEvents(dateStr) {
  await loadFxRates();
  const { rows: pendingEvents } = await query(
    `SELECT * FROM events WHERE processed_at IS NULL AND date <= $1 ORDER BY date, event_id;`,
    [dateStr],
  );

  const summary = { processed: 0, pending: 0, failed: 0 };
  for (const event of pendingEvents) {
    const handler = EVENT_HANDLERS[event.event_type];
    if (!handler) {
      console.warn(
        `[EVENTS] Unknown event type ${event.event_type} (event ${event.event_id}), left pending.`,
      );
      summary.pending++;
      continue;
    }

    try {
      // All-or-nothing per event: a handler failing halfway leaves no ledger rows behind
      const processed = await withSavepoint(async () => {
        if (!(await handler(event))) return false;
        await query(
          `UPDATE events SET processed_at = NOW() WHERE event_id = $1;`,
          [event.event_id],
        );
        return true;
      });
      if (processed) summary.processed++;
      else summary.pending++;
    } catch (error) {
      console.error(
        `[EVENTS] Event ${event.event_id} (${event.event_type} ${event.portfolio_id}) failed:`,
        error.message,
      );
      summary.failed++;
    }
  }
  return summary;
}

/**
 * Reconciles scheduled_events with events: every occurrence due from start_date up to dateStr (before end_date, on the
 * days the schedule runs) that has no event yet gets one. No window: a batch down for any number of days catches up,
 * history included. Each event carries { scheduled_event_id } in event_metadata, so it is never created twice.
 * Migrated from runAutoEvents in // portfolioData.gs (AUTO_EVENTS config -> scheduled_events table)
 *
 * @param {string} dateStr - ISO date, last day to generate
 * @returns {Promise<number>} events created
 */
export async function generateScheduledEvents(dateStr) {
  const { rows: schedules } = await query(
    `SELECT * FROM scheduled_events WHERE start_date <= $1;`,
    [dateStr],
  );

  const candidates = [];
  for (const schedule of schedules) {
    const firstDay = utils.formatDateToISO(schedule.start_date);
    const end = schedule.end_date
      ? utils.formatDateToISO(schedule.end_date)
      : null;
    for (const day of utils.daysBetween(firstDay, dateStr)) {
      if ((end && day >= end) || !utils.doesItRunToday(schedule, day)) continue;
      candidates.push({
        date: day,
        event_type: schedule.event_type,
        portfolio_id: schedule.portfolio_id,
        source_portfolio_id: schedule.source_portfolio_id,
        security_id: schedule.security_id,
        quantity: schedule.quantity,
        price: schedule.price,
        event_notes: schedule.event_notes,
        event_metadata: {
          ...schedule.event_metadata,
          scheduled_event_id: Number(schedule.scheduled_event_id),
        },
      });
    }
  }

  return insertNewEvents(candidates, "scheduled_event_id", (id) =>
    String(Number(id)),
  );
}

/**
 * Reconciles recurring_flows with events: one RECURRING_PAYMENT event per instalment with eval_date <= dateStr and
 * payment > 0 that has no event yet (no window, history included):
 * money moves from the linked portfolio (source, e.g. BANCA360) to the loan / receivable portfolio (e.g. MORTGAGE).
 * Interest / principal / tax travel in event_metadata for the handler that will write the flows.
 * GAS wrote the flows directly on the eval date (and only if the portfolio ran that day); here it is an event.
 * Migrated from the payment-day branch of runRecurringFlows in // portfolioData.gs
 *
 * @param {string} dateStr - ISO date, last day to generate
 * @returns {Promise<number>} events created
 */
export async function generateRecurringFlowEvents(dateStr) {
  const { rows: instalments } = await query(
    `
    SELECT *, to_char(eval_date, 'YYYY-MM-DD') AS eval_date_str
    FROM recurring_flows
    WHERE eval_date <= $1 AND payment > 0;`,
    [dateStr],
  );

  const candidates = instalments.map((row) => ({
    date: row.eval_date_str,
    event_type: "RECURRING_PAYMENT",
    portfolio_id: row.portfolio_id,
    source_portfolio_id: row.linked_portfolio_id,
    security_id: row.security_id,
    quantity: row.payment,
    price: null,
    event_notes: row.payment_desc,
    event_metadata: {
      recurring_flow: {
        portfolio_id: row.portfolio_id,
        payment_desc: row.payment_desc,
        eval_date: row.eval_date_str,
      },
      principal: row.principal,
      interest: row.interest,
      tax: row.tax,
    },
  }));

  return insertNewEvents(
    candidates,
    "recurring_flow",
    (source) =>
      `${source.portfolio_id}|${source.payment_desc}|${source.eval_date}`,
  );
}

/**
 * Inserts the candidate events that don't exist yet. An event exists when its event_metadata[sourceKey] matches
 * (the row that generated it), so reruns never duplicate events.
 *
 * @param {Array<Object>} candidates - Events to create
 * @param {string} sourceKey - event_metadata key identifying the source row
 * @param {Function} sourceToKey - event_metadata[sourceKey] -> comparable string (jsonb reorders object keys)
 * @returns {Promise<number>} events inserted
 */
export async function insertNewEvents(candidates, sourceKey, sourceToKey) {
  if (candidates.length === 0) return 0;

  const { rows: existing } = await query(
    `SELECT date::text AS date, event_metadata -> $1 AS source FROM events WHERE event_metadata ? $1;`,
    [sourceKey],
  );
  const existingKeys = new Set(
    existing.map((row) => `${row.date}|${sourceToKey(row.source)}`),
  );

  const newEvents = candidates.filter(
    (event) =>
      !existingKeys.has(
        `${event.date}|${sourceToKey(event.event_metadata[sourceKey])}`,
      ),
  );
  if (newEvents.length === 0) return 0;

  // No event_id in the rows: the identity PK assigns one, so every row is a new insert
  await replaceDataInDb(newEvents, "events");

  for (const event of newEvents) {
    console.log(
      `[EVENTS] + ${event.date} ${event.event_type} ${event.portfolio_id} ${event.quantity} (${sourceKey})`,
    );
  }
  return newEvents.length;
}
