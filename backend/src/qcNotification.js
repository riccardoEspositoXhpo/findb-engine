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

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>FinDB Overnight QC Report - ${dateStr}</title>
</head>
<body style="margin: 0; padding: 24px; background-color: ${NORD.polarNight0}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: ${NORD.snowStorm1};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 800px; margin: 0 auto; background-color: ${NORD.polarNight1}; border-radius: 8px; border: 1px solid ${NORD.polarNight2}; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.3);">
    
    <!-- HEADER -->
    <tr>
      <td style="padding: 24px 32px; background-color: ${NORD.polarNight1}; border-bottom: 2px solid ${NORD.frost2};">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td>
              <h1 style="margin: 0; font-size: 20px; font-weight: 700; color: ${NORD.snowStorm2}; letter-spacing: 0.5px;">
                FINDB OVERNIGHT QC REPORT
              </h1>
              <div style="font-size: 13px; color: ${NORD.frost2}; margin-top: 4px; font-weight: 500;">
                Valuation Date: ${dateStr}
              </div>
            </td>
            <td align="right">
              <span style="display: inline-block; padding: 6px 12px; border-radius: 4px; font-size: 12px; font-weight: 700; background-color: ${criticalCount > 0 ? NORD.auroraRed : warningCount > 0 ? NORD.auroraOrange : NORD.auroraGreen}; color: ${NORD.snowStorm2}; text-transform: uppercase;">
                ${criticalCount > 0 ? "CRITICAL ALERT" : warningCount > 0 ? "WARNINGS DETECTED" : "ALL SYSTEMS GREEN"}
              </span>
            </td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- METRIC KPI STRIP -->
    <tr>
      <td style="padding: 16px 32px; background-color: ${NORD.polarNight0}; border-bottom: 1px solid ${NORD.polarNight2};">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td width="33%" style="text-align: center; border-right: 1px solid ${NORD.polarNight2};">
              <div style="font-size: 11px; text-transform: uppercase; color: ${NORD.snowStorm0}; font-weight: 600;">Passed</div>
              <div style="font-size: 22px; font-weight: 700; color: ${NORD.auroraGreen}; margin-top: 2px;">${passedCount} / ${checks.length}</div>
            </td>
            <td width="33%" style="text-align: center; border-right: 1px solid ${NORD.polarNight2};">
              <div style="font-size: 11px; text-transform: uppercase; color: ${NORD.snowStorm0}; font-weight: 600;">Critical Deficiencies</div>
              <div style="font-size: 22px; font-weight: 700; color: ${criticalCount > 0 ? NORD.auroraRed : NORD.snowStorm0}; margin-top: 2px;">${criticalCount}</div>
            </td>
            <td width="33%" style="text-align: center;">
              <div style="font-size: 11px; text-transform: uppercase; color: ${NORD.snowStorm0}; font-weight: 600;">Warnings / Anomalies</div>
              <div style="font-size: 22px; font-weight: 700; color: ${warningCount > 0 ? NORD.auroraOrange : NORD.snowStorm0}; margin-top: 2px;">${warningCount}</div>
            </td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- TIER 1: EXECUTIVE SUMMARY TABLE -->
    <tr>
      <td style="padding: 24px 32px;">
        <h2 style="margin: 0 0 12px 0; font-size: 14px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: ${NORD.snowStorm2};">
          Executive Verification Summary
        </h2>
        <table width="100%" cellpadding="8" cellspacing="0" style="border-collapse: collapse; font-size: 13px;">
          <thead>
            <tr style="border-bottom: 1px solid ${NORD.polarNight3}; text-align: left; color: ${NORD.snowStorm0};">
              <th style="padding: 8px 12px; font-weight: 600;">Check</th>
              <th style="padding: 8px 12px; font-weight: 600;">Type</th>
              <th style="padding: 8px 12px; font-weight: 600;">Severity</th>
              <th style="padding: 8px 12px; font-weight: 600; text-align: right;">Status</th>
            </tr>
          </thead>
          <tbody>
            ${checks.map((c, idx) => renderSummaryRow(c, idx)).join("")}
          </tbody>
        </table>
      </td>
    </tr>

    <!-- TIER 2: FAILURES & ANOMALIES BREAKDOWN -->
    ${
      criticalFailures.length > 0 || warningFailures.length > 0
        ? `
    <tr>
      <td style="padding: 0 32px 32px 32px;">
        <div style="border-top: 1px solid ${NORD.polarNight2}; padding-top: 24px;">
          
          ${
            criticalFailures.length > 0
              ? `
          <h2 style="margin: 0 0 16px 0; font-size: 14px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: ${NORD.auroraRed};">
            🚨 Critical Failures (Immediate Attention)
          </h2>
          ${criticalFailures.map((c) => renderDetailCard(c, NORD.auroraRed)).join("")}
          `
              : ""
          }

          ${
            warningFailures.length > 0
              ? `
          <h2 style="margin: ${criticalFailures.length > 0 ? "24px" : "0"} 0 16px 0; font-size: 14px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: ${NORD.auroraOrange};">
            ⚠️ Warnings & Anomalies (Review Required)
          </h2>
          ${warningFailures.map((c) => renderDetailCard(c, NORD.auroraOrange)).join("")}
          `
              : ""
          }

        </div>
      </td>
    </tr>
    `
        : ""
    }

    <!-- FOOTER -->
    <tr>
      <td style="padding: 16px 32px; background-color: ${NORD.polarNight0}; border-top: 1px solid ${NORD.polarNight2}; font-size: 11px; color: ${NORD.polarNight3}; text-align: center;">
        Generated automatically by findb-engine on GCP Batch &bull; Environment: Node.js &bull; Database: Postgres
      </td>
    </tr>

  </table>
