import { utils } from "./utils.js";
import { query, withSavepoint } from "./db.js";
import { loadFxRates, currencyConverter } from "./marketData.js";

export const breakdowns = {
  run,
  runSecurityBreakdowns,
  runPortfolioBreakdowns,
  runAggregateBreakdowns,
};

// Breakdown dimensions (GAS 00-config/local.js); sectors are validated by breakdown_catalog (foreign key)
const SINGLE_SECURITY = {
  ASSET_TYPE: "asset_type",
  CURRENCY: "currency",
  ASSET_CLASS: "asset_class",
  REGION: "region",
  ASSET_CLASSIFICATION: "asset_classification",
  ITALY_EXPOSURE: "italy_exposure",
};
const LOOKTHROUGH = [
  "CURRENCY_LT",
  "ASSET_CLASS_LT",
  "REGION_LT",
  "ASSET_CLASSIFICATION_LT",
];
const SINGLE_PORTFOLIO = {
  PORTFOLIO_TYPE: "portfolio_type",
  LIQUIDATION_TIME_STANDARD: "liquidation_time_standard",
  LIQUIDATION_TIME_URGENT: "liquidation_time_urgent",
};
const SECURITY_DIMENSIONS = [...Object.keys(SINGLE_SECURITY), ...LOOKTHROUGH];
// Intervals: the first one of an entity starts in 1970, the current one is open until 2222-12-31
const GENESIS = "1970-01-01";
const OPEN_END = "2222-12-31";
// A sector below 1% of a portfolio / aggregate goes to "Other"; a navless portfolio counts for 100 days at most
const MIN_SECTOR_PCT = 1;
const NAV_MAX_AGE_DAYS = 100;
const EXCLUDED_ASSET_TYPES = ["ERROR"]; // GAS placeholder security

/**
 * Nightly breakdown step (after risk): security, portfolio and aggregate breakdowns, stored as intervals
 * (start_date -> end_date, the current one open until 2222-12-31): one row per sector, a new interval only when the
 * weights change. Portfolios and aggregates restart from the earliest nav written since their last run (a backdated
 * flow re-runs their breakdowns from that day), or options.from.
 * Migrated from calculateSecurityBreakdowns // securityData.gs, runPortfolioBreakdowns // portfolioData.gs,
 * runAggregateBreakdowns // aggregateData.gs, processBreakdowns // generalScripts.gs
 *
 * @param {Date|string} [targetDate=new Date()]
 * @param {Object} [options={}] - { from: ISO date (rebuild from there) }
 */
export async function run(targetDate = new Date(), options = {}) {
  const securities = await runSecurityBreakdowns(targetDate);
  const portfolios = await runPortfolioBreakdowns(targetDate, options);
  const aggregates = await runAggregateBreakdowns(targetDate, options);
  return { securities, portfolios, aggregates };
}

// ============================================================================
// INTERVAL WRITER (GAS processBreakdowns)
// ============================================================================

const sameSectors = (a, b) =>
  a &&
  b &&
  a.size === b.size &&
  [...a].every(
    ([sector, weight]) => Math.abs((b.get(sector) ?? NaN) - weight) <= 0.001,
  );

/**
 * Whole-percent weights summing to 100 (portfolio / aggregate: a 0.01% move would open a new interval every day,
 * user): rounded, the difference to 100 on "Other" (else the largest sector); zero sectors dropped.
 */
function roundToWholePercent(sectors) {
  const rounded = new Map(
    [...sectors].map(([sector, weight]) => [sector, Math.round(weight)]),
  );
  const total = [...rounded.values()].reduce((sum, weight) => sum + weight, 0);
  if (total !== 0 && total !== 100) {
    const target = rounded.has("Other")
      ? "Other"
      : [...rounded].reduce((max, entry) =>
          entry[1] > max[1] ? entry : max,
        )[0];
    rounded.set(target, rounded.get(target) + 100 - total);
  }
  for (const [sector, weight] of rounded)
    if (weight === 0) rounded.delete(sector);
  return rounded;
}

