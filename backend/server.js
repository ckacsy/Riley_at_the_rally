// Migration file code

// ... other migration code ...

-- Adding `updated_at` column with no default
ALTER TABLE your_table_name ADD COLUMN updated_at TEXT;

-- Backfill `updated_at` for existing rows
UPDATE your_table_name SET updated_at = CURRENT_TIMESTAMP;

-- Ensure `created_at` default only in CREATE TABLE
CREATE TABLE your_table_name (
    id INTEGER PRIMARY KEY,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    -- other columns...
);

// ... rest of the migration code...