</body>
</html>
  `.trim();
}

function renderSummaryRow(c, idx) {
  const isAlt = idx % 2 === 1;
  const bg = isAlt ? `background-color: rgba(255, 255, 255, 0.02);` : "";

  let badge;
  if (c.passed) {
    badge = `<span style="background-color: ${NORD.auroraGreen}; color: ${NORD.polarNight0}; padding: 3px 8px; border-radius: 4px; font-weight: 700; font-size: 11px;">PASS</span>`;
  } else if (c.severity === "CRITICAL") {
    badge = `<span style="background-color: ${NORD.auroraRed}; color: ${NORD.snowStorm2}; padding: 3px 8px; border-radius: 4px; font-weight: 700; font-size: 11px;">FAIL</span>`;
  } else {
    badge = `<span style="background-color: ${NORD.auroraOrange}; color: ${NORD.snowStorm2}; padding: 3px 8px; border-radius: 4px; font-weight: 700; font-size: 11px;">WARN</span>`;
  }

  const failureTypeColor =
    c.failureType === "DETERMINISTIC" ? NORD.frost2 : NORD.auroraYellow;

  return `
    <tr style="border-bottom: 1px solid ${NORD.polarNight2}; ${bg}">
      <td style="padding: 10px 12px;">
        <div style="font-weight: 600; color: ${NORD.snowStorm2};">${c.check}</div>
        ${c.summary ? `<div style="font-size: 11px; color: ${NORD.snowStorm0}; margin-top: 2px;">${c.summary}</div>` : ""}
      </td>
      <td style="padding: 10px 12px; font-size: 11px; font-weight: 600; color: ${failureTypeColor};">
        ${c.failureType || "DETERMINISTIC"}
      </td>
      <td style="padding: 10px 12px; font-size: 11px; font-weight: 600; color: ${c.severity === "CRITICAL" ? NORD.auroraRed : NORD.snowStorm0};">
        ${c.severity || "WARNING"}
      </td>
      <td style="padding: 10px 12px; text-align: right;">
        ${badge}
      </td>
    </tr>
  `;
}

function renderDetailCard(c, accentColor) {
  return `
    <div style="margin-bottom: 16px; background-color: ${NORD.polarNight0}; border: 1px solid ${NORD.polarNight2}; border-left: 4px solid ${accentColor}; border-radius: 4px; padding: 16px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 8px;">
        <tr>
          <td>
            <span style="font-weight: 700; color: ${NORD.snowStorm2}; font-size: 13px;">${c.check}</span>
            <span style="margin-left: 8px; font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 3px; background-color: ${NORD.polarNight2}; color: ${NORD.snowStorm1};">
              ${c.failureType || "DETERMINISTIC"}
            </span>
          </td>
          <td align="right" style="font-size: 11px; color: ${NORD.snowStorm0};">
            ${c.date || ""}
          </td>
        </tr>
      </table>
      
      ${c.message ? `<div style="font-size: 12px; color: ${NORD.snowStorm1}; margin-bottom: 12px;">${c.message}</div>` : ""}

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

    return `
      <table width="100%" cellpadding="6" cellspacing="0" style="border-collapse: collapse; font-size: 11px; background-color: ${NORD.polarNight1}; border-radius: 4px; overflow: hidden; margin-top: 8px;">
        <thead>
          <tr style="background-color: ${NORD.polarNight2}; text-align: left; color: ${NORD.snowStorm2};">
            ${columns.map((col) => `<th style="padding: 6px 10px; font-weight: 600; text-transform: uppercase;">${col}</th>`).join("")}
          </tr>
        </thead>
        <tbody>
          ${displayRows
            .map(
              (row, idx) => `
            <tr style="border-bottom: 1px solid ${NORD.polarNight2}; background-color: ${idx % 2 === 1 ? "rgba(255,255,255,0.02)" : "transparent"}; color: ${NORD.snowStorm1};">
              ${columns.map((col) => `<td style="padding: 6px 10px; font-family: monospace;">${row[col] !== null && row[col] !== undefined ? row[col] : ""}</td>`).join("")}
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
  const isAllPassed = (qcResults.results || []).every((c) => c.passed);
  const statusFlag = isAllPassed ? "[PASS]" : "[FAIL - ACTION REQUIRED]";
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
    from: `"FinDB Engine" <${process.env.SMTP_USER}>`,
    to: recipient,
    subject: subject,
    html: htmlBody,
  });

  console.log(`[QC NOTIFIER] Status email dispatched successfully.`);
}
