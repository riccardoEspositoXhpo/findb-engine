import { utils } from "#core/utils.js";
import { query, replaceDataInDb, withSavepoint } from "#core/db.js";
import { loadFxRates, currencyConverter } from "#market/index.js";
import { ledger, OUTFLOW_TYPES } from "#ledger/ledger.js";
import { isPortfolioActive } from "#valuation/index.js";

export const taxes = {
  run,
  computeLots,
  computeTaxItems,
};

// Italian tax residency from 2023: no capital gain tax before (the user was a foreigner)
const FIRST_TAX_YEAR = 2023;
// Transfer pairing (lot_transfers AUTO): ASSETIN 0-5 days after the ASSETOUT, quantity within 1% (network fees)
const TRANSFER_DAYS = 5;
const TRANSFER_QTY_TOLERANCE = 0.01;
// Transfers out of these portfolios are a vesting, not a move: the shares start a new lot at their value on the vest
// day (taxed as employment income then), instead of carrying the grant value
const COST_AT_TRANSFER_FROM = ["AWARDS_UNVESTED"];
const CLASSIC_INCOME = ["DIVIDEND", "COUPON", "INTEREST"];
// GAS CRYPTO_INCOME; REWARDS (card cashback) are left out
const CRYPTO_INCOME = ["STAKING", "EARN"];
const cryptoRate = (year) => (year >= 2026 ? 33 : 26);
const EPS = 1e-9;

/**
 * Nightly tax step, after valuation (needs today's positions): lots from the whole ledger (open_lots: one row per
 * holding, closed_lots ENGINE rows: one per sale), tax items per year / flow block (tax_items), and the whole history
 * of two tax portfolios (one negative DEBT_EUR line a day): UNREALIZED_TAX = Σ est_tax_eur of the open lots that day,
 * REALIZED_TAX = declared tax owed and not yet paid (tax_payments).
 * Migrated from positionLotCalculator + runTaxLots + runUnrealizedTax in // taxCalculations.gs, portfolioData.gs
 *
 * @param {Date|string} [targetDate=new Date()]
 * @returns {Promise<{openLots: number, closedLots: number, taxItems: number, unrealizedTax: number, findings: Object}>}
 */
export async function run(targetDate = new Date()) {
  const dateStr = utils.formatDateToISO(targetDate);
  console.log(`[TAXES] Starting position lots + tax items for ${dateStr}...`);
  await loadFxRates();

  const lots = await computeLots(dateStr, { history: true });
  await withSavepoint(async () => {
    await query(`DELETE FROM open_lots;`);
    await query(`DELETE FROM closed_lots WHERE source = 'ENGINE';`);
    await replaceDataInDb(lots.openLots, "open_lots");
    await replaceDataInDb(lots.closedLots, "closed_lots");
  });

  const { items, unrealizedTax, inputs } = await computeTaxItems(dateStr, lots);
  await withSavepoint(async () => {
    await query(`DELETE FROM tax_items;`);
    await replaceDataInDb(items, "tax_items");
  });

  // UNREALIZED_TAX / REALIZED_TAX: their whole history every night (upserts: only the days whose value changed get a
  // new created_at, so aggregates and performance restart only from a real change)
  const { rows: payments } = await query(`SELECT tax_year, paid_on::text AS paid_on FROM tax_payments;`);
  const realizedHistory = new Map();
  for (let day = `${FIRST_TAX_YEAR}-01-01`; day <= dateStr; day = utils.addDays(day, 1)) realizedHistory.set(day, realizedTaxOwed(inputs, day, payments));
  const realizedTax = realizedHistory.get(dateStr) ?? 0;
  await writeTaxPortfolio("UNREALIZED_TAX", lots.unrealizedHistory);
  await writeTaxPortfolio("REALIZED_TAX", realizedHistory);

  const findings = {};
  for (const finding of lots.findings) findings[finding.type] = (findings[finding.type] ?? 0) + 1;
  console.log(`[TAXES] Done: ${lots.openLots.length} open lots, ${lots.closedLots.length} closed lots, ${items.length} tax items, unrealized tax ${unrealizedTax.toFixed(2)} EUR, realized tax owed ${realizedTax.toFixed(2)} EUR. Findings: ${JSON.stringify(findings)}`);
  return { openLots: lots.openLots.length, closedLots: lots.closedLots.length, taxItems: items.length, unrealizedTax, realizedTax, findings };
}

/** One negative line a day in the EUR DEBT security (date -> tax in EUR) for a tax portfolio, from its inception (closed: to its end). */
async function writeTaxPortfolio(portfolioId, series) {
  const { rows } = await query(`SELECT * FROM portfolios WHERE portfolio_id = $1;`, [portfolioId]);
  if (!rows[0]) return;
  const debtSecurity = await ledger.debtSecurityFor("EUR");
  const positionRows = [];
  const navRows = [];
  for (const [date, tax] of series) {
    if (!isPortfolioActive(rows[0], date)) continue;
    const value = -Number(tax.toFixed(2));
    positionRows.push({ date, portfolio_id: portfolioId, security_id: debtSecurity, quantity: value, price: 1, market_value_local: value, market_value_base: value, market_value_eur: value, weight: 100 });
    navRows.push({ date, portfolio_id: portfolioId, nav: value, nav_eur: value });
  }
  await withSavepoint(async () => {
    await replaceDataInDb(positionRows, "positions");
    await replaceDataInDb(navRows, "nav");
  });
}

