import { ImapFlow } from "imapflow";
import { batchLog } from "./batchLog.js";
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
  parseDirecta,
  readLabelAttachments,
};

// Gmail label (= IMAP mailbox) -> portfolio + parser. A parser turns one email into events (BALANCE for bank / card
// balances; later PURCHASE / SALE for Directa trades...). Adding a source = a Gmail filter applying the label + one parser here.
// Labels of FILE portfolios are portfolios.source (GAS saveAttachments used the same column).
const EMAIL_SOURCES = {
  bancaIntesa: { portfolioId: "BANCA_INTESA", parse: parseIntesaBalance },
  fideuram: { portfolioId: "FIDEURAM", parse: parseFideuramBalance },
  amex: { portfolioId: "AMEX", parse: parseAmexBalance },
  directa: { portfolioId: "DIRECTA", parse: parseDirecta },
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
    batchLog.error("scrapeEmails", null, "TARGET_EMAIL_RECIPIENT / SMTP_PASS not set, skipped.");
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
        if (events === null) continue; // ignored on purpose (e.g. emails forwarded by the user)
        if (events.length === 0) {
          batchLog.warn("scrapeEmails", label, `could not parse "${email.subject}" (${email.date}), skipped.`);
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
    batchLog.error("scrapeEmails", null, `Gmail scrape failed, continued with the events already in the DB: ${error.message}`);
  } finally {
    await client.logout().catch(() => {});
  }

  summary.created = await insertNewEvents(await dropRepeatedOrders(candidates), "email_message_id", (id) => String(id));
  console.log(
    `[SCRAPE EMAILS] Done: ${summary.read} emails read, ${summary.created} events created, ${summary.unparsed} unparsed.`,
  );
  return summary;
}

/**
 * Broker notes can arrive more than once (Directa sent one copy of the same note per partial fill): events carrying
 * event_metadata.order_id are kept once per order, across this run's emails and the events already saved. A repeated
 * order with different numbers is logged (a correction would mean deleting and recreating the event by hand).
 */
async function dropRepeatedOrders(candidates) {
  const { rows } = await query(`SELECT event_metadata ->> 'order_id' AS order_id, quantity, price FROM events WHERE event_metadata ? 'order_id';`);
  const seen = new Map(rows.map((row) => [row.order_id, row]));
  return candidates.filter((event) => {
    const orderId = event.event_metadata?.order_id;
    if (!orderId) return true;
    const known = seen.get(orderId);
    if (known && (Number(known.quantity) !== Number(event.quantity) || Math.abs(Number(known.price) - Number(event.price)) > 1e-9)) {
      batchLog.warn("scrapeEmails", "directa", `order ${orderId} seen again with different numbers (${known.quantity} @ ${known.price} vs ${event.quantity} @ ${event.price}), kept the first.`);
    }
    if (known) return false;
    seen.set(orderId, event);
    return true;
  });
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
    batchLog.warn("scrapeEmails", label, "Gmail label not found, skipped.");
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
        attachments: parsed.attachments.map(({ filename, contentType, content }) => ({ filename, contentType, content })),
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

/**
 * Directa (broker): two kinds of email in the label, everything else ignored.
 * - "Conferma di accredito bonifico" -> INFLOW of "Importo" (English number format) on "Valuta" (dd/mm/yyyy)
 * - "Nota informativa <order>" -> the PDF note of an executed order: PURCHASE (Acquisto) or SALE (Vendita, and
 *   Liquidazione = redemption at maturity) on the execution date, quantity summed over the fills, price = Controvalore /
 *   quantity, fees_override = Commissioni, event_metadata { order_id, tax_withheld = Ritenuta (capital gain tax
 *   on sales) }. The PDF names the security by ISIN only: mapped with DIRECTA_ISINS (unknown ISIN = unparsed + warning).
 * Forwarded copies ("Fwd: ...", sent by the user to others) return null: ignored, not counted as unparsed.
 *
 * @returns {Array<Object>|null} events
 */
export function parseDirecta(email, portfolioId) {
  // ISIN -> security_id of the securities traded on Directa (add new ones here)
  const DIRECTA_ISINS = {
    CH1322071304: "CH1322071304",
    CH1325429418: "CH1325429418",
    IE00BK5BQT80: "VWCE",
    DE000A0H0728: "EXXY",
    IE00BL25JP72: "XDEM",
    LU0478205379: "XBLC",
    IE00BF540Z61: "GFA",
    IE00BP3QZ601: "IS3Q",
    IE00B1XNHC34: "INRG",
    IE00BMW3QX54: "ROBO",
    IE000YU9K6K2: "JEDI",
    IE000NDWFGA5: "URNU",
    IE00BYZK4776: "HEAL",
    IE0002PG6CA6: "REMX",
  };
  const subject = email.subject ?? "";
  if (/^\s*(fwd?|i)\s*:/i.test(subject)) return null;

  if (/accredito bonifico/i.test(subject)) {
    const amount = email.text.match(/Importo:\s*([\d.,]+)/)?.[1];
    const valueDate = email.text.match(/Valuta:\s*(\d\d)\/(\d\d)\/(\d{4})/);
    if (!amount || !valueDate) return [];
    return [{
      date: `${valueDate[3]}-${valueDate[2]}-${valueDate[1]}`,
      event_type: "INFLOW",
      portfolio_id: portfolioId,
      quantity: Number(amount.replace(/,/g, "")),
      event_metadata: {},
    }];
  }

  if (!/nota informativa/i.test(subject)) return null;
  const italian = (value) => Math.abs(Number((value ?? "0").replace(/\./g, "").replace(",", ".")));
  const events = [];
  for (const attachment of email.attachments.filter((a) => /pdf/i.test(a.contentType) || /\.pdf$/i.test(a.filename ?? ""))) {
    const text = utils.readPdfText(attachment.content);
    const order = text.match(/ordine (\w+)/)?.[1];
    const operation = text.match(/Tipo di Operazione:\s*(\w+)/)?.[1];
    const isin = text.match(/ISIN (\w{12})/)?.[1];
    const fills = [...text.matchAll(/(\d\d)\.(\d\d)\.(\d{4})\s+\S+\s+Eseguito(?: \([^)]*\))?\s+([\d.,]+)\s+([\d.,]+)/g)];
    const value = italian(text.match(/Controvalore:\s+(-?[\d.,]+)/)?.[1]);
    if (!order || !operation || !isin || fills.length === 0 || !value) continue;
    const securityId = DIRECTA_ISINS[isin];
    if (!securityId) {
      batchLog.warn("scrapeEmails", "directa", `unknown ISIN ${isin} (order ${order}), add it to DIRECTA_ISINS.`);
      continue;
    }
    const [, day, month, year] = fills[0];
    const quantity = fills.reduce((sum, fill) => sum + italian(fill[4]), 0);
    events.push({
      date: `${year}-${month}-${day}`,
      event_type: operation === "Acquisto" ? "PURCHASE" : "SALE",
      portfolio_id: portfolioId,
      security_id: securityId,
      quantity,
      price: value / quantity,
      fees_override: italian(text.match(/Commissioni:\s+(-?[\d.,]+)/)?.[1]),
      event_metadata: { order_id: order, tax_withheld: italian(text.match(/Ritenuta:\s*\*?\s+(-?[\d.,]+)/)?.[1]) },
    });
  }
  return events;
}
