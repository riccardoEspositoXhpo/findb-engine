-- Migration 007: Replace blocks as table "smart comments"
-- A replace block is the set of rows that replaceDataInDb rewrites as a whole: it deletes every existing row of each
-- block present in the incoming data, then inserts the new rows (so a security sold off a portfolio-day disappears).
-- Tables without a replace_block keep plain UPSERT by PK (block = one row).
-- Format: COMMENT ON TABLE <table> IS '{"replace_block": [<columns>]}', columns must be a strict subset of the PK.
-- Origin: GAS SHEET_KEYS[sheet].replacement where it differs from the duplicates key.
--
-- Deliberately WITHOUT a block:
--   fx_rates: GAS replaced by DATE per sheet, but fiat and crypto lived in separate sheets. Here they share one table and
--   are written by different functions, so a (date) block would make the crypto write wipe the fiat rates of the day.

-- positions: whole portfolio-day (GAS replacement DATE, PORTFOLIO_ID)
COMMENT ON TABLE public.positions IS '{"replace_block": ["date", "portfolio_id"]}';

-- breakdowns: whole sector set of a breakdown brick (GAS replacement START_DATE, <ID>, BREAKDOWN)
COMMENT ON TABLE public.lookthrough_data IS '{"replace_block": ["start_date", "security_id", "breakdown"]}';
COMMENT ON TABLE public.security_breakdowns IS '{"replace_block": ["start_date", "security_id", "breakdown"]}';
COMMENT ON TABLE public.portfolio_breakdowns IS '{"replace_block": ["start_date", "portfolio_id", "breakdown"]}';
COMMENT ON TABLE public.aggregate_breakdowns IS '{"replace_block": ["start_date", "aggregate_id", "breakdown"]}';

-- risk: GAS stored one wide row per (DATE, ID) with a column per metric; long format makes that row a block of metrics
COMMENT ON TABLE public.security_risk IS '{"replace_block": ["security_id", "date"]}';
COMMENT ON TABLE public.portfolio_risk IS '{"replace_block": ["portfolio_id", "date"]}';
COMMENT ON TABLE public.aggregate_risk IS '{"replace_block": ["aggregate_id", "date"]}';

-- Sanity check: every replace_block must be a strict subset of its table's PK
DO $$
DECLARE
    r RECORD;
    block_columns TEXT[];
    pk_columns TEXT[];
BEGIN
    FOR r IN (
        SELECT c.relname AS table_name, obj_description(c.oid, 'pg_class') AS comment
        FROM pg_class c
        WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
          AND obj_description(c.oid, 'pg_class') LIKE '{%replace_block%'
    ) LOOP
        block_columns := ARRAY(SELECT jsonb_array_elements_text(r.comment::jsonb -> 'replace_block'));
        pk_columns := ARRAY(
            SELECT a.attname::TEXT
            FROM pg_index i
            JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
            WHERE i.indrelid = ('public.' || r.table_name)::regclass AND i.indisprimary
        );
        IF NOT (block_columns <@ pk_columns AND cardinality(block_columns) < cardinality(pk_columns)) THEN
            RAISE EXCEPTION 'replace_block % on % is not a strict subset of PK %', block_columns, r.table_name, pk_columns;
        END IF;
    END LOOP;
END $$;
