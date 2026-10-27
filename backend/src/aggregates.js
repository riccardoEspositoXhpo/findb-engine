import { utils } from "./utils.js";
import { query, replaceDataInDb } from "./db.js";
import { loadFxRates, currencyConverter } from "./marketData.js";

export const aggregates = {
  run,
  getStartDate,
};

/**
 * Daily aggregate NAVs: for every aggregate and every day from its start date (getStartDate) to dateStr, the sum of
 * its children (aggregate_tree, nested aggregates resolved recursively): each portfolio's latest nav on or before the
 * day (0 before inception / after closing) x the owner's share x fx into the aggregate currency.
 * Aggregates are the user's wealth: JOINT portfolios count at 50% (portfolios.owner as it is when the day is computed:
 * an ownership change applies from then on, the history already computed stays). Weekly / monthly portfolios carry
 * their latest nav forward, like GAS.
 * Migrated from runAggregateNav + reviseAggregateData in // aggregateData.gs
 *
 * @param {Date|string} [targetDate=new Date()] - Last day computed
 * @returns {Promise<{written: number, from: string|null}>}
 */
export async function run(targetDate = new Date()) {
  // Share of a portfolio that is the user's, by portfolios.owner
  const OWNER_SHARE = { XHPO: 1, JOINT: 0.5 };

  const dateStr = utils.formatDateToISO(targetDate);
  console.log(`[AGGREGATES] Starting aggregate NAVs up to ${dateStr}...`);
  await loadFxRates();

  const { rows: aggregateRows } = await query(`SELECT aggregate_id, currency FROM aggregates;`);
  const { rows: tree } = await query(`SELECT parent_id, child_id, child_type FROM aggregate_tree;`);
  const { rows: portfolioRows } = await query(`SELECT portfolio_id, currency, owner, inception_date, closed_date FROM portfolios;`);
  const portfolios = new Map(portfolioRows.map((row) => [row.portfolio_id, row]));
  const children = new Map();
  for (const link of tree) (children.get(link.parent_id) ?? children.set(link.parent_id, []).get(link.parent_id)).push(link);

  // Every aggregate starts where it has to; one window from the earliest, days before an aggregate's own start skipped
  const startByAggregate = new Map();
  for (const aggregate of aggregateRows) startByAggregate.set(aggregate.aggregate_id, await getStartDate(aggregate.aggregate_id, dateStr));
  const from = [...startByAggregate.values()].sort()[0];
  if (!from || from > dateStr) {
    console.log(`[AGGREGATES] Nothing to compute.`);
    return { written: 0, from: null };
  }

  // Portfolio navs from (window start - the longest carry-forward we may need): load everything up to dateStr once
  const { rows: navRows } = await query(`SELECT portfolio_id, date::text AS date, nav::float AS nav FROM nav WHERE date <= $1 ORDER BY portfolio_id, date;`, [dateStr]);
  const navSeries = new Map();
  for (const row of navRows) (navSeries.get(row.portfolio_id) ?? navSeries.set(row.portfolio_id, []).get(row.portfolio_id)).push([row.date, row.nav]);
  const latestNav = (portfolioId, date) => {
    const series = navSeries.get(portfolioId) ?? [];
    let low = 0;
    let high = series.length - 1;
    let found = null;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (series[mid][0] <= date) { found = series[mid][1]; low = mid + 1; } else high = mid - 1;
    }
    return found;
  };

  const rows = [];
  for (const date of utils.daysBetween(from, dateStr)) {
    const memo = new Map();
    // Value of a node in the given currency on `date`; null when nothing under it is active that day
    const value = (id, type, currency, path = []) => {
      if (type === "PORTFOLIO") {
        const portfolio = portfolios.get(id);
        const inception = utils.formatDateToISO(portfolio.inception_date);
        const closed = portfolio.closed_date ? utils.formatDateToISO(portfolio.closed_date) : null;
        if (date < inception || (closed && date > closed)) return null;
        const nav = latestNav(id, date);
        if (nav === null) return null;
        const share = OWNER_SHARE[portfolio.owner];
        if (share === undefined) throw new Error(`portfolio ${id}: owner "${portfolio.owner}" has no share in OWNER_SHARE`);
        return nav * share * currencyConverter(portfolio.currency, currency, date);
      }
      if (path.includes(id)) throw new Error(`aggregate_tree cycle: ${[...path, id].join(" -> ")}`);
      const key = `${id}|${currency}`;
      if (memo.has(key)) return memo.get(key);
      let total = null;
      for (const link of children.get(id) ?? []) {
        const childCurrency = link.child_type === "PORTFOLIO" ? currency : aggregateRows.find((a) => a.aggregate_id === link.child_id).currency;
        const child = value(link.child_id, link.child_type, childCurrency, [...path, id]);
        if (child !== null) total = (total ?? 0) + child * currencyConverter(childCurrency, currency, date);
      }
      memo.set(key, total);
      return total;
    };

    for (const aggregate of aggregateRows) {
      if (date < startByAggregate.get(aggregate.aggregate_id)) continue;
      const nav = value(aggregate.aggregate_id, "AGGREGATE", aggregate.currency);
      if (nav === null) continue;
      rows.push({ date, aggregate_id: aggregate.aggregate_id, nav, nav_eur: nav * currencyConverter(aggregate.currency, "EUR", date) });
    }
  }

  if (rows.length > 0) await replaceDataInDb(rows, "aggregate_nav");
  console.log(`[AGGREGATES] Done: ${rows.length} aggregate navs written from ${from} to ${dateStr}.`);
  return { written: rows.length, from };
}

