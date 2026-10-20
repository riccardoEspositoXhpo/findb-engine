import nodemailer from "nodemailer";
import { config } from "../config.js";

// src/reports/qcEmailReporter.js

/**
 * Palette Nord Theme Specifications:
 * https://www.nordtheme.com/docs/colors-and-palettes
 */
const NORD = {
  polarNight0: "#2E3440", // Dark base background
  polarNight1: "#3B4252", // Card / Row background
  polarNight2: "#434C5E", // Borders & separators
  polarNight3: "#4C566A", // Muted labels
  snowStorm4: "#D8DEE9", // Secondary text
  snowStorm6: "#ECEFF4", // Primary white text
  frost8: "#88C0D0", // Frost Cyan Accent
  aurora11: "#BF616A", // Aurora Red (FAIL)
  aurora14: "#A3BE8C", // Aurora Green (PASS)
};

/**
 * Renders an array of arbitrary diagnostic objects as a dynamic HTML sub-table.
 *
 * @param {Array<Object>} records - Array of diagnostic failure objects
 * @returns {string} Rendered HTML sub-table
 */
function renderDynamicTable(records) {
  if (!Array.isArray(records) || records.length === 0) return "";

  const headers = Object.keys(records[0]);

  const thHtml = headers
    .map(
      (h) =>
        `<th style="padding: 6px 10px; font-size: 11px; text-transform: uppercase; color: ${NORD.frost8}; border-bottom: 1px solid ${NORD.polarNight2}; font-family: 'JetBrains Mono', Menlo, Consolas, monospace;">${h}</th>`,
    )
    .join("");

  const rowsHtml = records
    .map((row, idx) => {
      const bg = idx % 2 === 0 ? NORD.polarNight0 : NORD.polarNight1;
      const cells = headers
        .map(
          (h) =>
            `<td style="padding: 6px 10px; font-size: 11px; color: ${NORD.snowStorm6}; border-bottom: 1px solid ${NORD.polarNight2}; font-family: 'JetBrains Mono', Menlo, Consolas, monospace;">${row[h] !== undefined && row[h] !== null ? row[h] : ""}</td>`,
        )
        .join("");
      return `<tr style="background-color: ${bg};">${cells}</tr>`;
    })
    .join("");

  return `
    <div style="margin-top: 10px; overflow-x: auto; border: 1px solid ${NORD.polarNight2}; border-radius: 6px;">
      <table style="width: 100%; border-collapse: collapse; text-align: left;">
        <thead>
          <tr style="background-color: ${NORD.polarNight0};">
            ${thHtml}
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
    </div>
  `;
}

/**
 * Builds a two-tier executive HTML digest themed with the Nord Palette.
 *
 * @param {Object} qcResults - Output object from overnightQC.runAll()
 * @param {Array<Object>} qcResults.results - Array of QC check outputs
 * @param {Date|string} [targetDate=new Date()] - Valuation date
 * @returns {string} Inline-CSS HTML email body
 */