/**
 * Lots over the whole ledger up to dateStr, all portfolios in one chronological pass (per day: inflows, transactions,
 * outflows, then paired ASSETINs), so a transfer's lots always exist when its ASSETIN needs them. In memory there is
 * one lot per purchase (or receipt); what is written is one open lot per holding (portfolio x security: quantity,
 * cost, average price) and one closed lot per sale. The cost a sale takes depends on the security (user, 2026-10-29):
 * - crypto: LIFO, the newest lots first (Agenzia delle Entrate: like foreign currencies)
 * - everything else: weighted average cost (art. 68 c.6 TUIR, what the brokers apply): every lot gives up the same
 *   share, so the average price of what is left doesn't move
 * Rules:
 * - cash (fiat) and stablecoins never form lots
 * - BUY with cash / stablecoin: new lot, cost = price paid + fee
 * - asset -> cash / stablecoin (fiscally relevant): consumes lots, one closed lot for the sale. Taxable = gross - cost
 *   (Directa note), realized_pnl = gross - fee - cost
 * - asset -> asset (crypto <-> crypto): not a realization, the consumed cost (+ fee) moves to a new lot of what was
 *   received
 * - received for free (STAKING, REWARDS, ADJUST_IN, unpaired ASSETIN...): new lot at its value that day
 * - ASSETOUT paired in lot_transfers: the lots travel with their lot_id, acquisition date and EUR cost; other
 *   outflows (ADJUST_OUT, fees paid in an asset, unpaired ASSETOUT) just consume lots
 * - cost kept in EUR at the acquisition date's fx: the Italian gain is EUR proceeds - EUR cost
 * - open lots valued at the portfolio's latest positions on or before dateStr (closed portfolios: none)
 * - selling more than the lots hold is a finding (SHORT_LOTS), as are unpaired transfers and flows without a value.
 *   The missing quantity stays owed, like the negative position it is: the next inflow of that security (often the
 *   ADJUST_IN that zeroes the position) pays it back before opening a lot
 * New transfers are paired here and saved to lot_transfers (AUTO); existing pairs are never changed.
 *
 * @param {string} dateStr - ISO date, last ledger day
 * @returns {Promise<{openLots: Array, closedLots: Array, findings: Array, securities: Map, portfolios: Map}>}
 */
