// config.js (Root Level - Single Source of Truth)
// Force UTC on every machine (pg turns DATE columns into Dates at local midnight → off-by-one days outside UTC).
// Committed here, not in .env, so a fresh clone gets it. Node applies TZ changes at runtime.
process.env.TZ = "UTC";

export const config = {
  // Runtime flags
  dryRun: process.env.DRY_RUN === "true",
  debug: process.env.DEBUG === "true",
  isProduction: process.env.NODE_ENV === "production",

  // Database
  databaseUrl: process.env.DATABASE_URL,

  // Financial constants (ereditate da local.gs)
  reportingCurrency: process.env.REPORTING_CURRENCY || "EUR",

  // API Keys
  cmcApiKey: process.env.CMC_API_KEY || null,
  eodhdToken: process.env.EODHD_TOKEN || null,
  krakenApiKey: process.env.KRAKEN_API_KEY || null,
  krakenPrivateKey: process.env.KRAKEN_PRIVATE_KEY || null,

  // Defaults
  date: new Date(),

  // your email
  targetEmailRecipient: process.env.TARGET_EMAIL_RECIPIENT, // your Gmail: QC email to + from, IMAP login (scrapeEmails)
  smtpPassword: process.env.SMTP_PASS, // Gmail app password (works for SMTP and IMAP)
};
