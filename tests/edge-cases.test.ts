import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../server/app.ts";
import { computeCharges, type ChargeBreakdown } from "../shared/charges.ts";
import { openDatabase, type DB } from "../server/db.ts";
import { Engine, TradeError } from "../server/engine.ts";
import { Market, type Candle } from "../server/market.ts";
import { CANDLE_SECONDS, CANDLE_STARTS, epochToIst, roundToTick, sessionBounds, tickPaise } from "../shared/market.ts";
import { afterEnd, day, HOLIDAYS, ist, t, TRADING_DAYS, WEEKENDS } from "./helpers.ts";
const START = 10_00_000_00;

let db: DB;
let engine: Engine;
let market: Market;

beforeEach(() => {
  db = openDatabase(":memory:");
  market = new Market(db);
  engine = new Engine(db, market);
  engine.reset(START, false); // charges off unless a test turns them on
});

function expectTradeError(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(TradeError);
    expect((e as TradeError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

const buy = (symbol: string, qty: number, at: number) => engine.placeOrder({ symbol, side: "BUY", type: "MARKET", qty, at });
const sell = (symbol: string, qty: number, at: number) => engine.placeOrder({ symbol, side: "SELL", type: "MARKET", qty, at });

/** Candles of `symbol` that start strictly after `ts`. */
const candlesAfter = (symbol: string, ts: number) => market.candlesOf(symbol).filter((c) => c.ts > ts);

/** First candle after `ts` whose range reaches `limit` for the given side. */
function firstTouch(symbol: string, ts: number, limit: number, side: "BUY" | "SELL"): Candle | undefined {
  return candlesAfter(symbol, ts).find((c) => (side === "BUY" ? c.low <= limit : c.high >= limit));
}

const snapshot = () => JSON.stringify({
  orders: db.prepare("SELECT * FROM orders ORDER BY id").all(),
  trades: db.prepare("SELECT * FROM trades ORDER BY id").all(),
  account: db.prepare("SELECT * FROM account").all(),
});

const sum = (xs: number[]) => xs.reduce((n, x) => n + x, 0);

/** Every accounting identity the app promises, checked as of `at`. */
function checkInvariants(at: number) {
  const p = engine.portfolio(at);
  const s = p.summary;
  const start = p.account.startingCash;
  expect(Number.isInteger(s.cash)).toBe(true);
  expect(s.cash).toBeGreaterThanOrEqual(0);
  expect(s.availableCash).toBeGreaterThanOrEqual(0);
  for (const h of p.holdings) {
    expect(Number.isInteger(h.qty)).toBe(true);
    expect(h.qty).toBeGreaterThan(0);
    expect(h.invested).toBeGreaterThan(0);
  }
  expect(s.netWorth - start).toBe(s.realizedPnl + s.unrealizedPnl - s.charges);
  expect(s.totalPnl).toBe(s.netWorth - start);

  const history = engine.tradeHistory(at);
  expect(start + sum(history.map((h) => h.netAmount))).toBe(s.cash);
  expect(sum(history.map((h) => h.charges))).toBe(s.charges);
  expect(sum(history.map((h) => h.realizedPnl ?? 0))).toBe(s.realizedPnl);

  // Replaying quantities trade by trade never goes below zero and ends at the holdings shown.
  const qty = new Map<string, number>();
  for (const h of [...history].reverse()) {
    const next = (qty.get(h.symbol) ?? 0) + (h.side === "BUY" ? h.qty : -h.qty);
    expect(next).toBeGreaterThanOrEqual(0);
    qty.set(h.symbol, next);
  }
  for (const h of p.holdings) expect(qty.get(h.symbol)).toBe(h.qty);
  expect([...qty.values()].filter((q) => q > 0)).toHaveLength(p.holdings.length);

  const perf = engine.performance(at);
  expect(perf.curve.at(-1)!.netWorth).toBe(s.netWorth);
  expect(perf.stats.totalCharges).toBe(s.charges);
  expect(perf.stats.tradeCount).toBe(history.length);
  return p;
}

describe("clock boundaries", () => {
  it("opens at exactly 09:15 and prices off the first candle of the day", () => {
    const at = t(1, "09:15");
    expect(market.status(at)).toMatchObject({ state: "OPEN", isOpen: true, tradingDay: day(1) });
    const first = market.candlesOf("TCS").find((c) => c.ts === at)!;
    expect(market.priceAt("TCS", at)).toBe(first.close);
    expect(buy("TCS", 1, at).fillPrice).toBe(first.close);
  });

  it("is still open at 15:29:59 and fills at the 15:15 close", () => {
    const at = t(1, "15:30") - 1;
    expect(market.status(at).isOpen).toBe(true);
    expect(buy("INFY", 2, at).fillPrice).toBe(market.priceAt("INFY", t(1, "15:15")));
  });

  it("is closed at exactly 15:30", () => {
    const at = t(1, "15:30");
    expect(market.status(at).state).toBe("CLOSED");
    expectTradeError(() => buy("INFY", 1, at), "MARKET_CLOSED");
  });

  it("is pre-open at 09:14:59 and still quotes yesterday's last close", () => {
    const at = t(1, "09:15") - 1;
    expect(market.status(at)).toMatchObject({ state: "PRE_OPEN", isOpen: false, tradingDay: day(1) });
    expect(market.priceAt("SBIN", at)).toBe(market.priceAt("SBIN", t(0, "15:15")));
    expectTradeError(() => buy("SBIN", 1, at), "MARKET_CLOSED");
  });

  it("reports no data before the first candle and uses the previous close", () => {
    const at = t(0, "09:15") - 1;
    expect(market.status(at).state).toBe("NO_DATA_YET");
    const q = market.quote("RELIANCE", at);
    expect(q).toMatchObject({ ltp: 124000, prevClose: 124000, candleTs: null, change: 0, dayVolume: 0 });
    expectTradeError(() => buy("RELIANCE", 1, at), "MARKET_CLOSED");
    expect(engine.performance(at).curve).toHaveLength(0);
    expect(engine.performance(at).stats.portfolioReturnPct).toBe(0);
  });

  it("is closed on weekends and on the exchange holiday", () => {
    for (const date of WEEKENDS) {
      for (const time of ["09:15", "12:00", "15:00"]) {
        const at = ist(date, time);
        expect(market.status(at)).toMatchObject({ state: "HOLIDAY", isOpen: false, tradingDay: null });
        expect(market.status(at).label).toMatch(/Weekend/);
        expectTradeError(() => buy("ITC", 1, at), "MARKET_CLOSED");
      }
    }
    const holiday = ist(HOLIDAYS[0], "10:15"); // Fri 2 Oct 2026, Gandhi Jayanti
    expect(market.status(holiday).label).toMatch(/holiday/);
    expectTradeError(() => buy("ITC", 1, holiday), "MARKET_CLOSED");
    // The holiday carries the price of the session before it, and the next session's day
    // change is measured from that same close.
    const before = TRADING_DAYS.filter((d) => d < HOLIDAYS[0]).length - 1;
    expect(market.priceAt("ITC", holiday)).toBe(market.priceAt("ITC", t(before, "15:15")));
    expect(market.prevCloseAt("ITC", t(before + 1, "09:15"))).toBe(market.priceAt("ITC", t(before, "15:15")));
  });

  it("ends the data at the last session's 15:30 and keeps the last close after that", () => {
    const lastClose = market.priceAt("LT", t(-1, "15:15"));
    expect(market.range.end).toBe(t(-1, "15:30"));
    expect(market.status(t(-1, "15:30") - 1).isOpen).toBe(true);
    for (const at of [t(-1, "15:30"), afterEnd(1, "10:15"), afterEnd(9, "12:00")]) {
      expect(market.status(at).state).toBe("DATA_ENDED");
      expect(market.priceAt("LT", at)).toBe(lastClose);
      expectTradeError(() => buy("LT", 1, at), "MARKET_CLOSED");
    }
  });

  it("switches candles exactly at the candle start, not before", () => {
    const c1015 = market.candlesOf("HDFCBANK").find((c) => c.ts === t(2, "10:15"))!;
    const c1045 = market.candlesOf("HDFCBANK").find((c) => c.ts === t(2, "10:45"))!;
    expect(market.priceAt("HDFCBANK", t(2, "10:45") - 1)).toBe(c1015.close);
    expect(market.priceAt("HDFCBANK", t(2, "10:45"))).toBe(c1045.close);
    expect(market.quote("HDFCBANK", t(2, "10:44")).candleTs).toBe(c1015.ts);
  });

  it("quotes the first candle's volume alone at the open", () => {
    const first = market.candlesOf("ITC").find((c) => c.ts === t(2, "09:15"))!;
    expect(market.quote("ITC", t(2, "09:15"))).toMatchObject({ dayVolume: first.volume, dayOpen: first.open, dayHigh: first.high, dayLow: first.low });
  });

  it("shows the last session's change over a weekend", () => {
    const q = market.quote("TCS", ist(WEEKENDS[0], "12:00"));
    expect(q.ltp).toBe(market.priceAt("TCS", t(3, "15:15")));
    expect(q.prevClose).toBe(market.priceAt("TCS", t(2, "15:15")));
    expect(q.candleTs).toBe(t(3, "15:15"));
  });
});

describe("accounting invariants", () => {
  it("holds every identity through a long mixed sequence with charges toggled", () => {
    let seed = 20260901;
    const rand = (n: number) => { seed = (seed * 16807) % 2147483647; return seed % n; };
    const symbols = market.stocks.map((s) => s.symbol);
    engine.setChargesEnabled(true);
    let buys = 0;
    let sells = 0;

    for (let i = 0; i < 28; i++) {
      // Walk forward through the data, sometimes landing between candles.
      const at = market.timeline[3 + i * 6] + (i % 3 === 1 ? 7 * 60 : 0);
      if (i === 12) engine.setChargesEnabled(false);
      if (i === 20) engine.setChargesEnabled(true);
      const holdings = engine.portfolio(at).holdings;
      if (holdings.length > 0 && rand(3) === 0) {
        const h = holdings[rand(holdings.length)];
        const qty = rand(4) === 0 ? h.qty : 1 + rand(h.qty);
        expect(sell(h.symbol, qty, at).status).toBe("FILLED");
        sells++;
      } else {
        expect(buy(symbols[rand(symbols.length)], 1 + rand(40), at).status).toBe("FILLED");
        buys++;
      }
      checkInvariants(at);
    }

    expect(buys + sells).toBe(28);
    expect(sells).toBeGreaterThanOrEqual(5);
    const end = checkInvariants(t(-1, "15:15"));
    expect(end.summary.charges).toBeGreaterThan(0);
    // An earlier view of the same ledger satisfies the identities too.
    checkInvariants(t(6, "12:00"));
  });

  it("keeps the performance curve and portfolio in step between candles with charges on", () => {
    engine.setChargesEnabled(true);
    const at = t(1, "10:40"); // after the 10:15 candle, before the 10:45 one
    buy("RELIANCE", 50, at);
    const p = engine.portfolio(at);
    const perf = engine.performance(at);
    expect(perf.curve.at(-1)!.ts).toBe(t(1, "10:15"));
    expect(perf.curve.at(-1)!.netWorth).toBe(p.summary.netWorth);
    expect(perf.curve.at(-1)!.netWorth).toBe(START - p.summary.charges);
  });

  it("resets the average on a full exit and rebuy but keeps the realized P&L", () => {
    const a = t(0, "11:15");
    const b = t(1, "14:15");
    const c = t(3, "10:15");
    buy("SBIN", 10, a);
    buy("SBIN", 5, t(0, "13:15"));
    sell("SBIN", 15, b);
    const realized = engine.portfolio(b).summary.realizedPnl;
    expect(engine.portfolio(b).holdings).toHaveLength(0);
    expect(engine.portfolio(b).closedPositions).toEqual([{ symbol: "SBIN", realizedPnl: realized }]);

    buy("SBIN", 7, c);
    const pc = market.priceAt("SBIN", c);
    const p = engine.portfolio(c);
    expect(p.holdings[0]).toMatchObject({ symbol: "SBIN", qty: 7, avgPrice: pc, invested: 7 * pc, realizedPnl: realized });
    expect(p.summary.realizedPnl).toBe(realized);
    expect(p.closedPositions).toHaveLength(0);
    checkInvariants(c);
  });
});

describe("day's P&L", () => {
  it("uses the previous close for shares held from earlier days", () => {
    buy("INFY", 10, t(1, "10:15"));
    const at = t(2, "11:15");
    const q = market.quote("INFY", at);
    expect(engine.portfolio(at).holdings[0].dayPnl).toBe(10 * (q.ltp - q.prevClose));
  });

  it("uses the buy price for today's shares and sells older shares first", () => {
    buy("INFY", 10, t(1, "10:15"));
    const b = market.priceAt("INFY", t(2, "10:15"));
    buy("INFY", 5, t(2, "10:15"));
    sell("INFY", 8, t(2, "11:15")); // all 8 come out of the 10 older shares

    let at = t(2, "12:15");
    let q = market.quote("INFY", at);
    let p = engine.portfolio(at);
    expect(p.holdings[0].qty).toBe(7);
    expect(p.holdings[0].dayPnl).toBe(2 * (q.ltp - q.prevClose) + 5 * (q.ltp - b));
    expect(p.summary.dayPnl).toBe(p.holdings[0].dayPnl);

    sell("INFY", 5, t(2, "13:15")); // 2 older shares, then 3 of today's
    at = t(2, "14:15");
    q = market.quote("INFY", at);
    p = engine.portfolio(at);
    expect(p.holdings[0].qty).toBe(2);
    expect(p.holdings[0].dayPnl).toBe(2 * (q.ltp - b));
  });

  it("treats a same-day round trip as zero shares for day P&L", () => {
    buy("ITC", 20, t(2, "10:15"));
    sell("ITC", 20, t(2, "11:15"));
    expect(engine.portfolio(t(2, "12:15")).summary.dayPnl).toBe(0);
  });

  it("keeps the buy price as the basis after the close, over the weekend and before Monday's open", () => {
    // Bought at the last candle of Friday, so the LTP equals the buy price until Monday trades.
    buy("TCS", 10, t(3, "15:15"));
    for (const at of [t(3, "15:29"), t(3, "18:00"), ist(WEEKENDS[0], "12:00"), ist(WEEKENDS[1], "23:00"), t(4, "09:00")]) {
      expect(engine.portfolio(at).summary.dayPnl).toBe(0);
    }
    const q = market.quote("TCS", t(4, "09:15"));
    expect(q.prevClose).toBe(market.priceAt("TCS", t(3, "15:15")));
    expect(engine.portfolio(t(4, "09:15")).summary.dayPnl).toBe(10 * (q.ltp - q.prevClose));
  });
});

describe("limit order edge cases", () => {
  it("never fills a resting buy the price never reaches and keeps its cash blocked", () => {
    const at = t(0, "09:45");
    const symbol = market.stocks.map((s) => s.symbol).find((s) => {
      const limit = roundToTick(market.prevCloseAt(s, at) * 0.9, "up");
      return candlesAfter(s, at).every((c) => c.low > limit);
    })!;
    expect(symbol).toBeDefined();
    const limit = roundToTick(market.prevCloseAt(symbol, at) * 0.9, "up");
    const order = engine.placeOrder({ symbol, side: "BUY", type: "LIMIT", qty: 10, limitPrice: limit, at });
    expect(order.status).toBe("OPEN");

    const end = t(-1, "15:29");
    expect(engine.orderView(order.id, end)!.status).toBe("OPEN");
    expect(engine.orders(end)[0].status).toBe("OPEN");
    expect(engine.portfolio(end).summary.blockedForOrders).toBe(10 * limit);
    expect(engine.tradeHistory(end)).toHaveLength(0);
  });

  it("leaves an order placed at the last candle open for good", () => {
    for (const at of [t(-1, "15:15"), t(-1, "15:25")]) {
      const ltp = market.priceAt("HINDUNILVR", at);
      const order = engine.placeOrder({ symbol: "HINDUNILVR", side: "BUY", type: "LIMIT", qty: 1, limitPrice: roundToTick(ltp * 0.95, "up"), at });
      expect(order.status).toBe("OPEN");
      expect(engine.orders(afterEnd(9, "12:00")).find((o) => o.id === order.id)!.status).toBe("OPEN");
    }
  });

  it("fills several resting orders on one stock in time order, then by order id", () => {
    const at = t(0, "10:15");
    const ltp = market.priceAt("TCS", at);
    const minLow = Math.min(...candlesAfter("TCS", at).map((c) => c.low));
    const low = roundToTick(minLow + (ltp - minLow) * 0.3, "down");
    const high = roundToTick(minLow + (ltp - minLow) * 0.7, "down");
    expect(low).toBeGreaterThanOrEqual(market.prevCloseAt("TCS", at) * 0.9);

    const deep = engine.placeOrder({ symbol: "TCS", side: "BUY", type: "LIMIT", qty: 10, limitPrice: low, at });
    const shallowA = engine.placeOrder({ symbol: "TCS", side: "BUY", type: "LIMIT", qty: 10, limitPrice: high, at });
    const shallowB = engine.placeOrder({ symbol: "TCS", side: "BUY", type: "LIMIT", qty: 10, limitPrice: high, at });

    const touchHigh = firstTouch("TCS", at, high, "BUY")!;
    const touchLow = firstTouch("TCS", at, low, "BUY")!;
    expect(touchHigh.ts).toBeLessThan(touchLow.ts);

    const orders = engine.orders(t(-1, "15:15"));
    const byId = (id: number) => orders.find((o) => o.id === id)!;
    expect(byId(shallowA.id)).toMatchObject({ status: "FILLED", resolvedAt: touchHigh.ts, fillPrice: Math.min(high, touchHigh.open) });
    expect(byId(shallowB.id)).toMatchObject({ status: "FILLED", resolvedAt: touchHigh.ts, fillPrice: Math.min(high, touchHigh.open) });
    expect(byId(deep.id)).toMatchObject({ status: "FILLED", resolvedAt: touchLow.ts, fillPrice: Math.min(low, touchLow.open) });

    const fills = engine.tradeHistory(t(-1, "15:15")).reverse().map((h) => h.orderId);
    expect(fills).toEqual([shallowA.id, shallowB.id, deep.id]);
  });

  it("fills a resting sell at the limit or a better gap-up open", () => {
    const at = t(0, "10:15");
    buy("BHARTIARTL", 20, at);
    const ltp = market.priceAt("BHARTIARTL", at);
    const maxHigh = Math.max(...candlesAfter("BHARTIARTL", at).map((c) => c.high));
    const limit = Math.min(roundToTick(ltp + (maxHigh - ltp) * 0.5, "up"), roundToTick(market.prevCloseAt("BHARTIARTL", at) * 1.1, "down"));
    const order = engine.placeOrder({ symbol: "BHARTIARTL", side: "SELL", type: "LIMIT", qty: 20, limitPrice: limit, at });
    expect(order.status).toBe("OPEN");
    const touch = firstTouch("BHARTIARTL", at, limit, "SELL")!;
    const filled = engine.orders(touch.ts).find((o) => o.id === order.id)!;
    expect(filled).toMatchObject({ status: "FILLED", fillPrice: Math.max(limit, touch.open) });
    expect(engine.portfolio(touch.ts).holdings).toHaveLength(0);
  });

  it("reserves shares for a resting sell so a market sell of them is rejected", () => {
    const at = t(1, "10:15");
    buy("LT", 10, at);
    const limit = roundToTick(market.prevCloseAt("LT", at) * 1.09, "down");
    engine.placeOrder({ symbol: "LT", side: "SELL", type: "LIMIT", qty: 6, limitPrice: limit, at });
    expectTradeError(() => sell("LT", 5, at), "INSUFFICIENT_HOLDINGS");
    expectTradeError(() => engine.placeOrder({ symbol: "LT", side: "SELL", type: "LIMIT", qty: 5, limitPrice: limit, at }), "INSUFFICIENT_HOLDINGS");
    expect(sell("LT", 4, at).status).toBe("FILLED");
    expectTradeError(() => sell("LT", 1, at), "INSUFFICIENT_HOLDINGS");
  });

  it("rejects a resting buy at fill time when charges were switched on after the cash was spent", () => {
    // With a fixed charges setting the reservation makes this unreachable, so switching charges
    // on after spending the free cash is the only way to run short when the limit is reached.
    const at = t(0, "10:15");
    const ltp = market.priceAt("TCS", at);
    let limit = 0;
    let touch: Candle | undefined;
    for (let pct = 99; pct > 90 && !touch; pct--) {
      limit = roundToTick((ltp * pct) / 100, "down");
      const c = firstTouch("TCS", at, limit, "BUY");
      if (c && c.open > limit) touch = c; // no gap, so it would fill at exactly the limit
    }
    expect(touch).toBeDefined();

    const order = engine.placeOrder({ symbol: "TCS", side: "BUY", type: "LIMIT", qty: 250, limitPrice: limit, at });
    const itc = market.priceAt("ITC", at);
    buy("ITC", Math.floor(engine.portfolio(at).summary.availableCash / itc), at);
    expectTradeError(() => buy("ITC", 1, at), "INSUFFICIENT_FUNDS");
    const cash = engine.portfolio(at).summary.cash;
    expect(cash - 250 * limit).toBeLessThan(computeCharges("BUY", 250 * limit).total);

    engine.setChargesEnabled(true);
    const view = engine.orders(touch!.ts).find((o) => o.id === order.id)!;
    expect(view).toMatchObject({ status: "REJECTED", resolvedAt: touch!.ts, fillPrice: null });
    expect(view.reason).toMatch(/Not enough cash/);
    expect(engine.portfolio(touch!.ts).summary.cash).toBe(cash);
    expect(engine.portfolio(touch!.ts).summary.blockedForOrders).toBe(0);
  });

  it("refuses to cancel a filled order or one placed after the cancel time", () => {
    const at = t(1, "11:15");
    const filled = buy("ITC", 1, at);
    expectTradeError(() => engine.cancelOrder(filled.id, at), "NOT_OPEN");

    const later = t(1, "13:15");
    const resting = engine.placeOrder({ symbol: "ITC", side: "BUY", type: "LIMIT", qty: 1, limitPrice: roundToTick(market.priceAt("ITC", later) * 0.93, "up"), at: later });
    expectTradeError(() => engine.cancelOrder(resting.id, later - 60), "NOT_FOUND");
    expectTradeError(() => engine.cancelOrder(9999, later), "NOT_FOUND");
    expect(engine.cancelOrder(resting.id, later).status).toBe("CANCELLED");
    expectTradeError(() => engine.cancelOrder(resting.id, later + 60), "NOT_OPEN");
  });

  it("releases a cancelled order's cash and never fills it afterwards", () => {
    const at = t(0, "10:15");
    const ltp = market.priceAt("TCS", at);
    const limit = roundToTick(ltp * 0.99, "down");
    const touch = firstTouch("TCS", at, limit, "BUY")!;
    const order = engine.placeOrder({ symbol: "TCS", side: "BUY", type: "LIMIT", qty: 100, limitPrice: limit, at });
    expect(engine.portfolio(at).summary.availableCash).toBe(START - 100 * limit);

    const cancelAt = at + 60;
    expect(cancelAt).toBeLessThan(touch.ts);
    engine.cancelOrder(order.id, cancelAt);
    expect(engine.portfolio(cancelAt).summary.availableCash).toBe(START);
    // Seen from before the cancel it was still holding the cash.
    expect(engine.portfolio(at).summary.blockedForOrders).toBe(100 * limit);
    expect(engine.orders(t(-1, "15:15"))[0].status).toBe("CANCELLED");
    expect(engine.tradeHistory(t(-1, "15:15"))).toHaveLength(0);
  });
});

describe("forward-only trading", () => {
  it("allows another order at exactly the latest activity but not one second before", () => {
    const at = t(2, "11:15");
    buy("TCS", 1, at);
    expect(buy("TCS", 1, at).status).toBe("FILLED");
    expectTradeError(() => buy("TCS", 1, at - 1), "TIME_TRAVEL");
    expect(engine.latestActivity()).toBe(at);
  });

  it("applies the same rule to cancels", () => {
    const at = t(2, "10:15");
    const order = engine.placeOrder({ symbol: "ITC", side: "BUY", type: "LIMIT", qty: 1, limitPrice: roundToTick(market.priceAt("ITC", at) * 0.93, "up"), at });
    buy("SBIN", 1, t(2, "12:15"));
    expectTradeError(() => engine.cancelOrder(order.id, t(2, "11:15")), "TIME_TRAVEL");
    expect(engine.cancelOrder(order.id, t(2, "12:15")).status).toBe("CANCELLED");
    expect(engine.latestActivity()).toBe(t(2, "12:15"));
  });

  it("never changes the ledger when an earlier time is viewed", async () => {
    engine.setChargesEnabled(true);
    buy("RELIANCE", 10, t(1, "10:15"));
    const at = t(5, "11:15");
    engine.placeOrder({ symbol: "TCS", side: "BUY", type: "LIMIT", qty: 5, limitPrice: roundToTick(market.priceAt("TCS", at) * 0.95, "up"), at });
    sell("RELIANCE", 4, at);
    const before = snapshot();

    for (const view of [t(0, "09:00"), t(1, "10:15"), ist(WEEKENDS[0], "12:00"), t(5, "11:14")]) {
      engine.portfolio(view);
      engine.orders(view);
      engine.tradeHistory(view);
      engine.performance(view);
      engine.whatIf(t(0, "09:15"), view, 1_00_000_00);
    }
    const app = createApp(engine);
    await request(app).get(`/api/portfolio?at=${t(2, "10:15")}`).expect(200);
    await request(app).get(`/api/transactions?at=${t(2, "10:15")}&format=csv`).expect(200);
    expect(snapshot()).toBe(before);
  });

  it("shows a resting order as filled when looking ahead, without saving the fill", async () => {
    const at = t(0, "10:15");
    const limit = roundToTick(market.priceAt("TCS", at) * 0.99, "down");
    const touch = firstTouch("TCS", at, limit, "BUY")!;
    expect(touch.ts).toBeGreaterThan(t(0, "10:45"));
    const order = engine.placeOrder({ symbol: "TCS", side: "BUY", type: "LIMIT", qty: 1, limitPrice: limit, at });
    const before = snapshot();

    // Every view of a later time sees the fill...
    const later = t(-1, "15:15");
    expect(engine.orders(later).find((o) => o.id === order.id)!.status).toBe("FILLED");
    expect(engine.portfolio(later).holdings.find((h) => h.symbol === "TCS")!.qty).toBe(1);
    expect(engine.tradeHistory(later)).toHaveLength(1);
    expect(engine.performance(later).stats.tradeCount).toBe(1);
    await request(createApp(engine)).get(`/api/portfolio?at=${later}`).expect(200);

    // ...but nothing is written, so trading earlier is still allowed.
    expect(snapshot()).toBe(before);
    expect(engine.latestActivity()).toBe(at);
    expect(buy("ITC", 1, t(0, "10:45")).status).toBe("FILLED");
    expect(engine.orders(t(0, "10:45")).find((o) => o.id === order.id)!.status).toBe("OPEN");
  });

  it("saves a looked-ahead fill once you trade past it", () => {
    const at = t(0, "10:15");
    const limit = roundToTick(market.priceAt("TCS", at) * 0.99, "down");
    const touch = firstTouch("TCS", at, limit, "BUY")!;
    const order = engine.placeOrder({ symbol: "TCS", side: "BUY", type: "LIMIT", qty: 1, limitPrice: limit, at });
    engine.portfolio(t(-1, "15:15"));

    const after = engine.market.timeline.find((ts) => ts > touch.ts)!;
    buy("ITC", 1, after);
    expect(engine.orderView(order.id, after)!.status).toBe("FILLED");
    expect(engine.latestActivity()).toBe(after);
    expectTradeError(() => buy("ITC", 1, touch.ts - 60), "TIME_TRAVEL");
  });

  it("works out the same fills whether you look ahead or trade straight through", () => {
    const at = t(1, "10:15");
    const place = (e: typeof engine) => {
      e.placeOrder({ symbol: "TCS", side: "BUY", type: "LIMIT", qty: 5, limitPrice: roundToTick(e.market.priceAt("TCS", at) * 0.98, "down"), at });
      e.placeOrder({ symbol: "INFY", side: "BUY", type: "LIMIT", qty: 7, limitPrice: roundToTick(e.market.priceAt("INFY", at) * 0.985, "down"), at });
    };
    place(engine);
    const viewed = engine.portfolio(t(-1, "15:15")).summary;
    const committed = engine.tradeHistory(t(-1, "15:15"));

    buy("ITC", 1, t(-1, "15:15")); // commits everything up to the end
    const real = engine.portfolio(t(-1, "15:15"));
    const itc = real.holdings.find((h) => h.symbol === "ITC")!;
    expect(engine.tradeHistory(t(-1, "15:15")).length).toBe(committed.length + 1);
    expect(real.summary.netWorth).toBe(viewed.netWorth);
    expect(real.summary.invested).toBe(viewed.invested + itc.invested);
  });
});

describe("charges edge cases", () => {
  const partsTotal = (c: ChargeBreakdown) => c.brokerage + c.stt + c.exchange + c.sebi + c.stamp + c.gst + c.dp;

  it("applies charges only to trades placed while they are switched on", () => {
    const a = buy("HDFCBANK", 10, t(1, "10:15"));
    engine.setChargesEnabled(true);
    const b = buy("HDFCBANK", 10, t(1, "11:15"));
    engine.setChargesEnabled(false);
    const c = sell("HDFCBANK", 5, t(1, "12:15"));
    expect(a.charges).toBe(0);
    expect(b.charges).toBe(computeCharges("BUY", 10 * b.fillPrice!).total);
    expect(c.charges).toBe(0);
    const s = engine.portfolio(t(1, "12:15")).summary;
    expect(s.charges).toBe(b.charges);
    checkInvariants(t(1, "12:15"));
  });

  it("takes the DP charge once per stock per day, on the first sell", () => {
    engine.setChargesEnabled(true);
    buy("SBIN", 30, t(1, "10:15"));
    buy("ITC", 30, t(1, "10:15"));
    const dp = (o: { id: number }, at: number) => engine.tradeHistory(at).find((h) => h.orderId === o.id)!.chargesBreakdown.dp;
    const s1 = sell("SBIN", 10, t(2, "10:15"));
    const s2 = sell("SBIN", 10, t(2, "15:29"));
    const s3 = sell("ITC", 10, t(2, "15:29"));
    const s4 = sell("SBIN", 5, t(3, "09:15"));
    const end = t(3, "09:15");
    expect([dp(s1, end), dp(s2, end), dp(s3, end), dp(s4, end)]).toEqual([1534, 0, 1534, 1534]);
  });

  it("skips DP on a day's second sell even if the first was placed with charges off", () => {
    // Documents current behaviour: the rule looks at earlier sells, not at whether DP was billed.
    buy("SBIN", 20, t(1, "10:15"));
    sell("SBIN", 5, t(2, "10:15"));
    engine.setChargesEnabled(true);
    const second = sell("SBIN", 5, t(2, "11:15"));
    const h = engine.tradeHistory(t(2, "11:15")).find((x) => x.orderId === second.id)!;
    expect(h.chargesBreakdown.dp).toBe(0);
    expect(h.charges).toBeGreaterThan(0);
  });

  it("stores a breakdown that adds up to the charged total on every trade", () => {
    engine.setChargesEnabled(true);
    buy("LT", 7, t(1, "10:15"));
    buy("ITC", 1, t(1, "11:15"));
    sell("LT", 3, t(2, "10:15"));
    sell("ITC", 1, t(2, "11:15"));
    const history = engine.tradeHistory(t(2, "11:15"));
    expect(history).toHaveLength(4);
    for (const h of history) {
      expect(partsTotal(h.chargesBreakdown)).toBe(h.chargesBreakdown.total);
      expect(h.chargesBreakdown.total).toBe(h.charges);
      expect(Object.values(h.chargesBreakdown).every(Number.isInteger)).toBe(true);
    }
  });

  it("rounds each line on a one-share ITC trade", () => {
    engine.setChargesEnabled(true);
    // ITC.csv row 2026-09-16T11:15 closes at 266.20. STT 26.62p -> 27, exchange 0.82p -> 1,
    // SEBI 0.03p -> 0, stamp 3.99p -> 4, GST 0.18p -> 0.
    const b = buy("ITC", 1, t(1, "11:15"));
    expect(b.fillPrice).toBe(26620);
    expect(b.charges).toBe(32);
    // ITC.csv row 2026-09-17T11:15 closes at 267.45. Sell: STT 27, exchange 1, no stamp, plus DP Rs 15.34.
    const s = sell("ITC", 1, t(2, "11:15"));
    expect(s.fillPrice).toBe(26745);
    expect(s.charges).toBe(27 + 1 + 1534);
    expect(engine.portfolio(t(2, "11:15")).summary.realizedPnl).toBe(26745 - 26620);
    expect(engine.portfolio(t(2, "11:15")).summary.totalPnl).toBe(26745 - 26620 - 32 - 1562);
  });
});

describe("HTTP API validation", () => {
  const at = t(1, "11:15");
  const post = (body: unknown) => request(createApp(engine)).post("/api/orders").send(body as object);
  const expectBad = async (res: Promise<request.Response> | request.Test, status: number, code: string) => {
    const r = await res;
    expect(r.status).toBe(status);
    expect(r.headers["content-type"]).toMatch(/json/);
    expect(r.body.error.code).toBe(code);
  };

  it("rejects bad quantities", async () => {
    for (const qty of [0, -1, 1.5, "5", 1_000_001, null]) {
      await expectBad(post({ symbol: "ITC", side: "BUY", qty, at }), 400, "BAD_REQUEST");
    }
    await expectBad(post({ symbol: "ITC", side: "BUY", at }), 400, "BAD_REQUEST");
    // Allowed by the schema, stopped by the cash check.
    await expectBad(post({ symbol: "ITC", side: "BUY", qty: 1_000_000, at }), 422, "INSUFFICIENT_FUNDS");
  });

  it("rejects a missing or unknown side and a bad time", async () => {
    await expectBad(post({ symbol: "ITC", qty: 1, at }), 400, "BAD_REQUEST");
    await expectBad(post({ symbol: "ITC", side: "buy", qty: 1, at }), 400, "BAD_REQUEST");
    for (const bad of [undefined, 1.5, -at, 0, String(at)]) {
      await expectBad(post({ symbol: "ITC", side: "BUY", qty: 1, at: bad }), 400, "BAD_REQUEST");
    }
    await expectBad(post({ symbol: "ITC", side: "BUY", qty: 1, at: afterEnd(9, "12:00") }), 422, "MARKET_CLOSED");
  });

  it("rejects limit prices that are missing, off the tick grid or finer than a paisa", async () => {
    await expectBad(post({ symbol: "TCS", side: "BUY", type: "LIMIT", qty: 1, at }), 422, "BAD_PRICE");
    await expectBad(post({ symbol: "TCS", side: "BUY", type: "LIMIT", qty: 1, limitPrice: -5, at }), 400, "BAD_REQUEST");
    await expectBad(post({ symbol: "TCS", side: "BUY", type: "LIMIT", qty: 1, limitPrice: 2050.105, at }), 422, "BAD_TICK");
    // Documents current behaviour: a third decimal that rounds onto the grid is accepted as the rounded price.
    const r = await post({ symbol: "TCS", side: "BUY", type: "LIMIT", qty: 1, limitPrice: 2000.001, at });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: "OPEN", limitPrice: 200000 });
  });

  it("returns 404 for an unknown symbol in any case", async () => {
    await expectBad(post({ symbol: "nope", side: "BUY", qty: 1, at }), 404, "UNKNOWN_SYMBOL");
    await expectBad(request(createApp(engine)).get(`/api/stocks/nope/candles?at=${at}`), 404, "UNKNOWN_SYMBOL");
    const ok = await request(createApp(engine)).get(`/api/stocks/tcs/candles?at=${at}`);
    expect(ok.status).toBe(200);
    expect(ok.body.candles.at(-1).ts).toBeLessThanOrEqual(at);
  });

  it("answers malformed JSON with a 400, not a server error", async () => {
    const res = await request(createApp(engine)).post("/api/orders").set("Content-Type", "application/json").send('{"symbol": "ITC", "qty": ');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("BAD_JSON");
  });

  it("validates the at, from and amount query parameters", async () => {
    const app = createApp(engine);
    for (const path of ["/api/market?at=abc", "/api/portfolio?at=abc", "/api/orders?at=-5", "/api/performance?at=1.5", "/api/transactions?at="]) {
      await expectBad(request(app).get(path), 400, "BAD_TIME");
    }
    await expectBad(request(app).get(`/api/what-if?from=${at + 1}&at=${at}`), 400, "BAD_RANGE");
    await expectBad(request(app).get(`/api/what-if?from=abc&at=${at}`), 400, "BAD_REQUEST");
    await expectBad(request(app).get(`/api/what-if?at=${at}&amount=0`), 400, "BAD_REQUEST");
    await expectBad(request(app).get(`/api/what-if?at=${at}&amount=-100`), 400, "BAD_REQUEST");
    expect((await request(app).get(`/api/what-if?from=${at}&at=${at}`)).status).toBe(200);
  });

  it("validates cancels, account changes and resets", async () => {
    const app = createApp(engine);
    await expectBad(request(app).post("/api/orders/abc/cancel").send({ at }), 400, "BAD_REQUEST");
    await expectBad(request(app).post("/api/orders/1/cancel").send({}), 400, "BAD_REQUEST");
    await expectBad(request(app).post("/api/orders/999/cancel").send({ at }), 404, "NOT_FOUND");
    await expectBad(request(app).patch("/api/account").send({ chargesEnabled: "yes" }), 400, "BAD_REQUEST");
    await expectBad(request(app).post("/api/account/reset").send({ startingCash: 9_999 }), 400, "BAD_REQUEST");
    await expectBad(request(app).post("/api/account/reset").send({ startingCash: "100000" }), 400, "BAD_REQUEST");
    expect(engine.account().starting_cash).toBe(START);
    const ok = await request(app).post("/api/account/reset").send({ startingCash: 10_000, chargesEnabled: false });
    expect(ok.status).toBe(200);
    expect(engine.account().starting_cash).toBe(10_000_00);
  });

  it("returns a JSON 404 for unknown API routes", async () => {
    const app = createApp(engine);
    await expectBad(request(app).get("/api/nothing-here"), 404, "NOT_FOUND");
    await expectBad(request(app).post("/api/orders/1/uncancel").send({ at }), 404, "NOT_FOUND");
    await expectBad(request(app).delete("/api/orders"), 404, "NOT_FOUND");
  });
});

describe("market data integrity", () => {
  it("gives every stock the same strictly increasing timeline on the 30-minute grid", () => {
    expect(market.timeline).toHaveLength(14 * 13);
    for (let i = 1; i < market.timeline.length; i++) expect(market.timeline[i]).toBeGreaterThan(market.timeline[i - 1]);
    for (const s of market.stocks) expect(market.candlesOf(s.symbol).map((c) => c.ts)).toEqual(market.timeline);
    for (const ts of market.timeline) {
      const { date, time } = epochToIst(ts);
      expect((ts - sessionBounds(date).open) % CANDLE_SECONDS).toBe(0);
      expect(CANDLE_STARTS).toContain(time);
    }
    expect(market.tradingDays).toEqual([
      "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18", "2026-09-21", "2026-09-22", "2026-09-23",
      "2026-09-24", "2026-09-25", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-05",
    ]);
  });

  it("opens each stock within 10% of its previous close and keeps prices on the grid", () => {
    for (const s of market.stocks) {
      const list = market.candlesOf(s.symbol);
      expect(Math.abs(list[0].open - s.prev_close) / s.prev_close).toBeLessThan(0.1);
      for (const c of list) {
        expect(Number.isInteger(c.volume)).toBe(true);
        expect(c.volume).toBeGreaterThan(0);
        for (const p of [c.open, c.high, c.low, c.close]) {
          expect(Number.isInteger(p)).toBe(true);
          expect(p % tickPaise(p)).toBe(0);
        }
      }
    }
  });
});

describe("what-if", () => {
  it("returns the amount untouched when it cannot buy a single share", () => {
    const res = engine.whatIf(t(0, "09:15"), t(-1, "15:15"), 100_00); // Rs 100, below every share price
    expect(res.results).toHaveLength(10);
    for (const r of res.results) {
      expect(r.buyPrice).toBeGreaterThan(100_00);
      expect(r).toMatchObject({ shares: 0, value: 100_00, pnl: 0 });
    }
  });

  it("uses whole shares and keeps the leftover cash", () => {
    const from = t(0, "09:15");
    const at = t(-1, "15:15");
    const r = engine.whatIf(from, at, 1_00_000_00).results.find((x) => x.symbol === "LT")!;
    expect(r.shares).toBe(Math.floor(1_00_000_00 / r.buyPrice));
    expect(r.value).toBe(r.shares * r.priceNow + (1_00_000_00 - r.shares * r.buyPrice));
  });

  it("accepts a fractional rupee amount over HTTP", async () => {
    const res = await request(createApp(engine)).get(`/api/what-if?from=${t(0, "09:15")}&at=${t(1, "09:15")}&amount=0.5`);
    expect(res.status).toBe(200);
    expect(res.body.results.every((r: { shares: number; value: number }) => r.shares === 0 && r.value === 50)).toBe(true);
  });
});
