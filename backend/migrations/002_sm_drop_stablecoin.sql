-- Migration 002: Drop stablecoin column from security_master
ALTER TABLE security_master DROP COLUMN IF EXISTS stablecoin;