/**
 * Interval writer for one breakdown table: loads its rows once, plans each entity's new intervals in memory (plan),
 * writes everything in bulk (flush). For one entity, given its daily states on [from, lastDay] per dimension
 * (Map dimension -> [{ date, sectors: Map | null }], null = no breakdown that day: the interval closes):
 * - intervals ending on or before `from` stay; one straddling `from` is cut there (GAS left it running: a rerun from
 *   the middle of an interval overlapped the new rows)
 * - consecutive identical days merge; the last interval stays open (2222-12-31) when the last day has a state
 * - the first new interval extends the one ending on `from` when identical; an entity without earlier intervals starts
 *   in 1970 (GAS genesis)
 * Dimensions whose rows come out identical are not rewritten (created_at kept).
 */
async function intervalWriter(table, key) {
  const existing = new Map();
  for (const row of (
    await query(
      `SELECT ${key} AS id, breakdown, sector, start_date::text AS start_date, end_date::text AS end_date, weight::float FROM ${table};`,
    )
  ).rows)
    (
      existing.get(`${row.id}|${row.breakdown}`) ??
      existing
        .set(`${row.id}|${row.breakdown}`, [])
        .get(`${row.id}|${row.breakdown}`)
    ).push(row);
  const deletes = [];
  const inserts = [];
  const toBlocks = (rows) =>
    Object.values(
      Object.groupBy(rows, (row) => `${row.start_date}|${row.end_date}`),
    ).map((group) => ({
      start: group[0].start_date,
      end: group[0].end_date,
      sectors: new Map(group.map((row) => [row.sector, row.weight])),
    }));
  const signature = (blocks) =>
    blocks
      .flatMap((block) =>
        [...block.sectors].map(
          ([sector, weight]) =>
            `${block.start}|${block.end}|${sector}|${Number(weight).toFixed(4)}`,
        ),
      )
      .sort()
      .join(";");

  const plan = (id, statesByDimension, from) => {
    for (const [dimension, days] of statesByDimension) {
      const old = existing.get(`${id}|${dimension}`) ?? [];
      // Earlier intervals, the one straddling `from` cut there
      const blocks = toBlocks(old.filter((row) => row.start_date < from)).map(
        (block) => ({ ...block, end: block.end > from ? from : block.end }),
      );
      blocks.sort((a, b) => a.start.localeCompare(b.start));
      const hadHistory = blocks.length > 0;
      const fresh = [];
      for (const { date, sectors } of days) {
        if (!sectors || !sectors.size) continue;
        const last = fresh.at(-1);
        if (last && last.end === date && sameSectors(last.sectors, sectors))
          last.end = utils.addDays(date, 1);
        else fresh.push({ start: date, end: utils.addDays(date, 1), sectors });
      }
      const lastDay = days.at(-1)?.date;
      if (fresh.length && fresh.at(-1).end === utils.addDays(lastDay, 1))
        fresh.at(-1).end = OPEN_END;
      if (fresh.length) {
        const seam = blocks.find((block) => block.end === fresh[0].start);
        if (seam && sameSectors(seam.sectors, fresh[0].sectors)) {
          seam.end = fresh[0].end;
          fresh.shift();
        } else if (!hadHistory) fresh[0].start = GENESIS;
      }
      blocks.push(...fresh);
      const after = blocks.filter((block) => block.end >= from);
      if (
        signature(toBlocks(old.filter((row) => row.end_date >= from))) ===
        signature(after)
      )
        continue;
      deletes.push([id, dimension, from]);
      for (const block of after)
        for (const [sector, weight] of block.sectors)
          inserts.push([block.start, block.end, id, dimension, sector, weight]);
    }
  };

  const flush = async () => {
    await withSavepoint(async () => {
      for (let i = 0; i < deletes.length; i += 500) {
        const chunk = deletes.slice(i, i + 500);
        await query(
          `DELETE FROM ${table} t USING (VALUES ${chunk.map((_, j) => `($${j * 3 + 1}, $${j * 3 + 2}, $${j * 3 + 3}::date)`).join(", ")}) AS v(id, breakdown, from_date)
           WHERE t.${key} = v.id AND t.breakdown = v.breakdown AND t.end_date >= v.from_date;`,
          chunk.flat(),
        );
      }
      for (let i = 0; i < inserts.length; i += 1000) {
        const chunk = inserts.slice(i, i + 1000);
        await query(
          `INSERT INTO ${table} (start_date, end_date, ${key}, breakdown, sector, weight) VALUES ${chunk.map((_, j) => `($${j * 6 + 1}, $${j * 6 + 2}, $${j * 6 + 3}, $${j * 6 + 4}, $${j * 6 + 5}, $${j * 6 + 6})`).join(", ")};`,
          chunk.flat(),
        );
      }
    });
    return inserts.length;
  };
  return { plan, flush };
}