export async function computeLots(dateStr, { history = false } = {}) {
  const { rows: securityRows } = await query(`SELECT security_id, currency, asset_type, asset_classification FROM security_master;`);
  const securities = new Map(securityRows.map((row) => [row.security_id, row]));
  const { rows: currencyRows } = await query(`SELECT currency_code, type FROM currencies;`);
  const stablecoins = new Set(currencyRows.filter((row) => row.type === "STABLECOIN").map((row) => row.currency_code));
  const { rows: portfolioRows } = await query(`SELECT portfolio_id, currency, fiscal_regime, portfolio_type, closed_date, ivafe_taxable FROM portfolios;`);
  const portfolios = new Map(portfolioRows.map((row) => [row.portfolio_id, row]));

  // Holding of a currency: its CASH security (fiat) or CRYPTO security (tokens), found by attributes, not by name
  const holdings = new Map();
  for (const row of securityRows)
    if (row.asset_type === "CASH" || (row.asset_type === "CRYPTO" && !holdings.has(row.currency))) holdings.set(row.currency, row.security_id);
  const securityFor = (currency) => holdings.get(currency) ?? currency;
  const isCashLike = (securityId) => {
    const security = securities.get(securityId);
    return ["CASH", "DEBT"].includes(security?.asset_type) || (security?.asset_type === "CRYPTO" && stablecoins.has(security.currency));
  };
  const costMethod = (securityId) => (securities.get(securityId)?.asset_type === "CRYPTO" ? "LIFO" : "AVG");
  const toEur = (amount, currency, date) => {
    const rate = currencyConverter(currency, "EUR", date);
    return rate === null || amount === null ? null : amount * rate;
  };
  // Capital gain tax rate (%) of a holding in a year (user, 2026-10-30): only portfolios with a fiscal_regime are
  // taxed on their gains (no regime -> null: pensions are taxed as income at payout, real assets, liabilities); none
  // before residency; real assets 0; crypto; 12.5% government bonds; 26% otherwise
  const taxRate = (portfolioId, securityId, year) => {
    const portfolio = portfolios.get(portfolioId);
    const security = securities.get(securityId);
    if (!portfolio?.fiscal_regime) return null;
    if (year < FIRST_TAX_YEAR) return 0;
    if (["REAL_ASSET", "REAL_ESTATE"].includes(security?.asset_type)) return 0;
    if (security?.asset_type === "CRYPTO") return cryptoRate(year);
    return /Government/i.test(security?.asset_classification ?? "") ? 12.5 : 26;
  };

  const { rows: transactions } = await query(
    `SELECT transaction_id AS id, date::text AS date, portfolio_id, security_id, transaction_type, quantity::float, fee::float,
            fee_currency, fee_value_base::float, counter_currency, market_value_local::float, market_value_base::float
     FROM transactions WHERE date <= $1 ORDER BY date, transaction_id;`,
    [dateStr],
  );
  const { rows: flows } = await query(
    `SELECT capital_flow_id AS id, date::text AS date, portfolio_id, capital_flow_type, security_id, quantity::float, market_value_base::float
     FROM capital_flows WHERE date <= $1 ORDER BY date, capital_flow_id;`,
    [dateStr],
  );

  // A flow without market_value_base is valued at the portfolio's latest position value per unit for it
  const { rows: unitRows } = await query(
    `SELECT portfolio_id, security_id, date::text AS date, (market_value_base / NULLIF(quantity, 0))::float AS unit FROM positions
     WHERE (portfolio_id, security_id) IN (SELECT DISTINCT portfolio_id, security_id FROM capital_flows WHERE coalesce(market_value_base, 0) = 0)
     ORDER BY date;`,
  );
  const unitValue = (portfolioId, securityId, date) => {
    let found = null;
    for (const row of unitRows) if (row.portfolio_id === portfolioId && row.security_id === securityId && row.date <= date && row.unit) found = row.unit;
    return found;
  };

  const pairs = await pairTransfers(flows.filter((flow) => !isCashLike(flow.security_id)));
  const pairedOuts = new Set(pairs.values());

  const operations = [
    ...flows.map((flow) => ({ ...flow, flow: true, kind: pairs.has(flow.id) ? 3 : OUTFLOW_TYPES.includes(flow.capital_flow_type) ? 2 : 0 })),
    ...transactions.map((tx) => ({ ...tx, flow: false, kind: 1 })),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.kind - b.kind || Number(a.id) - Number(b.id));

  const book = new Map(); // portfolio|security -> lots, newest last (LIFO takes from the end)
  const inTransit = new Map(); // ASSETOUT id -> consumed lots
  const owed = new Map(); // portfolio|security -> quantity sold beyond the lots, not yet received back
  const closedLots = [];
  const findings = [];
  const lotsOf = (portfolioId, securityId) => {
    const key = `${portfolioId}|${securityId}`;
    return book.get(key) ?? book.set(key, []).get(key);
  };
  // Share of an inflow left after paying back what is owed on portfolio|security
  const repay = (portfolioId, securityId, quantity) => {
    const key = `${portfolioId}|${securityId}`;
    const paid = Math.min(owed.get(key) ?? 0, quantity);
    if (paid > 0) owed.set(key, owed.get(key) - paid);
    return quantity > 0 ? (quantity - paid) / quantity : 0;
  };
  const openLot = (portfolioId, securityId, date, quantity, costBase, via, lotId) => {
    if (isCashLike(securityId) || quantity <= EPS) return;
    const kept = repay(portfolioId, securityId, quantity);
    [quantity, costBase] = [quantity * kept, costBase * kept];
    if (quantity <= EPS) return;
    lotsOf(portfolioId, securityId).push({
      lot_id: lotId, acquired_date: date, acquired_via: via, quantity,
      orig_value_base: costBase, orig_value_eur: toEur(costBase, portfolios.get(portfolioId).currency, date),
    });
  };
  // Part of a lot, with its share of the cost, taken out of it
  const take = (lot, part) => {
    const share = part / lot.quantity;
    const piece = { ...lot, quantity: part, orig_value_base: lot.orig_value_base * share, orig_value_eur: lot.orig_value_eur === null ? null : lot.orig_value_eur * share };
    lot.quantity -= part;
    lot.orig_value_base -= piece.orig_value_base;
    if (lot.orig_value_eur !== null) lot.orig_value_eur -= piece.orig_value_eur;
    return piece;
  };
  // Takes quantity from the lots (LIFO: newest first; AVG: the same share of every lot); returns the pieces taken
  const consume = (portfolioId, securityId, quantity, date, why) => {
    const lots = lotsOf(portfolioId, securityId);
    const taken = [];
    let left = quantity;
    if (costMethod(securityId) === "AVG") {
      const held = lots.reduce((total, lot) => total + lot.quantity, 0);
      const part = Math.min(held, left);
      if (part > EPS) {
        for (const lot of lots) taken.push(take(lot, (lot.quantity * part) / held));
        lots.splice(0, lots.length, ...lots.filter((lot) => lot.quantity > EPS));
      }
      left -= part;
    }
    while (left > EPS && lots.length) {
      const lot = lots.at(-1);
      const part = Math.min(lot.quantity, left);
      taken.push(take(lot, part));
      if (lot.quantity <= EPS) lots.pop();
      left -= part;
    }
    if (left > EPS) owed.set(`${portfolioId}|${securityId}`, (owed.get(`${portfolioId}|${securityId}`) ?? 0) + left);
    if (left > 1e-6) findings.push({ type: "SHORT_LOTS", date, portfolio_id: portfolioId, security_id: securityId, missing: left, why });
    return taken;
  };
  const sum = (pieces, key) => pieces.reduce((total, piece) => (total === null || piece[key] === null ? null : total + piece[key]), 0);

  // One open lot per holding valued at a position (share of it by quantity), as of a date
  const holdingRow = (asOf, portfolioId, securityId, lots, position) => {
    const quantity = lots.reduce((total, lot) => total + lot.quantity, 0);
    if (quantity <= 1e-8) return null;
    const origBase = sum(lots, "orig_value_base");
    const origEur = sum(lots, "orig_value_eur");
    const share = position?.quantity ? quantity / position.quantity : null;
    const currentBase = share === null ? null : position.market_value_base * share;
    const currentEur = share === null ? null : position.market_value_eur * share;
    const pnlBase = currentBase === null || origBase === null ? null : currentBase - origBase;
    const pnlEur = currentEur === null || origEur === null ? null : currentEur - origEur;
    const rate = taxRate(portfolioId, securityId, Number(asOf.slice(0, 4)));
    return {
      date: asOf, portfolio_id: portfolioId, security_id: securityId, cost_method: costMethod(securityId), quantity,
      orig_price: origBase === null ? null : origBase / quantity, orig_value_base: origBase, orig_value_eur: origEur,
      current_price: currentBase === null ? null : currentBase / quantity, current_value_base: currentBase, current_value_eur: currentEur,
      unrealized_pnl_base: pnlBase, unrealized_pnl_eur: pnlEur,
      unrealized_return_pct: pnlBase === null || !origBase ? null : (pnlBase / origBase) * 100,
      // The whole holding sold today: the gain net of its losing purchases
      tax_rate: rate, est_tax_eur: pnlEur === null || rate === null ? null : (Math.max(pnlEur, 0) * rate) / 100,
    };
  };

  // history: the estimated tax on the open lots at the end of every day from the first operation (UNREALIZED_TAX
  // series), each day valued at every portfolio's latest positions on or before it
  const unrealizedHistory = new Map();
  let snapshotDay = null;
  let takeSnapshot = () => {};
  if (history && operations.length) {
    const { rows: positionRows } = await query(
      `SELECT portfolio_id, date::text AS date, security_id, quantity::float, market_value_base::float, market_value_eur::float FROM positions WHERE date <= $1 ORDER BY portfolio_id, date;`,
      [dateStr],
    );
    const days = new Map(); // portfolio -> [[date, Map(security -> position)]] ascending
    for (const row of positionRows) {
      const series = days.get(row.portfolio_id) ?? days.set(row.portfolio_id, []).get(row.portfolio_id);
      if (series.at(-1)?.[0] !== row.date) series.push([row.date, new Map()]);
      series.at(-1)[1].set(row.security_id, row);
    }
    const pointer = new Map();
    snapshotDay = operations[0].date;
    takeSnapshot = (upTo) => {
      for (; snapshotDay < upTo && snapshotDay <= dateStr; snapshotDay = utils.addDays(snapshotDay, 1)) {
        let tax = 0;
        for (const [key, lots] of book) {
          if (!lots.length) continue;
          const [portfolioId, securityId] = key.split("|");
          const closed = portfolios.get(portfolioId).closed_date;
          if (closed && utils.formatDateToISO(closed) < snapshotDay) continue;
          const series = days.get(portfolioId) ?? [];
          let index = pointer.get(portfolioId) ?? -1;
          while (index + 1 < series.length && series[index + 1][0] <= snapshotDay) index++;
          pointer.set(portfolioId, index);
          tax += holdingRow(snapshotDay, portfolioId, securityId, lots, index >= 0 ? series[index][1].get(securityId) : null)?.est_tax_eur ?? 0;
        }
        unrealizedHistory.set(snapshotDay, tax);
      }
    };
  }

  for (const op of operations) {
    if (snapshotDay && op.date > snapshotDay) takeSnapshot(op.date);
    const portfolio = portfolios.get(op.portfolio_id);
    if (op.flow) {
      if (isCashLike(op.security_id) || !op.quantity) continue;
      const value = op.market_value_base || (unitValue(op.portfolio_id, op.security_id, op.date) ?? 0) * op.quantity;
      if (op.kind === 3) {
        // Paired ASSETIN: the sent lots arrive with their id, dates and EUR cost, quantity rescaled to what arrived
        const outId = pairs.get(op.id);
        const pieces = inTransit.get(outId) ?? [];
        const source = flows.find((flow) => flow.id === outId);
        if (COST_AT_TRANSFER_FROM.includes(source?.portfolio_id) || !pieces.length) {
          openLot(op.portfolio_id, op.security_id, op.date, op.quantity, value, "VEST", `F${op.id}`);
          continue;
        }
        const sent = pieces.reduce((total, piece) => total + piece.quantity, 0);
        const kept = repay(op.portfolio_id, op.security_id, op.quantity);
        for (const piece of pieces) {
          const rate = currencyConverter(portfolio.currency, "EUR", piece.acquired_date);
          const cost = piece.orig_value_eur === null || !rate ? null : (piece.orig_value_eur * kept) / rate;
          const arrived = { ...piece, quantity: (piece.quantity * op.quantity * kept) / sent, orig_value_base: cost,
            orig_value_eur: piece.orig_value_eur === null ? null : piece.orig_value_eur * kept };
          if (arrived.quantity <= EPS) continue;
          // The same purchase already here (moved out and partly back): one lot
          const same = lotsOf(op.portfolio_id, op.security_id).find((lot) => lot.lot_id === arrived.lot_id);
          if (!same) lotsOf(op.portfolio_id, op.security_id).push(arrived);
          else {
            same.quantity += arrived.quantity;
            same.orig_value_base = same.orig_value_base === null || cost === null ? null : same.orig_value_base + cost;
            same.orig_value_eur = same.orig_value_eur === null || arrived.orig_value_eur === null ? null : same.orig_value_eur + arrived.orig_value_eur;
          }
        }
        lotsOf(op.portfolio_id, op.security_id).sort((a, b) => a.acquired_date.localeCompare(b.acquired_date));
      } else if (op.kind === 0) {
        if (op.capital_flow_type === "ASSETIN") findings.push({ type: "UNPAIRED_ASSETIN", date: op.date, portfolio_id: op.portfolio_id, security_id: op.security_id, flow_id: op.id });
        if (!value) findings.push({ type: "NO_VALUE", date: op.date, portfolio_id: op.portfolio_id, security_id: op.security_id, flow_id: op.id });
        openLot(op.portfolio_id, op.security_id, op.date, op.quantity, value, op.capital_flow_type, `F${op.id}`);
      } else {
        const pieces = consume(op.portfolio_id, op.security_id, op.quantity, op.date, op.capital_flow_type);
        if (pairedOuts.has(op.id)) inTransit.set(op.id, pieces);
        else if (op.capital_flow_type === "ASSETOUT") findings.push({ type: "UNPAIRED_ASSETOUT", date: op.date, portfolio_id: op.portfolio_id, security_id: op.security_id, flow_id: op.id });
      }
      continue;
    }

    // BUY receives security_id paying counter_currency, SELL gives security_id receiving counter_currency
    const counter = securityFor(op.counter_currency);
    const [given, givenQty, received, receivedQty] =
      op.transaction_type === "BUY" ? [counter, op.market_value_local, op.security_id, op.quantity] : [op.security_id, op.quantity, counter, op.market_value_local];
    const feeBase = op.fee_value_base ?? 0;
    if (isCashLike(given)) {
      openLot(op.portfolio_id, received, op.date, receivedQty, op.market_value_base + feeBase, "BUY", `T${op.id}`);
    } else {
      const pieces = consume(op.portfolio_id, given, givenQty, op.date, op.transaction_type);
      const sold = pieces.reduce((total, piece) => total + piece.quantity, 0);
      if (isCashLike(received) && sold > EPS) {
        // One closed lot per sale: cost = the pieces taken; sale value and fee of what the lots covered
        const share = sold / givenQty;
        const saleBase = op.market_value_base * share;
        const feeShare = feeBase * share;
        const saleEur = toEur(saleBase, portfolio.currency, op.date);
        const feeEur = toEur(feeShare, portfolio.currency, op.date);
        const origBase = sum(pieces, "orig_value_base");
        const origEur = sum(pieces, "orig_value_eur");
        closedLots.push({
          sale_date: op.date, portfolio_id: op.portfolio_id, security_id: given, sale_id: `T${op.id}`, cost_method: costMethod(given), quantity: sold,
          orig_price: origBase === null ? null : origBase / sold, orig_value_base: origBase, orig_value_eur: origEur,
          sale_price: saleBase / sold, sale_value_base: saleBase, sale_value_eur: saleEur, sale_fee_base: feeShare,
          realized_pnl_base: origBase === null ? null : saleBase - feeShare - origBase,
          realized_pnl_eur: saleEur === null || origEur === null ? null : saleEur - feeEur - origEur,
          realized_return_pct: origBase ? ((saleBase - feeShare - origBase) / origBase) * 100 : null,
          tax_rate: taxRate(op.portfolio_id, given, Number(op.date.slice(0, 4))),
          taxable_gain_eur: saleEur === null || origEur === null ? null : saleEur - origEur,
          sold_for: received, source: "ENGINE",
        });
      } else if (!isCashLike(received)) {
        openLot(op.portfolio_id, received, op.date, receivedQty, sum(pieces, "orig_value_base") + feeBase, "SWAP", `T${op.id}`);
      }
    }
    // A fee paid in a non-cash asset (BNB, or the coin just received) uses up lots of it, after the trade's own legs
    if (op.fee && op.fee_currency && !isCashLike(securityFor(op.fee_currency))) consume(op.portfolio_id, securityFor(op.fee_currency), op.fee, op.date, "FEE");
  }

  if (snapshotDay) takeSnapshot(utils.addDays(dateStr, 1));

  // One open lot per holding, valued at the latest positions on or before dateStr (share of the position by quantity)
  const { rows: latest } = await query(
    `SELECT DISTINCT ON (p.portfolio_id, p.security_id) p.portfolio_id, p.security_id, p.quantity::float, p.market_value_base::float, p.market_value_eur::float
     FROM positions p JOIN (SELECT portfolio_id, max(date) AS d FROM positions WHERE date <= $1 GROUP BY 1) m
       ON m.portfolio_id = p.portfolio_id AND m.d = p.date
     ORDER BY p.portfolio_id, p.security_id;`,
    [dateStr],
  );
  const positions = new Map(latest.map((row) => [`${row.portfolio_id}|${row.security_id}`, row]));
  const openLots = [];
  for (const [key, lots] of book) {
    const [portfolioId, securityId] = key.split("|");
    // A closed portfolio holds nothing: what its lots still show is dust (BINANCE_SPOT ETH 0.0002)
    if (portfolios.get(portfolioId).closed_date) continue;
    const row = holdingRow(dateStr, portfolioId, securityId, lots, positions.get(key));
    if (row) openLots.push(row);
  }
  return { openLots, closedLots, findings, securities, portfolios, unrealizedHistory };
}

