import { epochToIst, sessionBounds } from "../shared/market.ts";
import type { DB } from "./db.ts";

export interface Candle { ts: number; open: number; high: number; low: number; close: number; volume: number }
export interface Stock { symbol: string; name: string; sector: string; exchange: string; prev_close: number }

export type MarketState = "OPEN" | "PRE_OPEN" | "CLOSED" | "HOLIDAY" | "NO_DATA_YET" | "DATA_ENDED";
export interface MarketStatus { state: MarketState; isOpen: boolean; label: string; tradingDay: string | null }

export interface Quote {
  symbol: string;
  ltp: number;
  candleTs: number | null; // start of the candle the LTP comes from, null before the data starts
  prevClose: number;
  change: number;
  changePct: number;
  dayOpen: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  dayVolume: number;
}

/**
 * Read-only index over the market data held in SQLite. Candles never change while the
 * server runs, so they are read once and searched in memory.
 *
 * Price convention: a candle is labelled by its start time (as Kite and TradingView do),
 * and the price at simulated time T is the close of the latest candle that started at or
 * before T. That is the row a user would pick out of the CSV for that date and time.
 */
export class Market {
  readonly stocks: Stock[];
  readonly timeline: number[]; // every candle start, ascending, shared by all stocks
  readonly tradingDays: string[];
  private readonly candles = new Map<string, Candle[]>();
  private readonly dayStart = new Map<string, number[]>(); // per candle: index of its day's first candle
  private readonly stockBySymbol = new Map<string, Stock>();

  constructor(db: DB) {
    this.stocks = db.prepare("SELECT * FROM stocks ORDER BY symbol").all() as Stock[];
    const byStock = db.prepare("SELECT ts, open, high, low, close, volume FROM candles WHERE symbol = ? ORDER BY ts");
    for (const s of this.stocks) {
      this.stockBySymbol.set(s.symbol, s);
      const list = byStock.all(s.symbol) as Candle[];
      this.candles.set(s.symbol, list);
      const starts: number[] = [];
      list.forEach((c, i) => {
        const sameDay = i > 0 && epochToIst(list[i - 1].ts).date === epochToIst(c.ts).date;
        starts.push(sameDay ? starts[i - 1] : i);
      });
      this.dayStart.set(s.symbol, starts);
    }
    this.timeline = (db.prepare("SELECT DISTINCT ts FROM candles ORDER BY ts").all() as { ts: number }[]).map((r) => r.ts);
    this.tradingDays = [...new Set(this.timeline.map((ts) => epochToIst(ts).date))];
  }

  get firstTs() { return this.timeline[0]; }
  get lastTs() { return this.timeline[this.timeline.length - 1]; }
  /** The simulated clock can run from the first open to the last close. */
  get range() {
    return { start: this.firstTs, end: sessionBounds(this.tradingDays[this.tradingDays.length - 1]).close };
  }

  stock(symbol: string): Stock | undefined { return this.stockBySymbol.get(symbol); }
  candlesOf(symbol: string): Candle[] { return this.candles.get(symbol) ?? []; }

  /** Index of the latest candle that started at or before `at`, or -1. */
  indexAt(symbol: string, at: number): number {
    const list = this.candlesOf(symbol);
    let lo = 0;
    let hi = list.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].ts <= at) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return found;
  }

  priceAt(symbol: string, at: number): number {
    const i = this.indexAt(symbol, at);
    return i < 0 ? this.stock(symbol)!.prev_close : this.candlesOf(symbol)[i].close;
  }

  /** Close of the session before the one `at` belongs to. Used for day change. */
  prevCloseAt(symbol: string, at: number): number {
    const i = this.indexAt(symbol, at);
    if (i < 0) return this.stock(symbol)!.prev_close;
    const first = this.dayStart.get(symbol)![i];
    return first === 0 ? this.stock(symbol)!.prev_close : this.candlesOf(symbol)[first - 1].close;
  }

  quote(symbol: string, at: number): Quote {
    const stock = this.stock(symbol)!;
    const list = this.candlesOf(symbol);
    const i = this.indexAt(symbol, at);
    if (i < 0) {
      return { symbol, ltp: stock.prev_close, candleTs: null, prevClose: stock.prev_close, change: 0, changePct: 0, dayOpen: null, dayHigh: null, dayLow: null, dayVolume: 0 };
    }
    const first = this.dayStart.get(symbol)![i];
    const today = list.slice(first, i + 1);
    const prevClose = this.prevCloseAt(symbol, at);
    const ltp = list[i].close;
    return {
      symbol,
      ltp,
      candleTs: list[i].ts,
      prevClose,
      change: ltp - prevClose,
      changePct: ((ltp - prevClose) / prevClose) * 100,
      dayOpen: today[0].open,
      dayHigh: Math.max(...today.map((c) => c.high)),
      dayLow: Math.min(...today.map((c) => c.low)),
      dayVolume: today.reduce((n, c) => n + c.volume, 0),
    };
  }

  status(at: number): MarketStatus {
    const { date, weekday } = epochToIst(at);
    const range = this.range;
    if (at < range.start) {
      return { state: "NO_DATA_YET", isOpen: false, label: "Before the data starts", tradingDay: null };
    }
    if (at >= range.end) {
      return { state: "DATA_ENDED", isOpen: false, label: "Closed. Data ends here", tradingDay: null };
    }
    if (!this.tradingDays.includes(date)) {
      const label = weekday === 0 || weekday === 6 ? "Closed. Weekend" : "Closed. Exchange holiday";
      return { state: "HOLIDAY", isOpen: false, label, tradingDay: null };
    }
    const { open, close } = sessionBounds(date);
    if (at < open) return { state: "PRE_OPEN", isOpen: false, label: "Opens at 09:15", tradingDay: date };
    if (at >= close) return { state: "CLOSED", isOpen: false, label: "Closed at 15:30", tradingDay: date };
    return { state: "OPEN", isOpen: true, label: "Market open", tradingDay: date };
  }
}