/** Latest [date, value] on or before a date in an ascending series (binary search), with its index. */
function latestIndex(series, date) {
  let [low, high, found] = [0, series.length - 1, -1];
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (series[mid][0] <= date) {
      found = mid;
      low = mid + 1;
    } else high = mid - 1;
  }
  return found;
}

/** Intervals of a breakdown table: Map "<id>|<dimension>" -> [{ start, end, sector, weight }]. */
async function loadIntervals(table, key) {
  const intervals = new Map();
  for (const row of (
    await query(
      `SELECT ${key} AS id, breakdown, sector, start_date::text AS start, end_date::text AS end, weight::float FROM ${table};`,
    )
  ).rows)
    (
      intervals.get(`${row.id}|${row.breakdown}`) ??
      intervals
        .set(`${row.id}|${row.breakdown}`, [])
        .get(`${row.id}|${row.breakdown}`)
    ).push(row);
  return intervals;
}
const activeOn = (intervals, date) =>
  (intervals ?? []).filter((row) => row.start <= date && date < row.end);

// ============================================================================
// SECURITIES
// ============================================================================

/**
 * Security breakdowns as of today: the security_master attributes (100% of one sector) and the lookthrough shapes
 * (_LT: lookthrough_data active today, else the attribute; the gap to 100 goes to "Other"). A change starts a new
 * interval today (history kept).
 *
 * @param {Date|string} [targetDate=new Date()]
 * @returns {Promise<{written: number}>}
 */
export async function runSecurityBreakdowns(targetDate = new Date()) {
  const dateStr = utils.formatDateToISO(targetDate);
  // Every currency is a CURRENCY / CURRENCY_LT sector (GAS pushed each cash currency into BREAKDOWN_DEFINITIONS): a
  // new one (a token created by securityResolver, a currency added by hand) would break the catalog foreign key
  await query(
    `INSERT INTO breakdown_catalog (breakdown, sector)
     SELECT d.breakdown, c.currency_code FROM currencies c CROSS JOIN (VALUES ('CURRENCY'), ('CURRENCY_LT')) AS d(breakdown)
     ON CONFLICT DO NOTHING;`,
  );
  const { rows: securities } = await query(
    `SELECT * FROM security_master WHERE asset_type <> ALL($1) ORDER BY security_id;`,
    [EXCLUDED_ASSET_TYPES],
  );
  const lookthrough = await loadIntervals("lookthrough_data", "security_id");
  const writer = await intervalWriter("security_breakdowns", "security_id");
  for (const security of securities) {
    const states = new Map();
    for (const [dimension, column] of Object.entries(SINGLE_SECURITY)) {
      const value =
        column === "italy_exposure"
          ? security[column]
            ? "Y"
            : "N"
          : security[column];
      if (value)
        states.set(dimension, [
          { date: dateStr, sectors: new Map([[value, 100]]) },
        ]);
    }
    for (const dimension of LOOKTHROUGH) {
      const rows = activeOn(
        lookthrough.get(`${security.security_id}|${dimension}`),
        dateStr,
      );
      const sectors = new Map();
      if (rows.length)
        for (const row of rows)
          sectors.set(row.sector, (sectors.get(row.sector) ?? 0) + row.weight);
      else {
        const value = security[SINGLE_SECURITY[dimension.replace(/_LT$/, "")]];
        if (!value) continue;
        sectors.set(value, 100);
      }
      const total = [...sectors.values()].reduce(
        (sum, weight) => sum + weight,
        0,
      );
      if (Math.abs(total - 100) > 1e-5 && Math.abs(total) > 1e-5)
        sectors.set("Other", (sectors.get("Other") ?? 0) + 100 - total);
      states.set(dimension, [{ date: dateStr, sectors }]);
    }
    writer.plan(security.security_id, states, dateStr);
  }
  const written = await writer.flush();
  console.log(`[BREAKDOWNS] Securities: ${written} rows written.`);
  return { written };
}

