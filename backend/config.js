// config.js (Root Level - Single Source of Truth)
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

  // Defaults
  date: new Date(),
};
