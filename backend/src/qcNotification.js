import nodemailer from "nodemailer";
import { config } from "../config.js";

// Material Design 3 baseline light scheme (seed #6750A4, the purple of the M3 guidelines; user), shared by every email.
// M3 has no success / warning roles: they are custom colors with the 4 Theme Builder roles (tones 40 / 100 / 90 / 10,
// @material/material-color-utilities). Picked by the user (2026-10-31): muted to the softness of the purple
// containers (light shades at chroma 16-20; saturated greens at chroma ~50 popped out too much): success = sage
// (hue 150), warning = amber (hue 85), error = muted red (hue 25), the solid tones at chroma 36-48.
export const M3 = {
  primary: "#6750A4",
  onPrimary: "#FFFFFF",
  primaryContainer: "#EADDFF",
  onPrimaryContainer: "#21005D",
  secondaryContainer: "#E8DEF8",
  onSecondaryContainer: "#1D192B",
  surface: "#FEF7FF",
  surfaceContainerLowest: "#FFFFFF",
  surfaceContainerLow: "#F7F2FA",
  surfaceContainer: "#F3EDF7",
  surfaceContainerHigh: "#ECE6F0",
  onSurface: "#1D1B20",
  onSurfaceVariant: "#49454F",
  outline: "#79747E",
  outlineVariant: "#CAC4D0",
  error: "#9C4239",
  onError: "#FFFFFF",
  errorContainer: "#FFDAD6",
  onErrorContainer: "#2E1411",
  success: "#36693E",
  onSuccess: "#FFFFFF",
  successContainer: "#D4E8D1",
  onSuccessContainer: "#0F1F11",
  warning: "#78590C",
  onWarning: "#FFFFFF",
  warningContainer: "#F9DFB0",
  onWarningContainer: "#261900",
};
export const M3_FONT = "Roboto, 'Google Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

// Status colors: FAIL = error, WARN = warning, PASS = success (container + on-container: M3 tonal chips)
const STATUS = {
  FAIL: { bg: M3.errorContainer, fg: M3.onErrorContainer, accent: M3.error },
  WARN: { bg: M3.warningContainer, fg: M3.onWarningContainer, accent: M3.warning },
  PASS: { bg: M3.successContainer, fg: M3.onSuccessContainer, accent: M3.success },
};
const statusOf = (c) => (c.passed ? "PASS" : c.severity === "CRITICAL" ? "FAIL" : "WARN");
const chip = (text, { bg, fg }) =>
  `<span style="display: inline-block; padding: 4px 10px; border-radius: 8px; background-color: ${bg}; color: ${fg}; font-size: 12px; line-height: 16px; font-weight: 500; letter-spacing: 0.5px; white-space: nowrap;">${text}</span>`;