/**
 * Pairs the asset transfers not yet in lot_transfers (same security, other portfolio, ASSETIN 0-TRANSFER_DAYS after,
 * quantity within TRANSFER_QTY_TOLERANCE, closest first) and saves them as AUTO. Rows already there, AUTO or MANUAL,
 * are kept as they are.
 *
 * @param {Array} flows - capital flows of non-cash securities
 * @returns {Promise<Map<string, string>>} ASSETIN flow id -> ASSETOUT flow id
 */
async function pairTransfers(flows) {
  const { rows: saved } = await query(`SELECT assetout_flow_id::text AS out_id, assetin_flow_id::text AS in_id FROM lot_transfers;`);
  const pairs = new Map(saved.map((row) => [row.in_id, row.out_id]));
  const pairedOuts = new Set(saved.map((row) => row.out_id));
  const outs = flows.filter((flow) => flow.capital_flow_type === "ASSETOUT" && !pairedOuts.has(flow.id));
  const ins = flows.filter((flow) => flow.capital_flow_type === "ASSETIN" && !pairs.has(flow.id));

  const candidates = [];
  for (const incoming of ins)
    for (const outgoing of outs) {
      if (incoming.security_id !== outgoing.security_id || incoming.portfolio_id === outgoing.portfolio_id) continue;
      const days = (Date.parse(incoming.date) - Date.parse(outgoing.date)) / 86400000;
      const gap = Math.abs(incoming.quantity - outgoing.quantity) / outgoing.quantity;
      if (days >= 0 && days <= TRANSFER_DAYS && gap <= TRANSFER_QTY_TOLERANCE) candidates.push({ incoming, outgoing, score: days + gap * 100 });
    }
  candidates.sort((a, b) => a.score - b.score);
  const added = [];
  for (const { incoming, outgoing } of candidates) {
    if (pairs.has(incoming.id) || pairedOuts.has(outgoing.id)) continue;
    pairs.set(incoming.id, outgoing.id);
    pairedOuts.add(outgoing.id);
    added.push({ assetout_flow_id: outgoing.id, assetin_flow_id: incoming.id, source: "AUTO" });
  }
  if (added.length > 0) {
    await replaceDataInDb(added, "lot_transfers");
    console.log(`[TAXES] ${added.length} new transfer pair(s) saved to lot_transfers.`);
  }
  return pairs;
}

