import nodemailer from "nodemailer";
import { config } from "../config.js";

// src/reports/qcEmailReporter.js

const NORD = {
  polarNight0: "#2E3440", // Deep background
  polarNight1: "#3B4252", // Card background
  polarNight2: "#434C5E", // Row hover / borders
  polarNight3: "#4C566A", // Muted text / dividers
  snowStorm0: "#D8DEE9", // Secondary text
  snowStorm1: "#E5E9F0", // Body text
  snowStorm2: "#ECEFF4", // Crisp white headers
  frost2: "#88C0D0", // Accent cyan
  auroraGreen: "#A3BE8C", // Pass
  auroraYellow: "#EBCB8B", // Probabilistic Warning
  auroraOrange: "#D08770", // Deterministic Warning / Badges
  auroraRed: "#BF616A", // Critical Failure
};

export function buildQcEmailHtml(qcResults, targetDate = new Date()) {
  const dateStr =
    targetDate instanceof Date
      ? targetDate.toISOString().split("T")[0]
      : targetDate;
  const checks = Array.isArray(qcResults?.results) ? qcResults.results : [];

  const passedCount = checks.filter((c) => c.passed).length;
  const failedChecks = checks.filter((c) => !c.passed);
  const criticalCount = checks.filter(
    (c) => !c.passed && c.severity === "CRITICAL",
  ).length;
  const warningCount = checks.filter(
    (c) => !c.passed && c.severity === "WARNING",
  ).length;

  const criticalFailures = checks.filter(
    (c) => !c.passed && c.severity === "CRITICAL",
  );
  const warningFailures = checks.filter(
    (c) => !c.passed && c.severity === "WARNING",
  );

  // Warnings (probabilistic checks: price / fx / nav jumps) don't fail the night: only a critical does (user)
  const overall =
    criticalCount > 0
      ? { label: "CRITICAL ALERT", color: NORD.auroraRed }
      : { label: warningCount > 0 ? `PASS · ${warningCount} warning${warningCount > 1 ? "s" : ""}` : "PASS", color: NORD.auroraGreen };

  // Email-client rules: Gmail drops <body> styles, so the dark background lives on a full-width outer table
  // (bgcolor + style); the card is a fluid table capped at 640px. Phones: viewport meta + @media rules (supported by
  // Gmail / Apple Mail) stack the header, hide secondary columns and let wide data tables scroll.
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="dark">
  <meta name="supported-color-schemes" content="dark">
  <title>FinDB Overnight QC Report - ${dateStr}</title>
  <style>
    body { margin: 0 !important; padding: 0 !important; background-color: ${NORD.polarNight0}; }
    @media only screen and (max-width: 600px) {
      .outer-pad { padding: 12px 8px !important; }
      .section { padding-left: 16px !important; padding-right: 16px !important; }
      .stack { display: block !important; width: 100% !important; text-align: left !important; }
      .stack-gap { padding-top: 10px !important; }
      .hide-mobile { display: none !important; }
      .show-mobile { display: block !important; max-height: none !important; overflow: visible !important; }
      .kpi-label { font-size: 11px !important; }
      .kpi-value { font-size: 22px !important; }
      .title { font-size: 19px !important; }
    }
  </style>
</head>
<body style="margin: 0; padding: 0; background-color: ${NORD.polarNight0};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${NORD.polarNight0}" style="background-color: ${NORD.polarNight0}; width: 100%;">
    <tr>
      <td class="outer-pad" align="center" style="padding: 24px 12px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${NORD.polarNight1}" style="width: 100%; max-width: 640px; background-color: ${NORD.polarNight1}; border: 1px solid ${NORD.polarNight2}; border-radius: 8px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: ${NORD.snowStorm1};">

          <!-- HEADER -->
          <tr>
            <td class="section" style="padding: 22px 28px; border-bottom: 2px solid ${NORD.frost2};">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td class="stack" valign="middle">
                    <div class="title" style="font-size: 20px; font-weight: 700; color: ${NORD.snowStorm2}; letter-spacing: 0.4px;">FINDB OVERNIGHT QC</div>
                    <div style="font-size: 14px; color: ${NORD.frost2}; margin-top: 4px; font-weight: 500;">Valuation date ${dateStr}</div>
                  </td>
                  <td class="stack stack-gap" valign="middle" align="right" style="text-align: right;">
                    <span style="display: inline-block; padding: 7px 12px; border-radius: 4px; font-size: 13px; font-weight: 700; background-color: ${overall.color}; color: ${NORD.polarNight0}; letter-spacing: 0.4px;">${overall.label}</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- KPI STRIP -->
          <tr>
            <td class="section" bgcolor="${NORD.polarNight0}" style="padding: 16px 28px; background-color: ${NORD.polarNight0}; border-bottom: 1px solid ${NORD.polarNight2};">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  ${renderKpi("Passed", `${passedCount}/${checks.length}`, NORD.auroraGreen, true)}
                  ${renderKpi("Critical", criticalCount, criticalCount > 0 ? NORD.auroraRed : NORD.snowStorm0, true)}
                  ${renderKpi("Warnings", warningCount, warningCount > 0 ? NORD.auroraOrange : NORD.snowStorm0, false)}
                </tr>
              </table>
            </td>
          </tr>

          <!-- SUMMARY: only the checks that failed or warned (the KPI strip above counts them all) -->
          <tr>
            <td class="section" style="padding: 22px 28px;">
              <div style="margin: 0 0 12px 0; font-size: 14px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: ${NORD.snowStorm2};">Checks</div>
              ${
                failedChecks.length === 0
                  ? `<div style="font-size: 14px; color: ${NORD.auroraGreen};">All ${checks.length} checks passed.</div>`
                  : `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse: collapse; font-size: 14px;">
                <tr style="text-align: left; color: ${NORD.snowStorm0};">
                  <th align="left" style="padding: 8px 10px; font-weight: 600; font-size: 12px; border-bottom: 1px solid ${NORD.polarNight3};">Check</th>
                  <th class="hide-mobile" align="left" style="padding: 8px 10px; font-weight: 600; font-size: 12px; border-bottom: 1px solid ${NORD.polarNight3};">Type</th>
                  <th class="hide-mobile" align="left" style="padding: 8px 10px; font-weight: 600; font-size: 12px; border-bottom: 1px solid ${NORD.polarNight3};">Severity</th>
                  <th align="right" style="padding: 8px 10px; font-weight: 600; font-size: 12px; border-bottom: 1px solid ${NORD.polarNight3};">Status</th>
                </tr>
                ${failedChecks.map((c, idx) => renderSummaryRow(c, idx)).join("")}
              </table>
              <div style="margin-top: 10px; font-size: 12px; color: ${NORD.snowStorm0};">${passedCount} other check(s) passed.</div>`
              }
            </td>
          </tr>

          ${
            criticalFailures.length > 0 || warningFailures.length > 0
              ? `
          <!-- FAILURES -->
          <tr>
            <td class="section" style="padding: 4px 28px 28px 28px;">
              ${
                criticalFailures.length > 0
                  ? `<div style="margin: 16px 0 12px 0; font-size: 14px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: ${NORD.auroraRed};">🚨 Critical failures</div>
              ${criticalFailures.map((c) => renderDetailCard(c, NORD.auroraRed)).join("")}`
                  : ""
              }
              ${
                warningFailures.length > 0
                  ? `<div style="margin: 16px 0 12px 0; font-size: 14px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: ${NORD.auroraOrange};">⚠️ Warnings</div>
              ${warningFailures.map((c) => renderDetailCard(c, NORD.auroraOrange)).join("")}`
                  : ""
              }
            </td>
          </tr>`
              : ""
          }

          <!-- FOOTER -->
          <tr>
            <td class="section" bgcolor="${NORD.polarNight0}" style="padding: 14px 28px; background-color: ${NORD.polarNight0}; border-top: 1px solid ${NORD.polarNight2}; border-radius: 0 0 8px 8px; font-size: 12px; color: ${NORD.polarNight3}; text-align: center;">
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

/** One KPI cell (label above, big value below), with a divider on its right unless it is the last. */
function renderKpi(label, value, color, divider) {
  return `
                  <td width="33%" align="center" valign="top" style="text-align: center; padding: 2px 4px;${divider ? ` border-right: 1px solid ${NORD.polarNight2};` : ""}">
                    <div class="kpi-label" style="font-size: 12px; text-transform: uppercase; color: ${NORD.snowStorm0}; font-weight: 600; letter-spacing: 0.4px;">${label}</div>
                    <div class="kpi-value" style="font-size: 24px; font-weight: 700; color: ${color}; margin-top: 4px;">${value}</div>
                  </td>`;
}

function renderSummaryRow(c, idx) {
  const isAlt = idx % 2 === 1;
  const bg = isAlt ? `background-color: rgba(255, 255, 255, 0.02);` : "";

  let badge;
  if (c.passed) {
    badge = `<span style="background-color: ${NORD.auroraGreen}; color: ${NORD.polarNight0}; padding: 4px 9px; border-radius: 4px; font-weight: 700; font-size: 12px; white-space: nowrap;">PASS</span>`;
  } else if (c.severity === "CRITICAL") {
    badge = `<span style="background-color: ${NORD.auroraRed}; color: ${NORD.snowStorm2}; padding: 4px 9px; border-radius: 4px; font-weight: 700; font-size: 12px; white-space: nowrap;">FAIL</span>`;
  } else {
    badge = `<span style="background-color: ${NORD.auroraOrange}; color: ${NORD.snowStorm2}; padding: 4px 9px; border-radius: 4px; font-weight: 700; font-size: 12px; white-space: nowrap;">WARN</span>`;
  }

  const failureTypeColor =
    c.failureType === "DETERMINISTIC" ? NORD.frost2 : NORD.auroraYellow;

  const severityColor = c.severity === "CRITICAL" ? NORD.auroraRed : NORD.snowStorm0;
  const cell = `padding: 11px 10px; border-bottom: 1px solid ${NORD.polarNight2}; ${bg}`;
  return `
                <tr>
                  <td valign="top" style="${cell}">
                    <div style="font-weight: 600; color: ${NORD.snowStorm2}; font-size: 14px;">${c.check}</div>
                    ${c.summary ? `<div style="font-size: 12px; color: ${NORD.snowStorm0}; margin-top: 3px;">${c.summary}</div>` : ""}
                    <div class="show-mobile" style="display: none; max-height: 0; overflow: hidden; font-size: 11px; font-weight: 600; margin-top: 4px;">
                      <span style="color: ${failureTypeColor};">${c.failureType || "DETERMINISTIC"}</span>
                      <span style="color: ${NORD.polarNight3};"> &bull; </span>
                      <span style="color: ${severityColor};">${c.severity || "WARNING"}</span>
                    </div>
                  </td>
                  <td class="hide-mobile" valign="top" style="${cell} font-size: 12px; font-weight: 600; color: ${failureTypeColor};">${c.failureType || "DETERMINISTIC"}</td>
                  <td class="hide-mobile" valign="top" style="${cell} font-size: 12px; font-weight: 600; color: ${severityColor};">${c.severity || "WARNING"}</td>
                  <td valign="top" align="right" style="${cell} text-align: right;">${badge}</td>
                </tr>
  `;
}

function renderDetailCard(c, accentColor) {
  return `
    <div style="margin-bottom: 14px; background-color: ${NORD.polarNight0}; border: 1px solid ${NORD.polarNight2}; border-left: 4px solid ${accentColor}; border-radius: 4px; padding: 14px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 8px;">
        <tr>
          <td>
            <span style="font-weight: 700; color: ${NORD.snowStorm2}; font-size: 14px;">${c.check}</span>
            <span style="margin-left: 8px; font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 3px; background-color: ${NORD.polarNight2}; color: ${NORD.snowStorm1};">
              ${c.failureType || "DETERMINISTIC"}
            </span>
          </td>
          <td align="right" style="font-size: 11px; color: ${NORD.snowStorm0};">
            ${c.date || ""}
          </td>
        </tr>
      </table>
      
      ${c.message ? `<div style="font-size: 13px; line-height: 1.45; color: ${NORD.snowStorm1}; margin-bottom: 12px;">${c.message}</div>` : ""}

      ${renderDynamicData(c.data)}
    </div>
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
      <div style="width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; margin-top: 8px;">
      <table cellpadding="6" cellspacing="0" style="border-collapse: collapse; font-size: 12px; background-color: ${NORD.polarNight1}; min-width: 100%;">
        <thead>
          <tr style="background-color: ${NORD.polarNight2}; text-align: left; color: ${NORD.snowStorm2};">
            ${columns.map((col) => `<th style="padding: 6px 10px; font-weight: 600; text-transform: uppercase; white-space: nowrap; text-align: left;">${col}</th>`).join("")}
          </tr>
        </thead>
        <tbody>
          ${displayRows
            .map(
              (row, idx) => `
            <tr style="border-bottom: 1px solid ${NORD.polarNight2}; background-color: ${idx % 2 === 1 ? "rgba(255,255,255,0.02)" : "transparent"}; color: ${NORD.snowStorm1};">
              ${columns.map((col) => `<td style="padding: 6px 10px; font-family: monospace; white-space: nowrap;">${row[col] !== null && row[col] !== undefined ? row[col] : ""}</td>`).join("")}
            </tr>
          `,
            )
            .join("")}
          ${
            isTruncated
              ? `
            <tr style="background-color: ${NORD.polarNight0}; font-style: italic; color: ${NORD.snowStorm0};">
              <td colspan="${columns.length}" style="padding: 8px 10px; text-align: center;">
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
    return `<pre style="background-color: ${NORD.polarNight1}; padding: 8px; border-radius: 4px; font-size: 11px; color: ${NORD.snowStorm1}; margin: 8px 0 0 0; overflow-x: auto;"><code>${JSON.stringify(data, null, 2)}</code></pre>`;
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
  const statusFlag = criticals > 0 ? "[FAIL - ACTION REQUIRED]" : warnings > 0 ? `[PASS · ${warnings} warning${warnings > 1 ? "s" : ""}]` : "[PASS]";
  const subject = `findb-engine: qc status ${statusFlag}`;
  const htmlBody = buildQcEmailHtml(qcResults, targetDate);

  // Hardcoded destination target from config
  const recipient = config.targetEmailRecipient;

  // Initialize SMTP transport with environment credentials
  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: {
      user: config.targetEmailRecipient,
      pass: config.smtpPassword, // Google App Password (16 chars)
    },
  });

  console.log(`[QC NOTIFIER] Dispatching QC digest to ${recipient}...`);

  await transporter.sendMail({
    from: `"FinDB Engine" <${config.targetEmailRecipient}>`,
    to: recipient,
    subject: subject,
    html: htmlBody,
  });

  console.log(`[QC NOTIFIER] Status email dispatched successfully.`);
}