export function buildQcEmailHtml(qcResults, targetDate = new Date()) {
  const dateStr =
    targetDate instanceof Date
      ? targetDate.toISOString().split("T")[0]
      : targetDate;
  const checks = Array.isArray(qcResults?.results) ? qcResults.results : [];

  const passedCount = checks.filter((c) => c.passed).length;
  const failedChecks = checks.filter((c) => !c.passed);
  const criticalFailures = failedChecks.filter((c) => c.severity === "CRITICAL");
  const warningFailures = failedChecks.filter((c) => c.severity !== "CRITICAL");
  const criticalCount = criticalFailures.length;
  const warningCount = warningFailures.length;

  // Warnings (probabilistic checks: price / fx / nav jumps) don't fail the night: only a critical does (user)
  const overall =
    criticalCount > 0
      ? { label: "CRITICAL ALERT", bg: M3.error, fg: M3.onError }
      : warningCount > 0
        ? { label: `PASS &middot; ${warningCount} warning${warningCount > 1 ? "s" : ""}`, bg: M3.warningContainer, fg: M3.onWarningContainer }
        : { label: "PASS", bg: M3.successContainer, fg: M3.onSuccessContainer };

  // Email-client rules: Gmail drops <body> styles, so the background lives on a full-width outer table (bgcolor +
  // style); the card is a fluid table capped at 640px. Phones: viewport meta + @media rules (Gmail / Apple Mail) stack
  // the header and the KPI cards, hide secondary columns and let wide data tables scroll.
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light">
  <meta name="supported-color-schemes" content="light">
  <title>FinDB Overnight QC Report - ${dateStr}</title>
  <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500&display=swap" rel="stylesheet">
  <style>
    body { margin: 0 !important; padding: 0 !important; background-color: ${M3.surface}; }
    @media only screen and (max-width: 600px) {
      .outer-pad { padding: 12px 8px !important; }
      .section { padding-left: 16px !important; padding-right: 16px !important; }
      .stack { display: block !important; width: 100% !important; text-align: left !important; padding: 0 !important; }
      .stack-gap { padding-top: 12px !important; }
      .kpi-value { font-size: 22px !important; line-height: 28px !important; }
      .hide-mobile { display: none !important; }
      .show-mobile { display: block !important; max-height: none !important; overflow: visible !important; }
    }
  </style>
</head>
<body style="margin: 0; padding: 0; background-color: ${M3.surface};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${M3.surface}" style="background-color: ${M3.surface}; width: 100%;">
    <tr>
      <td class="outer-pad" align="center" style="padding: 24px 12px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${M3.surfaceContainerLow}" style="width: 100%; max-width: 640px; table-layout: fixed; background-color: ${M3.surfaceContainerLow}; border-radius: 28px; font-family: ${M3_FONT}; color: ${M3.onSurface};">

          <!-- TOP APP BAR -->
          <tr>
            <td class="section" style="padding: 24px 24px 8px 24px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td class="stack" valign="middle">
                    <div style="font-size: 22px; line-height: 28px; font-weight: 400; color: ${M3.onSurface};">Overnight QC</div>
                    <div style="font-size: 14px; line-height: 20px; letter-spacing: 0.25px; color: ${M3.onSurfaceVariant}; margin-top: 2px;">Valuation date ${dateStr}</div>
                  </td>
                  <td class="stack stack-gap" valign="middle" align="right" style="text-align: right;">
                    <span style="display: inline-block; padding: 8px 16px; border-radius: 8px; background-color: ${overall.bg}; color: ${overall.fg}; font-size: 14px; line-height: 20px; font-weight: 500; letter-spacing: 0.1px; white-space: nowrap;">${overall.label}</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- KPI CARDS -->
          <tr>
            <td class="section" style="padding: 16px 24px 8px 24px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  ${renderKpi("Passed", `${passedCount}/${checks.length}`, STATUS.PASS, "right")}
                  ${renderKpi("Critical", criticalCount, criticalCount > 0 ? STATUS.FAIL : null, "both")}
                  ${renderKpi("Warnings", warningCount, warningCount > 0 ? STATUS.WARN : null, "left")}
                </tr>
              </table>
            </td>
          </tr>

          <!-- CHECKS: only the ones that failed or warned (the KPI cards count them all) -->
          <tr>
            <td class="section" style="padding: 16px 24px;">
              <div style="margin: 0 0 12px 4px; font-size: 14px; line-height: 20px; font-weight: 500; letter-spacing: 0.1px; color: ${M3.primary};">Checks</div>
              ${
                failedChecks.length === 0
                  ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${M3.successContainer}" style="background-color: ${M3.successContainer}; border-radius: 16px;"><tr><td style="padding: 16px 20px; font-size: 14px; line-height: 20px; color: ${M3.onSuccessContainer};">All ${checks.length} checks passed.</td></tr></table>`
                  : `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${M3.surfaceContainerLowest}" style="background-color: ${M3.surfaceContainerLowest}; border-radius: 16px; border-collapse: separate; font-size: 14px;">
                ${failedChecks.map((c, idx) => renderSummaryRow(c, idx === failedChecks.length - 1)).join("")}
              </table>
              <div style="margin: 10px 0 0 4px; font-size: 12px; line-height: 16px; letter-spacing: 0.4px; color: ${M3.onSurfaceVariant};">${passedCount} other check(s) passed.</div>`
              }
            </td>
          </tr>

          ${
            criticalFailures.length > 0 || warningFailures.length > 0
              ? `
          <!-- DETAILS -->
          <tr>
            <td class="section" style="padding: 8px 24px 16px 24px;">
              <div style="margin: 0 0 12px 4px; font-size: 14px; line-height: 20px; font-weight: 500; letter-spacing: 0.1px; color: ${M3.primary};">Details</div>
              ${criticalFailures.map((c) => renderDetailCard(c, STATUS.FAIL, "FAIL")).join("")}
              ${warningFailures.map((c) => renderDetailCard(c, STATUS.WARN, "WARN")).join("")}
            </td>
          </tr>`
              : ""
          }

          <!-- FOOTER -->
          <tr>
            <td class="section" style="padding: 16px 24px 24px 24px; border-top: 1px solid ${M3.outlineVariant}; font-size: 12px; line-height: 16px; letter-spacing: 0.4px; color: ${M3.outline}; text-align: center;">
              findb-engine &bull; daily batch &bull; Postgres
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

/** One KPI card (label above, big value below): tonal status container, or neutral when the count is 0. */
function renderKpi(label, value, status, gap) {
  const bg = status ? status.bg : M3.surfaceContainerHigh;
  const fg = status ? status.fg : M3.onSurfaceVariant;
  const padding = { right: "0 4px 0 0", both: "0 4px", left: "0 0 0 4px" }[gap];
  return `
                  <td width="33%" valign="top" style="padding: ${padding};">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${bg}" style="background-color: ${bg}; border-radius: 16px;">
                      <tr><td style="padding: 14px 16px;">
                        <div style="font-size: 12px; line-height: 16px; font-weight: 500; letter-spacing: 0.5px; color: ${fg};">${label}</div>
                        <div class="kpi-value" style="font-size: 28px; line-height: 36px; font-weight: 400; color: ${fg}; margin-top: 4px;">${value}</div>
                      </td></tr>
                    </table>
                  </td>`;
}

function renderSummaryRow(c, last) {
  const status = statusOf(c);
  const type = c.failureType || "DETERMINISTIC";
  const severity = c.severity || "WARNING";
  const meta = `${type.charAt(0)}${type.slice(1).toLowerCase()} &middot; ${severity.charAt(0)}${severity.slice(1).toLowerCase()}`;
  const cell = `padding: 14px 16px;${last ? "" : ` border-bottom: 1px solid ${M3.outlineVariant};`}`;
  return `
                <tr>
                  <td valign="top" style="${cell}">
                    <div style="font-size: 14px; line-height: 20px; font-weight: 500; letter-spacing: 0.1px; color: ${M3.onSurface};">${c.check}</div>
                    ${c.summary ? `<div style="font-size: 14px; line-height: 20px; letter-spacing: 0.25px; color: ${M3.onSurfaceVariant}; margin-top: 2px;">${c.summary}</div>` : ""}
                    <div style="font-size: 12px; line-height: 16px; letter-spacing: 0.4px; color: ${M3.outline}; margin-top: 4px;">${meta}</div>
                  </td>
                  <td valign="top" align="right" style="${cell} text-align: right;">${chip(status, STATUS[status])}</td>
                </tr>
  `;
}

function renderDetailCard(c, status, label) {
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${M3.surfaceContainerLowest}" style="margin-bottom: 12px; table-layout: fixed; background-color: ${M3.surfaceContainerLowest}; border-radius: 16px;">
      <tr><td style="padding: 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom: 8px;">
          <tr>
            <td valign="middle">
              ${chip(label, status)}
              <span style="margin-left: 8px; font-size: 16px; line-height: 24px; font-weight: 500; letter-spacing: 0.15px; color: ${M3.onSurface};">${c.check}</span>
            </td>
            <td class="hide-mobile" align="right" valign="middle" style="font-size: 12px; line-height: 16px; letter-spacing: 0.4px; color: ${M3.onSurfaceVariant}; white-space: nowrap;">
              ${c.failureType || "DETERMINISTIC"}
            </td>
          </tr>
        </table>
        ${c.message ? `<div style="font-size: 14px; line-height: 20px; letter-spacing: 0.25px; color: ${M3.onSurfaceVariant}; margin-bottom: 12px;">${c.message}</div>` : ""}
        ${renderDynamicData(c.data)}
      </td></tr>
    </table>
  `;
}

/**
 * Dynamically synthesizes an HTML table capped at 10 rows to prevent Gmail clipping.
 */
function renderDynamicData(data) {
  if (!data) return "";

  if (Array.isArray(data) && data.length > 0 && typeof data[0] === "object") {
    const columns = Object.keys(data[0]);
    const maxRows = 10;
    const isTruncated = data.length > maxRows;
    const displayRows = isTruncated ? data.slice(0, maxRows) : data;

    // Wide data tables scroll sideways on phones instead of shrinking the whole email
    return `
      <div style="width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; margin-top: 8px; border: 1px solid ${M3.outlineVariant}; border-radius: 12px;">
      <table cellpadding="6" cellspacing="0" style="border-collapse: collapse; font-size: 12px; min-width: 100%;">
        <thead>
          <tr style="background-color: ${M3.surfaceContainer}; text-align: left; color: ${M3.onSurfaceVariant};">
            ${columns.map((col) => `<th style="padding: 8px 12px; font-weight: 500; letter-spacing: 0.5px; white-space: nowrap; text-align: left;">${col}</th>`).join("")}
          </tr>
        </thead>
        <tbody>
          ${displayRows
            .map(
              (row) => `
            <tr style="border-top: 1px solid ${M3.outlineVariant}; color: ${M3.onSurface};">
              ${columns.map((col) => `<td style="padding: 8px 12px; font-family: 'Roboto Mono', monospace; white-space: nowrap;">${row[col] !== null && row[col] !== undefined ? row[col] : ""}</td>`).join("")}
            </tr>
          `,
            )
            .join("")}
          ${
            isTruncated
              ? `
            <tr style="border-top: 1px solid ${M3.outlineVariant}; color: ${M3.onSurfaceVariant};">
              <td colspan="${columns.length}" style="padding: 8px 12px; text-align: center;">
                ... and ${data.length - maxRows} more rows truncated for email readability.
              </td>
            </tr>
          `
              : ""
          }
        </tbody>
      </table>
      </div>
    `;
  }

  if (typeof data === "object" && Object.keys(data).length > 0) {
    return `<pre style="background-color: ${M3.surfaceContainer}; padding: 12px; border-radius: 12px; font-size: 12px; color: ${M3.onSurface}; margin: 8px 0 0 0; overflow-x: auto;"><code>${JSON.stringify(data, null, 2)}</code></pre>`;
  }

  return "";
}
/**
 * Dispatches the QC status email strictly to config.targetEmailRecipient.
 *
 * @param {Object} qcResults - Output object from overnightQC.runAll()
 * @param {Date|string} [targetDate=new Date()] - Valuation date
 */
export async function sendQcEmail(qcResults, targetDate = new Date()) {
  const failed = (qcResults.results || []).filter((c) => !c.passed);
  const criticals = failed.filter((c) => c.severity === "CRITICAL").length;
  const warnings = failed.length - criticals;
  const statusFlag =
    criticals > 0
      ? "[FAIL - ACTION REQUIRED]"
      : warnings > 0
        ? `[PASS · ${warnings} warning${warnings > 1 ? "s" : ""}]`
        : "[PASS]";
  const subject = `findb-engine: qc status ${statusFlag}`;
  const htmlBody = buildQcEmailHtml(qcResults, targetDate);

  console.log(
    `[QC NOTIFIER] Dispatching QC digest to ${config.targetEmailRecipient}...`,
  );
  await sendHtmlEmail(subject, htmlBody);
  console.log(`[QC NOTIFIER] Status email dispatched successfully.`);
}

/**
 * Sends an HTML email to config.targetEmailRecipient, from the same Gmail account (Google App Password).
 *
 * @param {string} subject
 * @param {string} html
 */
export async function sendHtmlEmail(subject, html) {
  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: {
      user: config.targetEmailRecipient,
      pass: config.smtpPassword, // Google App Password (16 chars)
    },
  });
  await transporter.sendMail({
    from: `"FinDB Engine" <${config.targetEmailRecipient}>`,
    to: config.targetEmailRecipient,
    subject,
    html,
  });
}
