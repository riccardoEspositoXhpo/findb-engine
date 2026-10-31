import { utils } from "#core/utils.js";
import { query } from "#core/db.js";
import { M3, M3_FONT as FONT, sendHtmlEmail } from "#notifications/qcEmail.js";

export const dailyStats = {
  run,
  calculateDailyStats,
  buildDailyStatsHtml,
};

const NET_WORTH_AGGREGATE = "LIQUID";

/**
 * "Daily FinDB" email, after the QC one: liquid net worth (the LIQUID aggregate nav) and its change from yesterday.
 * Migrated from runExtracts / calculateDailyStats in // productionCyle.gs
 *
 * @param {Date|string} [targetDate=new Date()]
 * @returns {Promise<Object>} the stats sent
 */
export async function run(targetDate = new Date()) {
  const stats = await calculateDailyStats(targetDate);
  if (!stats.netWorth) {
    console.warn(`[DAILY STATS] No ${NET_WORTH_AGGREGATE} nav on or before ${stats.date}, email skipped.`);
    return stats;
  }
  await sendHtmlEmail("findb-engine: daily net worth", buildDailyStatsHtml(stats));
  console.log(`[DAILY STATS] Daily net worth email dispatched.`);
  return stats;
}

/**
 * LIQUID nav on or before targetDate and on or before the day before (GAS getLatestNavForDate on TODAY / YESTERDAY),
 * the change in money and percent.
 *
 * @param {Date|string} [targetDate=new Date()]
 * @returns {Promise<{date: string, currency: string, netWorth: ?number, netWorthDate: ?string, previousWorth: ?number,
 *   previousDate: ?string, change: ?number, changePct: ?number}>}
 */
export async function calculateDailyStats(targetDate = new Date()) {
  const dateStr = utils.formatDateToISO(targetDate);
  const latestOn = async (day) =>
    (
      await query(
        `SELECT date::text AS date, nav::float FROM aggregate_nav WHERE aggregate_id = $1 AND date <= $2 ORDER BY date DESC LIMIT 1;`,
        [NET_WORTH_AGGREGATE, day],
      )
    ).rows[0] ?? null;
  const { rows } = await query(`SELECT currency FROM aggregates WHERE aggregate_id = $1;`, [NET_WORTH_AGGREGATE]);
  const today = await latestOn(dateStr);
  const yesterday = await latestOn(utils.addDays(dateStr, -1));
  const change = today && yesterday ? today.nav - yesterday.nav : null;
  return {
    date: dateStr,
    currency: rows[0]?.currency ?? "EUR",
    netWorth: today?.nav ?? null,
    netWorthDate: today?.date ?? null,
    previousWorth: yesterday?.nav ?? null,
    previousDate: yesterday?.date ?? null,
    change,
    changePct: change !== null && yesterday.nav ? (change / yesterday.nav) * 100 : null,
  };
}


