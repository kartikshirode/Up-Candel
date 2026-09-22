import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../server/app.ts";
import { computeCharges } from "../shared/charges.ts";
import { openDatabase } from "../server/db.ts";
import { Engine, TradeError } from "../server/engine.ts";
import { Market } from "../server/market.ts";
import { CANDLE_STARTS, epochToIst, roundToTick } from "../shared/market.ts";
import { HOLIDAYS, ist, t, WEEKENDS } from "./helpers.ts";

let engine: Engine;
let market: Market;

beforeEach(() => {
  const db = openDatabase(":memory:");
  market = new Market(db);
  engine = new Engine(db, market);
  engine.reset(10_00_000_00, false); // charges off unless a test turns them on
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

describe("market data", () => {
  it("has 10 stocks, 14 trading days and 13 candles a day from 09:15 to 15:15", () => {
    expect(market.stocks).toHaveLength(10);
    expect(market.tradingDays).toHaveLength(14);
    expect(market.tradingDays).not.toContain("2026-10-02"); // Gandhi Jayanti
    for (const s of market.stocks) {
      const list = market.candlesOf(s.symbol);
      expect(list).toHaveLength(14 * 13);
      for (const day of market.tradingDays) {
        const times = list.filter((c) => epochToIst(c.ts).date === day).map((c) => epochToIst(c.ts).time);
        expect(times).toEqual([...CANDLE_STARTS]);
      }
    }
  });

  it("keeps every candle internally consistent and on the tick grid", () => {
    for (const s of market.stocks) {
      for (const c of market.candlesOf(s.symbol)) {
        expect(c.high).toBeGreaterThanOrEqual(Math.max(c.open, c.close));
        expect(c.low).toBeLessThanOrEqual(Math.min(c.open, c.close));
        expect(c.low).toBeGreaterThan(0);
        expect(c.volume).toBeGreaterThan(0);
        expect(roundToTick(c.close)).toBe(c.close);
      }
    }
  });

  it("quotes the candle for the selected date and time", () => {
    // TCS.csv row 2026-09-15T10:15 closes at 2076.10
    expect(market.priceAt("TCS", t(0, "10:15"))).toBe(207610);
    // Between candles the latest started candle counts
    expect(market.priceAt("TCS", t(0, "10:40"))).toBe(207610);
    // Before the data starts, the previous close from data/stocks.csv (TCS 2110.00)
    expect(market.priceAt("TCS", t(0, "09:00"))).toBe(211000);
  });

  it("knows when the market is open", () => {
    expect(market.status(t(1, "11:00")).isOpen).toBe(true);
    expect(market.status(t(1, "15:30")).state).toBe("CLOSED");
    expect(market.status(t(1, "09:00")).state).toBe("PRE_OPEN");
    expect(market.status(ist(WEEKENDS[0], "11:00")).label).toMatch(/Weekend/);
    expect(market.status(ist(HOLIDAYS[0], "11:00")).label).toMatch(/holiday/);
  });
});

describe("trading", () => {
  it("buys at the price for the selected time and debits cash", () => {
    const at = t(0, "10:15");
    const price = market.priceAt("TCS", at); // TCS.csv row 2026-09-15T10:15
    const order = engine.placeOrder({ symbol: "TCS", side: "BUY", type: "MARKET", qty: 10, at });
    expect(order.status).toBe("FILLED");
    expect(order.fillPrice).toBe(price);
    const p = engine.portfolio(at);
    expect(p.summary.cash).toBe(10_00_000_00 - 10 * price);
    expect(p.holdings[0]).toMatchObject({ symbol: "TCS", qty: 10, avgPrice: price });
  });

  it("averages cost across buys and books realized P&L on a partial sell", () => {
    const a = t(0, "10:15");
    const b = t(2, "11:15");
    const c = t(5, "14:15");
    engine.placeOrder({ symbol: "INFY", side: "BUY", type: "MARKET", qty: 10, at: a });
    engine.placeOrder({ symbol: "INFY", side: "BUY", type: "MARKET", qty: 30, at: b });
    const pa = market.priceAt("INFY", a);
    const pb = market.priceAt("INFY", b);
    const avg = (10 * pa + 30 * pb) / 40;
    expect(engine.portfolio(b).holdings[0].avgPrice).toBeCloseTo(avg, 6);

    engine.placeOrder({ symbol: "INFY", side: "SELL", type: "MARKET", qty: 15, at: c });
    const pc = market.priceAt("INFY", c);
    const p = engine.portfolio(c);
    expect(p.holdings[0].qty).toBe(25);
    expect(p.holdings[0].avgPrice).toBeCloseTo(avg, 0); // a sale does not move the average
    expect(p.summary.realizedPnl).toBe(15 * pc - Math.round((10 * pa + 30 * pb) * 15 / 40));
  });

  it("keeps total P&L equal to realized + unrealized - charges", () => {
    engine.setChargesEnabled(true);
    engine.placeOrder({ symbol: "SBIN", side: "BUY", type: "MARKET", qty: 100, at: t(1, "09:45") });
    engine.placeOrder({ symbol: "LT", side: "BUY", type: "MARKET", qty: 20, at: t(3, "13:15") });
    engine.placeOrder({ symbol: "SBIN", side: "SELL", type: "MARKET", qty: 40, at: t(11, "10:15") });
    const s = engine.portfolio(t(12, "15:15")).summary;
    expect(s.totalPnl).toBe(s.realizedPnl + s.unrealizedPnl - s.charges);
    expect(s.charges).toBeGreaterThan(0);
  });

  it("rejects orders it cannot honour", () => {
    const at = t(1, "11:15");
    expectTradeError(() => engine.placeOrder({ symbol: "LT", side: "BUY", type: "MARKET", qty: 10_000, at }), "INSUFFICIENT_FUNDS");
    expectTradeError(() => engine.placeOrder({ symbol: "ITC", side: "SELL", type: "MARKET", qty: 1, at }), "INSUFFICIENT_HOLDINGS");
    engine.placeOrder({ symbol: "ITC", side: "BUY", type: "MARKET", qty: 5, at });
    expectTradeError(() => engine.placeOrder({ symbol: "ITC", side: "SELL", type: "MARKET", qty: 6, at }), "INSUFFICIENT_HOLDINGS");
    expectTradeError(() => engine.placeOrder({ symbol: "ITC", side: "BUY", type: "MARKET", qty: 1, at: t(1, "16:00") }), "MARKET_CLOSED");
    expectTradeError(() => engine.placeOrder({ symbol: "ITC", side: "BUY", type: "MARKET", qty: 1, at: ist(WEEKENDS[0], "11:00") }), "MARKET_CLOSED");
    expectTradeError(() => engine.placeOrder({ symbol: "NOPE", side: "BUY", type: "MARKET", qty: 1, at }), "UNKNOWN_SYMBOL");
  });

  it("allows a trade before an earlier one as long as the books still balance", () => {
    engine.placeOrder({ symbol: "TCS", side: "BUY", type: "MARKET", qty: 1, at: t(5, "10:15") });
    const back = engine.placeOrder({ symbol: "TCS", side: "BUY", type: "MARKET", qty: 1, at: t(2, "10:15") });
    expect(back.status).toBe("FILLED");
    expect(engine.portfolio(t(5, "10:15")).holdings[0].qty).toBe(2);
    expect(engine.portfolio(t(3, "10:15")).holdings[0].qty).toBe(1); // only the back-dated one by then
  });

  it("refuses a back-dated trade that would leave a later one short", () => {
    const early = t(2, "10:15");
    const late = t(6, "11:15");
    engine.placeOrder({ symbol: "SBIN", side: "BUY", type: "MARKET", qty: 100, at: early });
    engine.placeOrder({ symbol: "SBIN", side: "SELL", type: "MARKET", qty: 100, at: late });
    // Selling 40 in between would leave the later sale of 100 without the shares.
    expectTradeError(() => engine.placeOrder({ symbol: "SBIN", side: "SELL", type: "MARKET", qty: 40, at: t(4, "10:15") }), "LEDGER_CONFLICT");
    // Spending nearly all the cash in between would leave a later buy unpayable.
    engine.placeOrder({ symbol: "LT", side: "BUY", type: "MARKET", qty: 150, at: t(7, "10:15") });
    expectTradeError(() => engine.placeOrder({ symbol: "ITC", side: "BUY", type: "MARKET", qty: 3000, at: t(3, "10:15") }), "LEDGER_CONFLICT");
  });

  it("shows the account as it was at an earlier time", () => {
    engine.placeOrder({ symbol: "TCS", side: "BUY", type: "MARKET", qty: 5, at: t(5, "10:15") });
    expect(engine.portfolio(t(2, "10:15")).holdings).toHaveLength(0);
    expect(engine.tradeHistory(t(2, "10:15"))).toHaveLength(0);
    expect(engine.portfolio(t(6, "10:15")).holdings).toHaveLength(1);
  });
});

describe("limit orders", () => {
  it("rests below the market and fills when a later candle touches the limit", () => {
    const at = t(0, "10:15");
    const list = market.candlesOf("TCS");
    const start = market.indexAt("TCS", at);
    // Pick a limit that a later candle trades through, but below the current price.
    const later = list.slice(start + 1).find((c) => c.low < list[start].close * 0.98)!;
    const limit = roundToTick(later.low + 100, "down");
    const order = engine.placeOrder({ symbol: "TCS", side: "BUY", type: "LIMIT", qty: 50, limitPrice: limit, at });
    expect(order.status).toBe("OPEN");
    expect(engine.portfolio(at).summary.blockedForOrders).toBe(50 * limit);

    const firstTouch = list.slice(start + 1).find((c) => c.low <= limit)!;
    expect(engine.orderView(order.id, firstTouch.ts - 60)!.status).toBe("OPEN");
    const filled = engine.orders(firstTouch.ts).find((o) => o.id === order.id)!;
    expect(filled.status).toBe("FILLED");
    expect(filled.fillPrice).toBe(Math.min(limit, firstTouch.open));
  });

  it("fills a marketable limit straight away at the market price", () => {
    const at = t(0, "10:15");
    const ltp = market.priceAt("ITC", at);
    const order = engine.placeOrder({ symbol: "ITC", side: "BUY", type: "LIMIT", qty: 10, limitPrice: roundToTick(ltp * 1.02), at });
    expect(order.status).toBe("FILLED");
    expect(order.fillPrice).toBe(ltp);
  });

  it("rejects prices off the tick grid or outside the band", () => {
    const at = t(0, "10:15");
    expectTradeError(() => engine.placeOrder({ symbol: "TCS", side: "BUY", type: "LIMIT", qty: 1, limitPrice: 200003, at }), "BAD_TICK");
    expectTradeError(() => engine.placeOrder({ symbol: "TCS", side: "BUY", type: "LIMIT", qty: 1, limitPrice: 150000, at }), "PRICE_BAND");
  });

  it("can be cancelled while open", () => {
    const at = t(0, "10:15");
    const limit = roundToTick(market.priceAt("TCS", at) * 0.92, "up");
    const order = engine.placeOrder({ symbol: "TCS", side: "BUY", type: "LIMIT", qty: 1, limitPrice: limit, at });
    expect(engine.cancelOrder(order.id, t(0, "11:15")).status).toBe("CANCELLED");
    expect(engine.portfolio(t(0, "11:15")).summary.blockedForOrders).toBe(0);
  });
});

describe("charges", () => {
  it("matches the published delivery schedule on Rs 1 lakh", () => {
    expect(computeCharges("BUY", 1_00_000_00).total).toBe(11874); // Rs 118.74
    expect(computeCharges("SELL", 1_00_000_00).total).toBe(11908); // Rs 119.08 with the DP charge
    expect(computeCharges("SELL", 1_00_000_00, false).dp).toBe(0);
  });
});

describe("performance", () => {
  it("tracks net worth against an equal-weight benchmark from the same starting cash", () => {
    const perf = engine.performance(t(-1, "15:15"));
    expect(perf.curve).toHaveLength(14 * 13);
    expect(perf.curve.every((p) => p.netWorth === 10_00_000_00)).toBe(true); // no trades, cash only
    expect(Math.abs(perf.curve[0].benchmark - 10_00_000_00)).toBeLessThan(2_000_000);
  });
});

describe("HTTP API", () => {
  it("places an order and returns JSON errors with a code", async () => {
    const app = createApp(engine);
    const at = t(1, "11:15");
    const ok = await request(app).post("/api/orders").send({ symbol: "reliance", side: "BUY", qty: 3, at });
    expect(ok.status).toBe(201);
    expect(ok.body.status).toBe("FILLED");

    const bad = await request(app).post("/api/orders").send({ symbol: "RELIANCE", side: "SELL", qty: 99, at });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe("INSUFFICIENT_HOLDINGS");

    const invalid = await request(app).post("/api/orders").send({ symbol: "RELIANCE", side: "HOLD", qty: 1, at });
    expect(invalid.status).toBe(400);

    const csv = await request(app).get(`/api/transactions?format=csv&at=${at}`);
    expect(csv.headers["content-type"]).toMatch(/text\/csv/);
    expect(csv.text.split("\n")[1]).toMatch(/RELIANCE,BUY,3,/);
  });

  it("serves market quotes for a selected time", async () => {
    const app = createApp(engine);
    const res = await request(app).get(`/api/market?at=${t(0, "10:15")}`);
    expect(res.status).toBe(200);
    expect(res.body.status.isOpen).toBe(true);
    // TCS.csv row 2026-09-15T10:15 closes at 2076.10
    expect(res.body.quotes.find((q: { symbol: string }) => q.symbol === "TCS").ltp).toBe(207610);
  });
});
