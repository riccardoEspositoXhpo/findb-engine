CREATE OR REPLACE FUNCTION sync_currency_to_security_master()
RETURNS TRIGGER AS $$
BEGIN
    -- Handle FIAT currencies
    IF NEW.type = 'FIAT' THEN
        INSERT INTO security_master (
            security_id, security_description, asset_type, currency, 
            valuation_frequency, source, asset_class, asset_classification, 
            region, italy_exposure
        ) VALUES (
            'CASH_' || NEW.currency_code, 
            NEW.currency_name || ' Cash', 
            'CASH', 
            NEW.currency_code, 
            'DLY', 
            '', 
            'Liquidity', 
            'Liquidity', 
            'No Region', 
            FALSE
        )
        ON CONFLICT (security_id) DO NOTHING;

    -- Handle CRYPTO assets
    ELSIF NEW.type = 'CRYPTO' THEN
        INSERT INTO security_master (
            security_id, security_description, asset_type, currency, 
            valuation_frequency, source, asset_class, asset_classification, 
            region, italy_exposure
        ) VALUES (
            NEW.currency_code, 
            NEW.currency_name, 
            'CRYPTO', 
            NEW.currency_code, 
            'DLY', 
            '', 
            'Alternatives', 
            'Alternative Cryptocurrencies', 
            'No Region', 
            FALSE
        )
        ON CONFLICT (security_id) DO NOTHING;

    -- Handle STABLECOIN assets
    ELSIF NEW.type = 'STABLECOIN' THEN
        INSERT INTO security_master (
            security_id, security_description, asset_type, currency, 
            valuation_frequency, source, asset_class, asset_classification, 
            region, italy_exposure
        ) VALUES (
            NEW.currency_code, 
            NEW.currency_name, 
            'CRYPTO', 
            NEW.currency_code, 
            'DLY', 
            '', 
            'Alternatives', 
            'Alternative Cryptocurrencies', 
            'No Region', 
            FALSE
        )
        ON CONFLICT (security_id) DO NOTHING;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Re-attach trigger
DROP TRIGGER IF EXISTS trg_sync_currency_sec_master ON currencies;
CREATE TRIGGER trg_sync_currency_sec_master
    AFTER INSERT ON currencies
    FOR EACH ROW
    EXECUTE FUNCTION sync_currency_to_security_master();