/**
 * Tax items per year (from FIRST_TAX_YEAR) and portfolio, in EUR, from the closed lots (ENGINE + MANUAL, one result
 * per sale_id), the income flows, the navs and the open lots (loadTaxInputs + taxItemsAsOf).
 *
 * @param {string} dateStr - ISO date
 * @param {Object} lots - computeLots result
 * @returns {Promise<{items: Array, unrealizedTax: number, inputs: Object}>}
 */
export async function computeTaxItems(dateStr, lots) {
  const inputs = await loadTaxInputs(dateStr, lots);
  return { ...taxItemsAsOf(inputs, dateStr, lots.openLots), inputs };
}

/** Everything the tax items read, loaded once (so they can be computed as of any day: REALIZED_TAX history). */
async function loadTaxInputs(dateStr, lots) {
  const { securities, portfolios } = lots;
  const { rows: closedLots } = await query(
    `SELECT sale_date::text AS sale_date, portfolio_id, security_id, sale_id, realized_pnl_base::float, taxable_gain_eur::float, tax_rate::float
     FROM closed_lots WHERE sale_date <= $1 ORDER BY sale_date;`,
    [dateStr],
  );
  const { rows: income } = await query(
    `SELECT date::text AS date, portfolio_id, capital_flow_type, market_value_eur::float AS eur FROM capital_flows
     WHERE capital_flow_type = ANY($1) AND date <= $2;`,
    [[...CLASSIC_INCOME, ...CRYPTO_INCOME], dateStr],
  );
  const { rows: withheld } = await query(
    `SELECT date::text AS date, portfolio_id, market_value_eur::float AS eur FROM capital_flows WHERE capital_flow_type = 'CAPITAL_GAIN_TAX' AND date <= $1;`,
    [dateStr],
  );
  // IVAFE portfolios: daily navs (EUR) and the days money moved in / out (flow blocks)
  const ivafeIds = [...portfolios.values()].filter((portfolio) => portfolio.ivafe_taxable).map((portfolio) => portfolio.portfolio_id);
  const { rows: navRows } = await query(
    `SELECT portfolio_id, date::text AS date, nav_eur::float FROM nav WHERE portfolio_id = ANY($1) AND date <= $2 ORDER BY portfolio_id, date;`,
    [ivafeIds, dateStr],
  );
  const navs = new Map(ivafeIds.map((id) => [id, []]));
  for (const row of navRows) navs.get(row.portfolio_id).push([row.date, row.nav_eur]);
  const { rows: flowRows } = await query(
    `SELECT portfolio_id, date::text AS date, sum(CASE WHEN capital_flow_type IN ('CASHIN', 'ASSETIN') THEN market_value_eur ELSE -market_value_eur END)::float AS net_eur
     FROM capital_flows WHERE portfolio_id = ANY($1) AND date <= $2 AND capital_flow_type IN ('CASHIN', 'CASHOUT', 'ASSETIN', 'ASSETOUT') GROUP BY 1, 2;`,
    [ivafeIds, dateStr],
  );
  const flows = new Map(ivafeIds.map((id) => [id, new Map()]));
  for (const row of flowRows) flows.get(row.portfolio_id).set(row.date, row.net_eur);
  return { securities, portfolios, sales: closedLots, income, withheld, navs, flows };
}

