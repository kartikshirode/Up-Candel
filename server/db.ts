import Database from "better-sqlite3";
import { parse } from "csv-parse/sync";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type DB = Database.Database;

export const DATA_DIR = join(import.meta.dirname, "..", "data");
export const DEFAULT_STARTING_CASH = 10_00_000_00; // Rs 10 lakh, in paise

const SCHEMA = `
CREATE TABLE IF NOT EXISTS stocks (
  symbol      TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  sector      TEXT NOT NULL,
  exchange    TEXT NOT NULL,
  prev_close  INTEGER NOT NULL          -- paise, close of the session before the data starts
);

CREATE TABLE IF NOT EXISTS candles (
  symbol  TEXT NOT NULL REFERENCES stocks(symbol),
  ts      INTEGER NOT NULL,             -- candle start, epoch seconds
  open    INTEGER NOT NULL,             -- all prices in paise
  high    INTEGER NOT NULL,
  low     INTEGER NOT NULL,
  close   INTEGER NOT NULL,
  volume  INTEGER NOT NULL,
  PRIMARY KEY (symbol, ts)
);

CREATE TABLE IF NOT EXISTS account (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  name             TEXT NOT NULL,
  starting_cash    INTEGER NOT NULL,
  charges_enabled  INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS orders (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol       TEXT NOT NULL REFERENCES stocks(symbol),
  side         TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  type         TEXT NOT NULL CHECK (type IN ('MARKET', 'LIMIT')),
  qty          INTEGER NOT NULL CHECK (qty > 0),
  limit_price  INTEGER,
  status       TEXT NOT NULL CHECK (status IN ('OPEN', 'FILLED', 'CANCELLED', 'REJECTED')),
  placed_at    INTEGER NOT NULL,        -- simulated market time
  resolved_at  INTEGER,                 -- simulated time it filled, was cancelled or rejected
  reason       TEXT,
  note         TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS trades (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    INTEGER NOT NULL REFERENCES orders(id),
  symbol      TEXT NOT NULL REFERENCES stocks(symbol),
  side        TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  qty         INTEGER NOT NULL CHECK (qty > 0),
  price       INTEGER NOT NULL,         -- paise per share
  charges     INTEGER NOT NULL,         -- paise, total of the breakdown below
  charges_json TEXT NOT NULL,
  sim_time    INTEGER NOT NULL,
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS trades_by_time ON trades(sim_time, id);
CREATE INDEX IF NOT EXISTS orders_by_status ON orders(status, placed_at);
`;

const toPaise = (rupees: string) => Math.round(Number(rupees) * 100);

/**
 * Opens the database and reloads market data from the CSV files.
 * Stocks and candles are rebuilt on every start, so the CSVs stay the source of truth.
 * The account, orders and trades survive restarts when a file path is used.
 */
export function openDatabase(path = process.env.DB_PATH ?? join(import.meta.dirname, "..", "var", "up-candel.db"), dataDir = DATA_DIR): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  loadMarketData(db, dataDir);
  db.prepare("INSERT OR IGNORE INTO account (id, name, starting_cash, charges_enabled) VALUES (1, ?, ?, 1)")
    .run("Demo Trader", DEFAULT_STARTING_CASH);
  return db;
}

function loadMarketData(db: DB, dataDir: string) {
  const stocks = parse(readFileSync(join(dataDir, "stocks.csv")), { columns: true, trim: true, skip_empty_lines: true }) as Record<string, string>[];

  const upsertStock = db.prepare(`
    INSERT INTO stocks (symbol, name, sector, exchange, prev_close) VALUES (@symbol, @name, @sector, @exchange, @prev_close)
    ON CONFLICT(symbol) DO UPDATE SET name = excluded.name, sector = excluded.sector, exchange = excluded.exchange, prev_close = excluded.prev_close`);
  const insertCandle = db.prepare("INSERT INTO candles (symbol, ts, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?)");

  db.transaction(() => {
    db.exec("DELETE FROM candles");
    for (const s of stocks) {
      upsertStock.run({ ...s, prev_close: toPaise(s.prev_close) });
      const rows = parse(readFileSync(join(dataDir, "prices", `${s.symbol}.csv`)), { columns: true, trim: true, skip_empty_lines: true }) as Record<string, string>[];
      for (const r of rows) {
        const ts = Date.parse(r.timestamp) / 1000;
        if (!Number.isFinite(ts)) throw new Error(`Bad timestamp "${r.timestamp}" in ${s.symbol}.csv`);
        insertCandle.run(s.symbol, ts, toPaise(r.open), toPaise(r.high), toPaise(r.low), toPaise(r.close), Number(r.volume));
      }
    }
  })();
}
