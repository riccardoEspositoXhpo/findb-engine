import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { utils } from "./utils.js";
import { query } from "./db.js";
import { config } from "../config.js";
import { insertNewEvents } from "./events.js";

export const scrapeEmails = {
  run,
  parseIntesaBalance,
  parseFideuramBalance,
  parseAmexBalance,
  readLabelAttachments,
};

// Gmail label (= IMAP mailbox) -> portfolio + parser. A parser turns one email into events (BALANCE for bank / card
// balances; later PURCHASE / SALE for Directa trades...). Adding a source = a Gmail filter applying the label + one parser here.
// Labels of FILE portfolios are portfolios.source (GAS saveAttachments used the same column).
const EMAIL_SOURCES = {
  bancaIntesa: { portfolioId: "BANCA_INTESA", parse: parseIntesaBalance },
  fideuram: { portfolioId: "FIDEURAM", parse: parseFideuramBalance },
  amex: { portfolioId: "AMEX", parse: parseAmexBalance },
};

/**
 * Reads the labelled emails and turns them into events (everything converges into events). For each label it reads
 * the emails since the last one already scraped (all of them the first time), parses them and inserts the events
 * that don't exist yet: each event carries { email_message_id, email_source } in event_metadata, so an email is never
 * turned into events twice. Read-only on Gmail (mailboxes opened with EXAMINE, nothing marked as seen or moved).
 * A Gmail failure is logged and skipped: valuation then runs on the latest events already in the DB.
 * Replaces saveAttachments (Gmail -> Drive) + the document parsing of createandRunBalanceFromFile /
 * processDocumentEvents in // generalScripts.gs, portfolioData.gs
 *
 * @param {Date|string} [targetDate=new Date()] - Evaluation date (emails received after it are ignored)
 * @returns {Promise<{read: number, created: number, unparsed: number}>}
 */
export async function run(targetDate = new Date()) {
  const dateStr = utils.formatDateToISO(targetDate);
  console.log(`[SCRAPE EMAILS] Starting email scrape up to ${dateStr}...`);
  const summary = { read: 0, created: 0, unparsed: 0 };

  if (!config.targetEmailRecipient || !config.smtpPassword) {
    console.error("[SCRAPE EMAILS] TARGET_EMAIL_RECIPIENT / SMTP_PASS not set, skipping.");
    return summary;
  }

  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: config.targetEmailRecipient, pass: config.smtpPassword },
    logger: false,
  });

  const candidates = [];
  try {
    await client.connect();
    for (const [label, source] of Object.entries(EMAIL_SOURCES)) {
      const emails = await readLabel(client, label, dateStr);
      summary.read += emails.length;

      for (const email of emails) {
        const events = source.parse(email, source.portfolioId);
        if (events.length === 0) {
          console.warn(`[SCRAPE EMAILS] ${label}: could not parse "${email.subject}" (${email.date}), skipped.`);
          summary.unparsed++;
          continue;
        }
        for (const event of events) {
          candidates.push({
            ...event,
            event_notes: `[EMAIL] ${email.subject ?? label}`,
            event_metadata: { ...event.event_metadata, email_message_id: email.messageId, email_source: label },
          });
        }
      }
    }
  } catch (error) {
    console.error("[SCRAPE EMAILS] Gmail scrape failed, continuing with the events already in the DB:", error.message);
  } finally {
    await client.logout().catch(() => {});
  }

  summary.created = await insertNewEvents(candidates, "email_message_id", (id) => String(id));
  console.log(
    `[SCRAPE EMAILS] Done: ${summary.read} emails read, ${summary.created} events created, ${summary.unparsed} unparsed.`,
  );
  return summary;
}

/**
 * Emails of one Gmail label received up to dateStr, starting from the day of the last email already scraped for that
 * label (IMAP SINCE is per day; duplicates are filtered later on email_message_id). Missing label -> warning, [].
 *
 * @returns {Promise<Array<{messageId: string, date: Date, dateStr: string, subject: string, text: string}>>}
 */