/** Latest [date, value] value on or before a date in an ascending series (binary search), null before the first. */
function valueOn(series, date) {
  let [low, high, found] = [0, series.length - 1, null];
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (series[mid][0] <= date) {
      found = series[mid][1];
      low = mid + 1;
    } else high = mid - 1;
  }
  return found;
}

/**
 * The tax items as known on asOf (sales, income and navs up to it; the current year is partial):
 * - REDDITI_DA_CAPITALE: ETF / FUND gains + classic income (Traditional Investment)
 * - REDDITI_DIVERSI: ETF / FUND losses + every other non-crypto result (no income: GAS added it, but income is
 *   reddito di capitale, art. 44 TUIR)
 * - REDDITI_CRIPTO_ATTIVITA: crypto gains + crypto income (Cryptocurrency Investment). Crypto losses offset nothing
 *   (user), so each sale counts only when positive
 * - REALIZED_PNL_BASE (every year, portfolio currency), UNREALIZED_PNL + UNREALIZED_TAX_EST (open lots, asOf only)
 * - TAX_EST: tax_rate of the sales, crypto 26% / 33% from 2026; REDDITI_DIVERSI net of the losses of the same year and
 *   the last 4 (per portfolio for AMMINISTRATO, pooled per regime otherwise) -> MINUS_CARRIED;
 *   CAPITAL_GAIN_TAX_WITHHELD (what the broker withheld) next to it
 * - IVAFE_TAXABLE portfolios, per flow block (user: the commercialista's RW periods, split at every CASHIN / CASHOUT /
 *   ASSETIN / ASSETOUT): START_NAV (with the flow that opens the block), MAX_NAV, END_NAV (without the flow that closes
 *   it), DAYS_HELD; IVAFE_EST per year = Σ blocks 0.2% x END_NAV x days / 365 (34.20 a year for cash accounts)
 * Every item has start_date / end_date: the year (Jan 1 - Dec 31), or the block.
 *
 * @param {Object} inputs - loadTaxInputs
 * @param {string} asOf - ISO date
 * @param {Array} [openLots=[]] - open lots valued on asOf (for the UNREALIZED_* items)
 * @returns {{items: Array, unrealizedTax: number}}
 */
