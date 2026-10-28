-- Migration 015: price proxies (user, 2026-10-29)
-- 1. security_master.price_proxy: a security whose own (official) prices are too sparse is moved between them by
--    another security's price (marketData.calculateProxyPrices): price(d) = last official price x proxy(d) /
--    proxy(official date). Like risk_proxy, one column per purpose (a breakdown_proxy may follow).
-- 2. prices.source: who wrote the price (YAHOO, EODHD, ALLIANZ, OFFICIAL...; NULL = before this column, from GAS or
--    the first engine runs). PROXY rows are derived: they are never used as anchors and are rewritten every run.
-- 3. ALLIANZ_AZIONARIA_YH / ALLIANZ_BILANCIATA_YH: the Allianz Insieme class Yahoo carries for these two lines (not
--    the user's: 4.5% / 1.0% apart, ~0.3% a year in return), price proxies of the user's lines, which keep only the
--    official unit values (Allianz export / site).

ALTER TABLE public.security_master ADD COLUMN IF NOT EXISTS price_proxy TEXT REFERENCES public.security_master(security_id);
ALTER TABLE public.prices ADD COLUMN IF NOT EXISTS source TEXT;

INSERT INTO public.security_master (security_id, security_description, risk_proxy, currency, valuation_frequency, source, source_id,
  price_pct, exchange, market, italy_exposure, asset_type, asset_class, region, asset_classification)
SELECT security_id || '_YH', security_description || ' (Yahoo class, price proxy)', risk_proxy, currency, 'DLY', 'YAHOO', source_id,
  price_pct, exchange, market, italy_exposure, asset_type, asset_class, region, asset_classification
FROM public.security_master WHERE security_id IN ('ALLIANZ_AZIONARIA', 'ALLIANZ_BILANCIATA')
ON CONFLICT (security_id) DO NOTHING;

UPDATE public.security_master SET price_proxy = security_id || '_YH' WHERE security_id IN ('ALLIANZ_AZIONARIA', 'ALLIANZ_BILANCIATA');