// ============================================================================
// PORTFOLIOS
// ============================================================================

/** Where an entity's breakdowns restart: today, or the earliest of its navs written since its last breakdown run. */
async function restartDate(table, key, id, navSql, navParams, dateStr) {
  const { rows } = await query(
    `WITH last AS (SELECT max(created_at) AS run FROM ${table} WHERE ${key} = $1)
     SELECT (SELECT run FROM last) IS NULL AS never, (${navSql})::text AS changed;`,
    [id, ...navParams],
  );
  if (rows[0].never) return null;
  return rows[0].changed && rows[0].changed < dateStr
    ? rows[0].changed
    : dateStr;
}

/**
 * Portfolio breakdowns: the portfolios attributes (as of today, like securities) and, every day from the restart, the
 * holdings' security breakdowns weighted by their value in the nav (the positions of the latest nav), sectors below
 * 1% in "Other", whole percents. A day without a nav (or a nav of 0) closes the interval.
 *
 * @param {Date|string} [targetDate=new Date()]
 * @param {Object} [options={}] - { from }
 * @returns {Promise<{written: number, portfolios: number}>}
 */
export async function runPortfolioBreakdowns(
  targetDate = new Date(),
  options = {},
) {
  const dateStr = utils.formatDateToISO(targetDate);
  const { rows: portfolios } = await query(
    `SELECT * FROM portfolios ORDER BY portfolio_id;`,
  );
  const securityIntervals = await loadIntervals(
    "security_breakdowns",
    "security_id",
  );
  const writer = await intervalWriter("portfolio_breakdowns", "portfolio_id");
  let recomputed = 0;
  for (const portfolio of portfolios) {
    const id = portfolio.portfolio_id;
    const inception = utils.formatDateToISO(portfolio.inception_date);
    const closed = portfolio.closed_date
      ? utils.formatDateToISO(portfolio.closed_date)
      : null;
    let from =
      options.from ??
      (await restartDate(
        "portfolio_breakdowns",
        "portfolio_id",
        id,
        `SELECT min(date) FROM nav WHERE portfolio_id = $1 AND created_at > (SELECT run FROM last) AND date <= $2`,
        [dateStr],
        dateStr,
      )) ??
      inception;
    if (from < inception) from = inception;
    if (from > dateStr) continue;

    // Attributes: as of today
    const singles = new Map();
    for (const [dimension, column] of Object.entries(SINGLE_PORTFOLIO))
      if (portfolio[column])
        singles.set(dimension, [
          { date: dateStr, sectors: new Map([[portfolio[column], 100]]) },
        ]);
    writer.plan(id, singles, dateStr);

    // Holdings, daily from the restart (from the nav before it, for its positions)
    const { rows: navRows } = await query(
      `SELECT date::text AS date, nav::float FROM nav WHERE portfolio_id = $1 AND date <= $2 ORDER BY date;`,
      [id, dateStr],
    );
    const navs = navRows.map((row) => [row.date, row.nav]);
    const firstNav = navs[Math.max(latestIndex(navs, from), 0)]?.[0] ?? from;
    const { rows: positionRows } = await query(
      `SELECT date::text AS date, security_id, market_value_base::float AS value FROM positions WHERE portfolio_id = $1 AND date >= $2 AND date <= $3;`,
      [id, firstNav, dateStr],
    );
    const positions = new Map();
    for (const row of positionRows)
      (
        positions.get(row.date) ?? positions.set(row.date, []).get(row.date)
      ).push(row);
    const states = new Map(
      SECURITY_DIMENSIONS.map((dimension) => [dimension, []]),
    );
    const lastDay =
      closed && utils.addDays(closed, 1) < dateStr
        ? utils.addDays(closed, 1)
        : dateStr;
    for (let day = from; day <= lastDay; day = utils.addDays(day, 1)) {
      const index = latestIndex(navs, day);
      const active = day >= inception && (!closed || day <= closed);
      const [navDate, nav] = index >= 0 ? navs[index] : [null, 0];
      for (const dimension of SECURITY_DIMENSIONS) {
        if (!active || !nav) {
          states.get(dimension).push({ date: day, sectors: null });
          continue;
        }
        const sums = new Map();
        for (const position of positions.get(navDate) ?? [])
          for (const row of activeOn(
            securityIntervals.get(`${position.security_id}|${dimension}`),
            day,
          ))
            sums.set(
              row.sector,
              (sums.get(row.sector) ?? 0) + (row.weight * position.value) / nav,
            );
        states.get(dimension).push({
          date: day,
          sectors: sums.size
            ? roundToWholePercent(foldSmall(sums, false))
            : null,
        });
      }
    }
    writer.plan(id, states, from);
    recomputed++;
  }
  const written = await writer.flush();
  console.log(
    `[BREAKDOWNS] Portfolios: ${written} rows written for ${recomputed} portfolios.`,
  );
  return { written, portfolios: recomputed };
}