function taxItemsAsOf(inputs, asOf, openLots = []) {
  const { securities, portfolios } = inputs;
  const items = [];
  const add = (year, portfolioId, item, value, start = `${year}-01-01`, end = `${year}-12-31`) => {
    if (value && Math.abs(value) > 0.005) items.push({ tax_year: year, portfolio_id: portfolioId, item, start_date: start, end_date: end, value_eur: Number(value.toFixed(2)) });
  };
  const assetType = (securityId) => securities.get(securityId)?.asset_type;

  // One result per sale
  const sales = new Map();
  for (const lot of inputs.sales) {
    if (lot.sale_date > asOf) break;
    const key = `${lot.portfolio_id}|${lot.sale_id}`;
    const sale = sales.get(key) ?? sales.set(key, { ...lot, realized_pnl_base: 0, taxable_gain_eur: 0, tax: 0 }).get(key);
    sale.realized_pnl_base += lot.realized_pnl_base ?? 0;
    if (lot.taxable_gain_eur === null || sale.taxable_gain_eur === null) sale.taxable_gain_eur = null;
    else {
      sale.taxable_gain_eur += lot.taxable_gain_eur;
      sale.tax += (lot.taxable_gain_eur * (lot.tax_rate ?? 26)) / 100;
    }
  }

  const buckets = new Map();
  const bucket = (year, portfolioId) => {
    const key = `${year}|${portfolioId}`;
    return buckets.get(key) ?? buckets.set(key, { capitale: 0, diversi: 0, cripto: 0, realized: 0, taxCapitale: 0, taxDiversi: 0, taxCripto: 0 }).get(key);
  };
  for (const sale of sales.values()) {
    const row = bucket(Number(sale.sale_date.slice(0, 4)), sale.portfolio_id);
    row.realized += sale.realized_pnl_base;
    const gain = sale.taxable_gain_eur;
    if (gain === null) continue;
    if (assetType(sale.security_id) === "CRYPTO" || portfolios.get(sale.portfolio_id)?.portfolio_type === "Cryptocurrency Investment") {
      if (gain > 0) {
        row.cripto += gain;
        row.taxCripto += sale.tax;
      }
    } else if (["ETF", "FUND"].includes(assetType(sale.security_id)) && gain > 0) {
      row.capitale += gain;
      row.taxCapitale += sale.tax;
    } else {
      row.diversi += gain;
      row.taxDiversi += sale.tax;
    }
  }

  for (const flow of inputs.income) {
    if (flow.date > asOf) continue;
    const year = Number(flow.date.slice(0, 4));
    const type = portfolios.get(flow.portfolio_id)?.portfolio_type;
    if (CRYPTO_INCOME.includes(flow.capital_flow_type) && type === "Cryptocurrency Investment") {
      bucket(year, flow.portfolio_id).cripto += flow.eur;
      bucket(year, flow.portfolio_id).taxCripto += (flow.eur * cryptoRate(year)) / 100;
    }
    if (CLASSIC_INCOME.includes(flow.capital_flow_type) && type === "Traditional Investment") {
      bucket(year, flow.portfolio_id).capitale += flow.eur;
      bucket(year, flow.portfolio_id).taxCapitale += flow.eur * 0.26;
    }
  }
  const withheld = new Map();
  for (const flow of inputs.withheld) {
    if (flow.date > asOf) continue;
    const key = `${flow.date.slice(0, 4)}|${flow.portfolio_id}`;
    withheld.set(key, (withheld.get(key) ?? 0) + flow.eur);
  }

  const carried = new Map(); // loss pool -> [{ year, amount }]
  // Year by year, losses first, so a loss offsets the same year's gains of its pool whatever the portfolio name
  const order = [...buckets.keys()].sort((a, b) => a.slice(0, 4).localeCompare(b.slice(0, 4)) || buckets.get(a).diversi - buckets.get(b).diversi);
  for (const key of order) {
    const [yearText, portfolioId] = key.split("|");
    const year = Number(yearText);
    const row = buckets.get(key);
    const portfolio = portfolios.get(portfolioId);
    add(year, portfolioId, "REALIZED_PNL_BASE", row.realized);
    if (year < FIRST_TAX_YEAR || !portfolio?.fiscal_regime) continue;
    add(year, portfolioId, "REDDITI_DA_CAPITALE", row.capitale);
    add(year, portfolioId, "REDDITI_DIVERSI", row.diversi);
    add(year, portfolioId, "REDDITI_CRIPTO_ATTIVITA", row.cripto);

    // REDDITI_DIVERSI losses offset the pool's gains of the same year and the next 4; returns the taxable rest
    const pool = portfolio.fiscal_regime === "AMMINISTRATO" ? portfolioId : portfolio.fiscal_regime;
    const losses = (carried.get(pool) ?? []).filter((loss) => year - loss.year <= 4 && loss.amount > 0);
    let diversiTaxable = row.diversi;
    if (diversiTaxable > 0)
      for (const loss of losses) {
        const used = Math.min(loss.amount, diversiTaxable);
        loss.amount -= used;
        diversiTaxable -= used;
      }
    else if (diversiTaxable < 0) losses.push({ year, amount: -diversiTaxable });
    carried.set(pool, losses);
    const diversiRate = row.diversi ? row.taxDiversi / row.diversi : 0.26;
    add(year, portfolioId, "TAX_EST", row.taxCapitale + Math.max(diversiTaxable, 0) * diversiRate + row.taxCripto);
    add(year, portfolioId, "MINUS_CARRIED", losses.reduce((total, loss) => total + loss.amount, 0));
    add(year, portfolioId, "CAPITAL_GAIN_TAX_WITHHELD", withheld.get(key));
  }

  // IVAFE portfolios: flow blocks per year up to asOf
  for (const [portfolioId, series] of inputs.navs) {
    if (!series.length) continue;
    const portfolio = portfolios.get(portfolioId);
    const isCash = portfolio.portfolio_type === "Cash";
    const flows = inputs.flows.get(portfolioId);
    const first = series[0][0] > `${FIRST_TAX_YEAR}-01-01` ? series[0][0] : `${FIRST_TAX_YEAR}-01-01`;
    const closed = portfolio.closed_date ? utils.formatDateToISO(portfolio.closed_date) : null;
    const last = [asOf, series.at(-1)[0], closed].filter(Boolean).sort()[0];
    for (let year = Number(first.slice(0, 4)); year <= Number(last.slice(0, 4)); year++) {
      const start = first > `${year}-01-01` ? first : `${year}-01-01`;
      const end = last < `${year}-12-31` ? last : `${year}-12-31`;
      if (start > end) continue;
      const splits = [...flows.keys()].filter((date) => date > start && date <= end).sort();
      const bounds = [start, ...splits];
      if (bounds.at(-1) < end) bounds.push(end);
      let ivafe = 0;
      for (let i = 0; i < Math.max(bounds.length - 1, 1); i++) {
        const [blockStart, blockEnd] = bounds.length > 1 ? [bounds[i], bounds[i + 1]] : [start, end];
        const startNav = valueOn(series, blockStart) ?? 0;
        const endNav = (valueOn(series, blockEnd) ?? 0) - (flows.has(blockEnd) && blockEnd !== start ? flows.get(blockEnd) : 0);
        let maxNav = Math.max(startNav, endNav);
        for (const [date, nav] of series) if (date > blockStart && date < blockEnd && nav > maxNav) maxNav = nav;
        const days = utils.daysBetween(blockStart, blockEnd).length - (i > 0 ? 1 : 0);
        add(year, portfolioId, "START_NAV", startNav, blockStart, blockEnd);
        add(year, portfolioId, "MAX_NAV", maxNav, blockStart, blockEnd);
        add(year, portfolioId, "END_NAV", endNav, blockStart, blockEnd);
        add(year, portfolioId, "DAYS_HELD", days, blockStart, blockEnd);
        ivafe += isCash ? (34.2 * days) / 365 : (0.002 * Math.max(endNav, 0) * days) / 365;
      }
      add(year, portfolioId, "IVAFE_EST", ivafe);
    }
  }

  // Unrealized on asOf, from the open lots (already valued in computeLots)
  const year = Number(asOf.slice(0, 4));
  const unrealized = new Map();
  for (const lot of openLots) {
    if (lot.unrealized_pnl_eur === null) continue;
    const row = unrealized.get(lot.portfolio_id) ?? unrealized.set(lot.portfolio_id, { pnl: 0, tax: 0 }).get(lot.portfolio_id);
    row.pnl += lot.unrealized_pnl_eur;
    row.tax += lot.est_tax_eur ?? 0;
  }
  let unrealizedTax = 0;
  for (const [portfolioId, row] of unrealized) {
    add(year, portfolioId, "UNREALIZED_PNL", row.pnl);
    add(year, portfolioId, "UNREALIZED_TAX_EST", row.tax);
    unrealizedTax += row.tax;
  }
  return { items, unrealizedTax };
}

/**
 * Tax owed on asOf and not paid yet (REALIZED_TAX, user 2026-10-30): for every tax year not settled by a tax_payments
 * row paid on or before asOf, the declared side as known on asOf: TAX_EST of the DICHIARATIVO / DICHIARATIVO_CRYPTO
 * portfolios + IVAFE_EST of the IVAFE portfolios (both go through the tax return; AMMINISTRATO is withheld at sale).
 */
function realizedTaxOwed(inputs, asOf, payments) {
  const settled = new Set(payments.filter((payment) => payment.paid_on <= asOf).map((payment) => payment.tax_year));
  let owed = 0;
  for (const item of taxItemsAsOf(inputs, asOf).items) {
    if (settled.has(item.tax_year)) continue;
    const portfolio = inputs.portfolios.get(item.portfolio_id);
    if ((item.item === "TAX_EST" && /^DICHIARATIVO/.test(portfolio?.fiscal_regime ?? "")) || (item.item === "IVAFE_EST" && portfolio?.ivafe_taxable)) owed += item.value_eur;
  }
  return owed;
}