/**
 * Where an aggregate has to restart, derived from the data like valuation.getRollStartDate: the day after its latest
 * nav, or earlier when, since its last run (max aggregate_nav.created_at), a nav of one of its portfolios (any depth)
 * or an fx rate of their currencies was written with a past date. No nav yet: the earliest constituent inception.
 *
 * @param {string} aggregateId
 * @param {string} dateStr - ISO date of the run
 * @returns {Promise<string>} ISO date
 */
export async function getStartDate(aggregateId, dateStr) {
  const constituents = `
    WITH RECURSIVE sub AS (
      SELECT child_id, child_type FROM aggregate_tree WHERE parent_id = $1
      UNION SELECT t.child_id, t.child_type FROM aggregate_tree t JOIN sub ON t.parent_id = sub.child_id AND sub.child_type = 'AGGREGATE'
    )
    SELECT p.portfolio_id, p.currency, p.inception_date FROM sub JOIN portfolios p ON p.portfolio_id = sub.child_id WHERE sub.child_type = 'PORTFOLIO'`;
  const { rows } = await query(`SELECT max(date)::text AS last_date FROM aggregate_nav WHERE aggregate_id = $1 AND date <= $2;`, [aggregateId, dateStr]);
  const lastDate = rows[0].last_date;
  if (!lastDate) {
    const { rows: first } = await query(`SELECT min(inception_date)::text AS d FROM (${constituents}) c;`, [aggregateId]);
    return first[0].d ?? dateStr;
  }

  // last_run stays in SQL (microsecond timestamps, see getRollStartDate)
  const { rows: changed } = await query(
    `
    WITH c AS (${constituents}),
    last AS (SELECT max(created_at) AS run FROM aggregate_nav WHERE aggregate_id = $1 AND date <= $2)
    SELECT least(
      (SELECT min(n.date) FROM nav n JOIN c USING (portfolio_id) WHERE n.created_at > (SELECT run FROM last) AND n.date <= $2),
      (SELECT min(f.date) FROM fx_rates f WHERE f.created_at > (SELECT run FROM last) AND f.date <= $2
         AND (f.base_currency IN (SELECT currency FROM c) OR f.quote_currency IN (SELECT currency FROM c)))
    )::text AS changed_from;`,
    [aggregateId, lastDate],
  );
  const startDate = [utils.addDays(lastDate, 1), changed[0].changed_from].filter(Boolean).sort()[0];
  return startDate > dateStr ? dateStr : startDate;
}
