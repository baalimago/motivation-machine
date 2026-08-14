CREATE TABLE IF NOT EXISTS visits (
    day   date PRIMARY KEY,
    total bigint NOT NULL DEFAULT 0
);
