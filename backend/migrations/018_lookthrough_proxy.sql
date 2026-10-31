-- 018: lookthrough (user, 2026-10-31): a fallback proxy per security, and the monthly lookthrough feed (monthlyBatch,
-- src/lookthrough.js) with its provenance on every row.

-- 1. Proxy: a security without lookthrough data takes the _LT breakdowns of another one (breakdowns.js)
ALTER TABLE security_master ADD COLUMN IF NOT EXISTS lookthrough_proxy TEXT;
ALTER TABLE security_master DROP CONSTRAINT IF EXISTS security_master_lookthrough_proxy_fkey;
ALTER TABLE security_master ADD CONSTRAINT security_master_lookthrough_proxy_fkey
  FOREIGN KEY (lookthrough_proxy) REFERENCES security_master(security_id) ON UPDATE CASCADE ON DELETE SET NULL;
COMMENT ON COLUMN security_master.lookthrough_proxy IS 'Security whose lookthrough (_LT) breakdowns are used when this one has no lookthrough data';

-- 2. Issuer holdings file of a fund (like source / source_id for prices); NULL = the generic sources by ISIN
-- (Yahoo, FT, fondsweb), OFF = no lookthrough (swap ETFs: the files list the collateral, the attributes are right)
ALTER TABLE security_master ADD COLUMN IF NOT EXISTS lookthrough_source TEXT;
ALTER TABLE security_master ADD COLUMN IF NOT EXISTS lookthrough_source_id TEXT;
COMMENT ON COLUMN security_master.lookthrough_source IS 'Issuer holdings feed: ISHARES / XTRACKERS / VANGUARD, OFF = no lookthrough, NULL = generic sources by ISIN';
COMMENT ON COLUMN security_master.lookthrough_source_id IS 'Issuer product id (iShares product number, Vanguard page path); Xtrackers uses the ISIN';

-- 3. Provenance of the lookthrough rows: NULL = static rows from GAS
ALTER TABLE lookthrough_data ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE lookthrough_data ADD COLUMN IF NOT EXISTS as_of DATE;
COMMENT ON COLUMN lookthrough_data.source IS 'Sources the shape was built from (ISHARES, YAHOO+FT, ...); NULL = static (GAS)';
COMMENT ON COLUMN lookthrough_data.as_of IS 'Oldest as-of date of the source data (portfolio date published by the provider)';

-- 4. Feeds of the funds held (2026-10-31)
UPDATE security_master SET lookthrough_source = v.source, lookthrough_source_id = v.source_id
FROM (VALUES
  ('IUSQ', 'ISHARES', '251850'),
  ('IUSN', 'ISHARES', '296576'),
  ('IS3Q', 'ISHARES', '270054'),
  ('INRG', 'ISHARES', '251911'),
  ('HEAL', 'ISHARES', '284216'),
  ('IE0008UEVOE0', 'ISHARES', '332876'),
  ('XDEM', 'XTRACKERS', NULL),
  ('VWCE', 'VANGUARD', '9679/ftse-all-world-ucits-etf-usd-accumulating'),
  ('XEON', 'OFF', NULL),
  ('EXXY', 'OFF', NULL)
) AS v(security_id, source, source_id)
WHERE security_master.security_id = v.security_id;
