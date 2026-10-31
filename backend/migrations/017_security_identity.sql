-- 017: security_id is the user's internal name only (user, 2026-10-31): renames cascade everywhere, external calls use
-- source / source_id / isin. New securities are auto-created from the events / importers and flagged for review.

-- 1. External identifier + review flag
ALTER TABLE security_master ADD COLUMN IF NOT EXISTS isin TEXT;
ALTER TABLE security_master ADD COLUMN IF NOT EXISTS reviewed BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE security_master ADD COLUMN IF NOT EXISTS review_note TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS security_master_isin_key ON security_master (isin) WHERE isin IS NOT NULL;
COMMENT ON COLUMN security_master.isin IS 'ISIN (external identifier): Directa / Trade Republic resolve securities by it';
COMMENT ON COLUMN security_master.reviewed IS 'false = auto-created by the engine, to be curated by the user (QC checkSecuritiesToReview)';
COMMENT ON COLUMN security_master.review_note IS 'Where an auto-created security came from and what the providers returned';

-- 2. Every reference to security_id cascades on rename (these 4 blocked it)
ALTER TABLE open_lots DROP CONSTRAINT IF EXISTS open_lots_security_id_fkey;
ALTER TABLE open_lots ADD CONSTRAINT open_lots_security_id_fkey
  FOREIGN KEY (security_id) REFERENCES security_master(security_id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE closed_lots DROP CONSTRAINT IF EXISTS closed_lots_security_id_fkey;
ALTER TABLE closed_lots ADD CONSTRAINT closed_lots_security_id_fkey
  FOREIGN KEY (security_id) REFERENCES security_master(security_id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE security_income DROP CONSTRAINT IF EXISTS security_income_security_id_fkey;
ALTER TABLE security_income ADD CONSTRAINT security_income_security_id_fkey
  FOREIGN KEY (security_id) REFERENCES security_master(security_id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE security_master DROP CONSTRAINT IF EXISTS security_master_price_proxy_fkey;
ALTER TABLE security_master ADD CONSTRAINT security_master_price_proxy_fkey
  FOREIGN KEY (price_proxy) REFERENCES security_master(security_id) ON UPDATE CASCADE ON DELETE SET NULL;

-- 3. Events: raw identifier as it arrived (ISIN, code, anything); processing resolves it into security_id (FK, cascades)
ALTER TABLE events ADD COLUMN IF NOT EXISTS security_ref TEXT;
COMMENT ON COLUMN events.security_ref IS 'Raw security identifier from the source (ISIN, ticker, code): resolved into security_id when processed';

-- 4. New crypto / stablecoin currencies create their security with source CMC (prices from CoinMarketCap)
CREATE OR REPLACE FUNCTION sync_currency_to_security_master()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.type = 'FIAT' THEN
        INSERT INTO security_master (
            security_id, security_description, asset_type, currency,
            valuation_frequency, source, asset_class, asset_classification,
            region, italy_exposure
        ) VALUES (
            'CASH_' || NEW.currency_code, NEW.currency_name || ' Cash', 'CASH', NEW.currency_code,
            'DLY', NULL, 'Liquidity', 'Liquidity', 'No Region', FALSE
        )
        ON CONFLICT (security_id) DO NOTHING;
    ELSIF NEW.type IN ('CRYPTO', 'STABLECOIN') THEN
        INSERT INTO security_master (
            security_id, security_description, asset_type, currency,
            valuation_frequency, source, asset_class, asset_classification,
            region, italy_exposure
        ) VALUES (
            NEW.currency_code, coalesce(NEW.currency_name, NEW.currency_code), 'CRYPTO', NEW.currency_code,
            'DLY', 'CMC', 'Alternatives', 'Alternative Cryptocurrencies', 'No Region', FALSE
        )
        ON CONFLICT (security_id) DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 5. Data: crypto prices come from CoinMarketCap (source_id = CMC id); Allianz lines are matched on their line name
UPDATE security_master SET source = 'CMC' WHERE asset_type = 'CRYPTO' AND source IS DISTINCT FROM 'CMC';
UPDATE security_master SET source = 'ALLIANZ', source_id = v.line
FROM (VALUES
  ('ALLIANZ_AZIONARIA', 'LINEA AZIONARIA'),
  ('ALLIANZ_BILANCIATA', 'LINEA BILANCIATA'),
  ('ALLIANZ_MULTIASSET', 'LINEA MULTIASSET'),
  ('ALLIANZ_OBBLT', 'LINEA OBBLIGAZIONARIA LUNGO TERMINE'),
  ('ALLIANZ_OBBST', 'LINEA OBBLIGAZIONARIA BREVE TERMINE'),
  ('ALLIANZ_FLESSIBILE', 'LINEA FLESSIBILE')
) AS v(security_id, line)
WHERE security_master.security_id = v.security_id;

-- 6. ISINs confirmed by the user (2026-10-31): ISIN-shaped ids, the Directa map, EODHD matches checked by hand
UPDATE security_master SET isin = security_id
WHERE security_id ~ '^[A-Z]{2}[A-Z0-9]{9}[0-9]$' AND isin IS NULL;
UPDATE security_master SET isin = v.isin
FROM (VALUES
  ('VWCE', 'IE00BK5BQT80'), ('EXXY', 'DE000A0H0728'), ('XDEM', 'IE00BL25JP72'), ('XBLC', 'LU0478205379'),
  ('GFA', 'IE00BF540Z61'), ('IS3Q', 'IE00BP3QZ601'), ('INRG', 'IE00B1XNHC34'), ('ROBO', 'IE00BMW3QX54'),
  ('JEDI', 'IE000YU9K6K2'), ('URNU', 'IE000NDWFGA5'), ('HEAL', 'IE00BYZK4776'), ('REMX', 'IE0002PG6CA6'),
  ('XEON', 'LU0290358497'), ('DBXI', 'LU0274212538'), ('EUNA', 'IE00BDBRDM35'), ('EUNH', 'IE00B4WXJJ64'),
  ('V40A', 'IE00BMVB5M21'), ('V80A', 'IE00BMVB5R75'), ('IUSN', 'IE00BF4RFH31'), ('IUSQ', 'IE00B6R52259'),
  ('S0LR', 'IE00BM8QRZ79')
) AS v(security_id, isin)
WHERE security_master.security_id = v.security_id;

-- 7. Allianz ledger keys: <date>:<line name> instead of <date>:<security_id> (a rename would re-import the history)
UPDATE transactions t SET external_id = split_part(t.external_id, ':', 1) || ':' || s.source_id
FROM security_master s
WHERE t.source = 'ALLIANZ' AND s.security_id = t.security_id AND s.source = 'ALLIANZ'
  AND t.external_id = split_part(t.external_id, ':', 1) || ':' || t.security_id;