/**
 * Sectors below MIN_SECTOR_PCT into "Other" (aggregates compare |weight|: liabilities are negative), the gap to 100 on
 * "Other" too.
 */
function foldSmall(sums, absolute) {
  const result = new Map([["Other", 0]]);
  for (const [sector, weight] of sums) {
    if (
      sector !== "Other" &&
      (absolute ? Math.abs(weight) : weight) >= MIN_SECTOR_PCT
    )
      result.set(sector, weight);
    else result.set("Other", result.get("Other") + weight);
  }
  const total = [...result.values()].reduce((sum, weight) => sum + weight, 0);
  if (Math.abs(total - 100) > 1e-5 && Math.abs(total) > 1e-5)
    result.set("Other", result.get("Other") + 100 - total);
  return result;
}

// ============================================================================
// AGGREGATES
// ============================================================================

/**
 * Aggregate breakdowns, daily from the restart, for the aggregates with a breakdown_scope (LT_ONLY: the lookthrough
 * dimensions; ALL: every security and portfolio dimension): its portfolios' breakdowns weighted by their nav (latest,
 * at most 100 days old) x the user's share (ownership_overrides; GAS ignored it) in the aggregate's currency over the
 * aggregate's nav (net of liabilities), sectors below |1%| in "Other", whole percents.
 *
 * @param {Date|string} [targetDate=new Date()]
 * @param {Object} [options={}] - { from }
 * @returns {Promise<{written: number, aggregates: number}>}
 */