export function buildQcEmailHtml(qcResults, targetDate = new Date()) {
  const checks = qcResults.results || [];
  const totalChecks = checks.length;
  const failedChecks = checks.filter((c) => !c.passed);
  const isAllPassed = failedChecks.length === 0;

  const dateStr =
    targetDate instanceof Date
      ? targetDate.toISOString().split("T")[0]
      : String(targetDate);
  const timestamp = new Date().toUTCString();

  // Tier 1: Summary Table Rows (Name & Status only)
  const summaryRowsHtml = checks
    .map((c, idx) => {
      const isPassed = Boolean(c.passed);
      const rowBg = idx % 2 === 0 ? NORD.polarNight0 : NORD.polarNight1;
      const statusPill = isPassed
        ? `<span style="color: ${NORD.aurora14}; font-weight: 600; font-size: 12px; background: rgba(163, 190, 140, 0.12); padding: 3px 10px; border-radius: 4px; border: 1px solid rgba(163, 190, 140, 0.3);">PASS</span>`
        : `<span style="color: ${NORD.aurora11}; font-weight: 600; font-size: 12px; background: rgba(191, 97, 106, 0.12); padding: 3px 10px; border-radius: 4px; border: 1px solid rgba(191, 97, 106, 0.3);">FAIL</span>`;

      return `
        <tr style="background-color: ${rowBg}; border-bottom: 1px solid ${NORD.polarNight2};">
          <td style="padding: 12px 16px; font-family: 'JetBrains Mono', Menlo, Consolas, monospace; font-size: 13px; color: ${NORD.snowStorm6};">
            <strong>${c.check || "Unnamed Check"}</strong>
            ${c.summary ? `<div style="font-size: 11px; color: ${NORD.snowStorm4}; margin-top: 2px;">${c.summary}</div>` : ""}
          </td>
          <td style="padding: 12px 16px; text-align: right; width: 90px;">
            ${statusPill}
          </td>
        </tr>
      `;
    })
    .join("");

  // Tier 2: Detailed Failure Breakdown (Only rendered when there are failures)
  let failureBreakdownHtml = "";
  if (!isAllPassed) {
    const failureCardsHtml = failedChecks
      .map((c) => {
        let diagnosticContent = "";

        if (Array.isArray(c.data) && c.data.length > 0) {
          // Dynamic sub-table from array of objects
          diagnosticContent = renderDynamicTable(c.data);
        } else if (c.data && typeof c.data === "object") {
          // Generic object fallback
          diagnosticContent = `
            <pre style="margin: 8px 0 0 0; padding: 10px; background-color: ${NORD.polarNight0}; border: 1px solid ${NORD.polarNight2}; border-radius: 6px; font-family: 'JetBrains Mono', Menlo, Consolas, monospace; font-size: 11px; color: ${NORD.frost8}; white-space: pre-wrap;">${JSON.stringify(c.data, null, 2)}</pre>
          `;
        }

        return `
          <div style="background-color: ${NORD.polarNight1}; border: 1px solid ${NORD.aurora11}; border-radius: 8px; padding: 14px 16px; margin-bottom: 14px;">
            <div style="display: flex; justify-content: space-between; align-items: baseline;">
              <span style="font-family: 'JetBrains Mono', Menlo, Consolas, monospace; font-size: 13px; font-weight: 700; color: ${NORD.aurora11};">
                🚨 ${c.check}
              </span>
            </div>
            ${c.message ? `<div style="font-size: 12px; color: ${NORD.snowStorm6}; margin-top: 6px;">${c.message}</div>` : ""}
            ${diagnosticContent}
          </div>
        `;
      })
      .join("");

    failureBreakdownHtml = `
      <div style="padding: 20px 24px; background-color: ${NORD.polarNight0}; border-top: 2px solid ${NORD.aurora11};">
        <h2 style="margin: 0 0 12px 0; font-size: 15px; text-transform: uppercase; letter-spacing: 0.05em; color: ${NORD.aurora11};">
          Action Required: Failure Diagnostics (${failedChecks.length})
        </h2>
        ${failureCardsHtml}
      </div>
    `;
  }

  return `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>findb-engine: qc status</title>
  </head>
  <body style="margin: 0; padding: 24px; background-color: ${NORD.polarNight0}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: ${NORD.snowStorm4}; line-height: 1.5;">
    <div style="max-width: 680px; margin: 0 auto; background-color: ${NORD.polarNight1}; border: 1px solid ${NORD.polarNight2}; border-radius: 12px; overflow: hidden; box-shadow: 0 10px 25px rgba(0, 0, 0, 0.35);">
      
      <!-- Top Branding Bar -->
      <div style="background-color: ${NORD.polarNight2}; padding: 18px 24px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid ${NORD.polarNight3};">
        <div>
          <span style="font-size: 11px; font-weight: 700; letter-spacing: 0.1em; color: ${NORD.frost8}; text-transform: uppercase;">findb engine</span>
          <h1 style="margin: 2px 0 0 0; font-size: 20px; font-weight: 600; color: ${NORD.snowStorm6};">Overnight QC Status</h1>
        </div>
        <div>
          ${
            isAllPassed
              ? `<span style="background-color: ${NORD.aurora14}; color:${NORD.polarNight0}; font-weight: 700; padding: 4px 12px; border-radius: 9999px; font-size: 12px; text-transform: uppercase;">ALL PASSED</span>`
              : `<span style="background-color: ${NORD.aurora11}; color: ${NORD.snowStorm6}; font-weight: 700; padding: 4px 12px; border-radius: 9999px; font-size: 12px; text-transform: uppercase;">${failedChecks.length} FAILED</span>`
          }
        </div>
      </div>

      <!-- Metadata Bar -->
      <div style="padding: 14px 24px; background-color: ${NORD.polarNight1}; border-bottom: 1px solid ${NORD.polarNight2}; display: flex; font-size: 12px;">
        <div style="margin-right: 32px;">
          <div style="color: ${NORD.snowStorm4}; font-size: 11px; text-transform: uppercase;">Target Date</div>
          <div style="color: ${NORD.snowStorm6}; font-weight: 600; font-family: monospace;">${dateStr}</div>
        </div>
        <div style="margin-right: 32px;">
          <div style="color: ${NORD.snowStorm4}; font-size: 11px; text-transform: uppercase;">Executed At</div>
          <div style="color: ${NORD.snowStorm6}; font-family: monospace;">${timestamp}</div>
        </div>
        <div>
          <div style="color: ${NORD.snowStorm4}; font-size: 11px; text-transform: uppercase;">Summary</div>
          <div style="color: ${isAllPassed ? NORD.aurora14 : NORD.aurora11}; font-weight: 600;">
            ${totalChecks - failedChecks.length}/${totalChecks} Passed
          </div>
        </div>
      </div>

      <!-- Tier 1: Summary Table -->
      <table style="width: 100%; border-collapse: collapse; text-align: left;">
        <thead>
          <tr style="background-color: ${NORD.polarNight2}; font-size: 11px; text-transform: uppercase; color: ${NORD.snowStorm4};">
            <th style="padding: 10px 16px;">Check Name</th>
            <th style="padding: 10px 16px; text-align: right;">Status</th>
          </tr>
        </thead>
        <tbody>
          ${summaryRowsHtml}
        </tbody>
      </table>

      <!-- Tier 2: Dynamic Failure Breakdown -->
      ${failureBreakdownHtml}

      <!-- Footer -->
      <div style="padding: 14px 24px; background-color: ${NORD.polarNight0}; border-top: 1px solid ${NORD.polarNight2}; font-size: 11px; color: ${NORD.snowStorm4}; text-align: center;">
        Automated production telemetry emitted by <strong style="color: ${NORD.frost8};">FinDB GCP Batch Runner</strong>.
      </div>
    </div>
  </body>
  </html>
  `;
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