async function readLabel(client, label, dateStr) {
  let lock;
  try {
    lock = await client.getMailboxLock(label, { readOnly: true });
  } catch (error) {
    console.warn(`[SCRAPE EMAILS] Gmail label "${label}" not found, skipped.`);
    return [];
  }

  try {
    const { rows } = await query(
      `SELECT max(date)::text AS last_date FROM events WHERE event_metadata ->> 'email_source' = $1;`,
      [label],
    );
    const since = rows[0].last_date;
    const uids = await client.search(since ? { since: new Date(`${since}T00:00:00Z`) } : { all: true }, { uid: true });

    const emails = [];
    if (!uids || uids.length === 0) return emails;
    // One streamed FETCH for the whole label (one round trip per email would take minutes on a first full scrape)
    for await (const message of client.fetch(uids, { source: true }, { uid: true })) {
      const parsed = await simpleParser(message.source);
      const emailDateStr = utils.formatDateToISO(parsed.date);
      if (emailDateStr > dateStr) continue;
      emails.push({
        messageId: parsed.messageId ?? `${label}:${message.uid}`,
        date: parsed.date,
        dateStr: emailDateStr,
        subject: parsed.subject,
        // Bank notifications are HTML-only (no text part): fall back to the HTML stripped to text
        text: parsed.text || htmlToText(parsed.html || ""),
      });
    }
    return emails;
  } finally {
    lock.release();
  }
}

/**
 * Attachments of every email in a Gmail label whose filename matches the pattern (read-only). For sources that are
 * files rather than text (Crypto.com CSV exports): the caller parses them and dedupes the rows itself.
 *
 * @param {string} label - Gmail label (IMAP mailbox)
 * @param {RegExp} filenamePattern - e.g. /\.csv$/i
 * @returns {Promise<Array<{filename: string, date: Date, content: Buffer}>>} oldest email first
 */
export async function readLabelAttachments(label, filenamePattern) {
  if (!config.targetEmailRecipient || !config.smtpPassword) throw new Error("TARGET_EMAIL_RECIPIENT / SMTP_PASS not set");
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: config.targetEmailRecipient, pass: config.smtpPassword },
    logger: false,
  });
  const attachments = [];
  await client.connect();
  try {
    const lock = await client.getMailboxLock(label, { readOnly: true });
    try {
      for await (const message of client.fetch("1:*", { source: true })) {
        const parsed = await simpleParser(message.source);
        for (const attachment of parsed.attachments) {
          if (filenamePattern.test(attachment.filename ?? "")) {
            attachments.push({ filename: attachment.filename, date: parsed.date, content: attachment.content });
          }
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return attachments.sort((a, b) => a.date - b.date);
}

/** Minimal HTML -> plain text (tags out, common entities decoded, whitespace collapsed): enough for the parsers. */
function htmlToText(html) {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&euro;/g, "€")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
}

/** "1.234,56" / "-12,50" right after a marker (optionally "€" / "EUR"), as a JS number, or null. */
function italianAmountAfter(text, markerRegex) {
  const match = text.match(new RegExp(`${markerRegex}\\s*(?:€|EUR)?\\s*(-?[\\d.]+(?:,\\d+)?)`, "i"));
  return match ? utils.convertItalianFloat(match[1]) : null;
}

function balanceEvent(email, portfolioId, balance, securityId = null) {
  return [{ date: email.dateStr, event_type: "BALANCE", portfolio_id: portfolioId, security_id: securityId, quantity: balance }];
}

/**
 * Banca Intesa balance notification: amount after "pari a " (Italian number format).
 * Migrated from createandRunBalanceFromFile (BANCA_INTESA, REGEXPATTERNS.INTESA_CASH) in // portfolioData.gs
 */
export function parseIntesaBalance(email, portfolioId) {
  const balance = italianAmountAfter(email.text, "pari a");
  return balance === null ? [] : balanceEvent(email, portfolioId, balance);
}

/**
 * Fideuram balance notification: amount after "pari a " (Italian number format).
 * Migrated from createandRunBalanceFromFile (FIDEURAM, REGEXPATTERNS.FIDEURAM) in // portfolioData.gs
 */
export function parseFideuramBalance(email, portfolioId) {
  const balance = italianAmountAfter(email.text, "pari a");
  return balance === null ? [] : balanceEvent(email, portfolioId, balance);
}

/**
 * AMEX statement: first euro amount after "Saldo corrente", negated (a card balance is money owed), held as DEBT_EUR
 * (GAS: CASH_EUR since ~2026-09, DEBT_EUR before).
 * Migrated from createandRunBalanceFromFile (AMEX) in // portfolioData.gs
 */
export function parseAmexBalance(email, portfolioId) {
  const balance = italianAmountAfter(email.text, "Saldo corrente[\\s\\S]{0,2000}?€");
  return balance === null ? [] : balanceEvent(email, portfolioId, -balance, "DEBT_EUR");
}