// Euro symbol, no currency code (user): LIQUID is in EUR. The sign is added by signed()
const money = (value) =>
  `&euro;${Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signed = (text, value) => (value > 0 ? `+${text}` : value < 0 ? `&minus;${text}` : text);

/**
 * Material 3 email: a primary-container hero card (net worth + a change chip), two tonal stat cards (change DoD on
 * secondary, previous value on surface-container-high), a footer. Light scheme; the cards stack on phones.
 */
export function buildDailyStatsHtml(stats) {
  const up = stats.change > 0;
  const down = stats.change < 0;
  const chip = down
    ? { bg: M3.errorContainer, fg: M3.onErrorContainer, arrow: "&#9660;" }
    : { bg: M3.primary, fg: M3.onPrimary, arrow: up ? "&#9650;" : "&#9654;" };
  const change = stats.change === null ? "n/a" : signed(money(stats.change), stats.change);
  const changePct = stats.changePct === null ? "n/a" : signed(`${Math.abs(stats.changePct).toFixed(2)}%`, stats.changePct);
  const previous = stats.previousWorth === null ? "n/a" : money(stats.previousWorth);
  const statCard = (label, value, caption, valueColor, bg, fg, gap) => `
                  <td class="stack${gap ? " stack-gap" : ""}" width="50%" valign="top" style="padding: ${gap ? "0 6px 0 0" : "0 0 0 6px"};">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${bg}" style="background-color: ${bg}; border-radius: 16px;">
                      <tr><td style="padding: 16px 20px;">
                        <div style="font-size: 12px; line-height: 16px; font-weight: 500; letter-spacing: 0.5px; color: ${fg};">${label}</div>
                        <div style="font-size: 22px; line-height: 28px; font-weight: 500; color: ${valueColor}; margin-top: 6px; white-space: nowrap;">${value}</div>
                        <div style="font-size: 12px; line-height: 16px; letter-spacing: 0.4px; color: ${fg}; margin-top: 2px;">${caption}</div>
                      </td></tr>
                    </table>
                  </td>`;

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light">
  <meta name="supported-color-schemes" content="light">
  <title>Daily net worth - ${stats.date}</title>
  <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500&display=swap" rel="stylesheet">
  <style>
    body { margin: 0 !important; padding: 0 !important; background-color: ${M3.surface}; }
    @media only screen and (max-width: 600px) {
      .outer-pad { padding: 12px 8px !important; }
      .section { padding-left: 16px !important; padding-right: 16px !important; }
      .stack { display: block !important; width: 100% !important; padding: 0 !important; }
      .stack-gap { padding-bottom: 12px !important; }
      .hero { font-size: 32px !important; line-height: 40px !important; }
    }
  </style>
</head>
<body style="margin: 0; padding: 0; background-color: ${M3.surface};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${M3.surface}" style="background-color: ${M3.surface}; width: 100%;">
    <tr>
      <td class="outer-pad" align="center" style="padding: 24px 12px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${M3.surfaceContainerLow}" style="width: 100%; max-width: 600px; background-color: ${M3.surfaceContainerLow}; border-radius: 28px; font-family: ${FONT}; color: ${M3.onSurface};">

          <!-- TOP APP BAR -->
          <tr>
            <td class="section" style="padding: 24px 24px 8px 24px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td valign="middle" style="font-size: 22px; line-height: 28px; font-weight: 400; color: ${M3.onSurface};">Daily net worth</td>
                  <td valign="middle" align="right">
                    <span style="display: inline-block; padding: 6px 12px; border: 1px solid ${M3.outlineVariant}; border-radius: 8px; font-size: 12px; line-height: 16px; font-weight: 500; letter-spacing: 0.5px; color: ${M3.onSurfaceVariant}; white-space: nowrap;">${stats.netWorthDate}</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- HERO CARD -->
          <tr>
            <td class="section" style="padding: 16px 24px 12px 24px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${M3.primaryContainer}" style="background-color: ${M3.primaryContainer}; border-radius: 24px;">
                <tr><td style="padding: 24px;">
                  <div style="font-size: 14px; line-height: 20px; font-weight: 500; letter-spacing: 0.1px; color: ${M3.onPrimaryContainer};">Liquid net worth</div>
                  <div class="hero" style="font-size: 45px; line-height: 52px; font-weight: 400; color: ${M3.onPrimaryContainer}; margin-top: 8px;">${money(stats.netWorth)}</div>
                  <div style="margin-top: 16px;">
                    <span style="display: inline-block; padding: 6px 14px; border-radius: 8px; background-color: ${chip.bg}; color: ${chip.fg}; font-size: 14px; line-height: 20px; font-weight: 500; letter-spacing: 0.1px; white-space: nowrap;">${chip.arrow}&nbsp; ${changePct} today</span>
                  </div>
                </td></tr>
              </table>
            </td>
          </tr>

          <!-- STAT CARDS -->
          <tr>
            <td class="section" style="padding: 0 24px 24px 24px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  ${statCard("Change DoD", change, "vs previous valuation", down ? M3.error : M3.primary, M3.secondaryContainer, M3.onSecondaryContainer, true)}
                  ${statCard("Previous", previous, stats.previousDate ?? "", M3.onSurface, M3.surfaceContainerHigh, M3.onSurfaceVariant, false)}
                </tr>
              </table>
            </td>
          </tr>

          <!-- FOOTER -->
          <tr>
            <td class="section" style="padding: 16px 24px 24px 24px; border-top: 1px solid ${M3.outlineVariant}; font-size: 12px; line-height: 16px; letter-spacing: 0.4px; color: ${M3.outline}; text-align: center;">
              findb-engine &bull; daily batch &bull; ${NET_WORTH_AGGREGATE} aggregate
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
}