export async function runAggregateBreakdowns(
  targetDate = new Date(),
  options = {},
) {
  const dateStr = utils.formatDateToISO(targetDate);
  await loadFxRates();
  const { rows: aggregates } = await query(
    `SELECT aggregate_id, currency, breakdown_scope FROM aggregates WHERE breakdown_scope <> 'NONE' ORDER BY 1;`,
  );
  const { rows: tree } = await query(
    `SELECT parent_id, child_id, child_type FROM aggregate_tree;`,
  );
  const portfolios = new Map(
    (await query(`SELECT portfolio_id, currency FROM portfolios;`)).rows.map(
      (row) => [row.portfolio_id, row],
    ),
  );
  const { rows: overrides } = await query(
    `SELECT portfolio_id, start_date::text AS start_date, my_share::float AS my_share FROM ownership_overrides ORDER BY portfolio_id, start_date;`,
  );
  const myShare = (id, date) =>
    (overrides
      .filter((row) => row.portfolio_id === id && row.start_date <= date)
      .at(-1)?.my_share ?? 100) / 100;
  const leaves = (id, found = new Set()) => {
    for (const link of tree.filter((row) => row.parent_id === id))
      if (link.child_type === "PORTFOLIO") found.add(link.child_id);
      else leaves(link.child_id, found);
    return found;
  };
  const navs = new Map();
  for (const row of (
    await query(
      `SELECT portfolio_id, date::text AS date, nav::float FROM nav WHERE date <= $1 ORDER BY date;`,
      [dateStr],
    )
  ).rows)
    (
      navs.get(row.portfolio_id) ??
      navs.set(row.portfolio_id, []).get(row.portfolio_id)
    ).push([row.date, row.nav]);
  const portfolioIntervals = await loadIntervals(
    "portfolio_breakdowns",
    "portfolio_id",
  );
  const navOn = (series, day) => {
    const index = latestIndex(series ?? [], day);
    if (index < 0) return 0;
    const [date, nav] = series[index];
    return (Date.parse(day) - Date.parse(date)) / 86400000 <= NAV_MAX_AGE_DAYS
      ? nav
      : 0;
  };

  const writer = await intervalWriter("aggregate_breakdowns", "aggregate_id");
  let recomputed = 0;
  for (const aggregate of aggregates) {
    const id = aggregate.aggregate_id;
    const members = [...leaves(id)];
    const dimensions =
      aggregate.breakdown_scope === "LT_ONLY"
        ? LOOKTHROUGH
        : [...SECURITY_DIMENSIONS, ...Object.keys(SINGLE_PORTFOLIO)];
    const { rows: aggregateNavRows } = await query(
      `SELECT date::text AS date, nav::float FROM aggregate_nav WHERE aggregate_id = $1 AND date <= $2 ORDER BY date;`,
      [id, dateStr],
    );
    const aggregateNavs = aggregateNavRows.map((row) => [row.date, row.nav]);
    if (!aggregateNavs.length) continue;
    let from =
      options.from ??
      (await restartDate(
        "aggregate_breakdowns",
        "aggregate_id",
        id,
        `SELECT least((SELECT min(date) FROM aggregate_nav WHERE aggregate_id = $1 AND created_at > (SELECT run FROM last) AND date <= $2),
                      (SELECT min(start_date) FROM portfolio_breakdowns WHERE portfolio_id = ANY($3) AND created_at > (SELECT run FROM last) AND start_date <= $2))`,
        [dateStr, members],
        dateStr,
      )) ??
      aggregateNavs[0][0];
    if (from < aggregateNavs[0][0]) from = aggregateNavs[0][0];
    if (from > dateStr) continue;

    const states = new Map(dimensions.map((dimension) => [dimension, []]));
    for (let day = from; day <= dateStr; day = utils.addDays(day, 1)) {
      const aggregateNav = navOn(aggregateNavs, day);
      const weights = new Map();
      if (aggregateNav)
        for (const member of members) {
          const nav = navOn(navs.get(member), day);
          if (nav)
            weights.set(
              member,
              (nav *
                myShare(member, day) *
                (currencyConverter(
                  portfolios.get(member).currency,
                  aggregate.currency,
                  day,
                ) ?? 0)) /
                aggregateNav,
            );
        }
      for (const dimension of dimensions) {
        if (!weights.size) {
          states.get(dimension).push({ date: day, sectors: null });
          continue;
        }
        const sums = new Map();
        for (const [member, weight] of weights)
          for (const row of activeOn(
            portfolioIntervals.get(`${member}|${dimension}`),
            day,
          ))
            sums.set(
              row.sector,
              (sums.get(row.sector) ?? 0) + row.weight * weight,
            );
        states.get(dimension).push({
          date: day,
          sectors: sums.size
            ? roundToWholePercent(foldSmall(sums, true))
            : null,
        });
      }
    }
    writer.plan(id, states, from);
    recomputed++;
  }
  const written = await writer.flush();
  console.log(
    `[BREAKDOWNS] Aggregates: ${written} rows written for ${recomputed} aggregates.`,
  );
  return { written, aggregates: recomputed };
}
