// Adversarial tests for trading at a time earlier than trades already on the ledger.
//
// The rules under test: an order can be placed at any open market time, the ledger is
// replayed forward before it is accepted, and views of a later time never write anything.

import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../server/app.ts";
import { computeCharges } from "../shared/charges.ts";
import { openDatabase, type DB } from "../server/db.ts";
import { Engine, TradeError } from "../server/engine.ts";
import { Market, type Candle } from "../server/market.ts";
import { epochToIst, roundToTick } from "../shared/market.ts";
import { t } from "./helpers.ts";

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

const buy = (symbol: string, qty: number, at: number) => engine.placeOrder({ symbol, side: "BUY", type: "MARKET", qty, at });
const sell = (symbol: string, qty: number, at: number) => engine.placeOrder({ symbol, side: "SELL", type: "MARKET", qty, at });

/** The error a call was expected to throw, so its message can be checked too. */
function tradeError(fn: () => unknown, code: string): TradeError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(TradeError);
    expect((e as TradeError).code).toBe(code);
    return e as TradeError;
  }
  throw new Error(`expected ${code}`);
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** The way the engine names a moment in an error message: "Thu 1 Oct, 14:15". */
const label = (ts: number) => {
  const { date, time, weekday } = epochToIst(ts);
  const [, month, dayOfMonth] = date.split("-").map(Number);
  return `${WEEKDAYS[weekday]} ${dayOfMonth} ${MONTHS[month - 1]}, ${time}`;
};

const candlesAfter = (symbol: string, ts: number) => market.candlesOf(symbol).filter((c) => c.ts > ts);

function firstTouch(symbol: string, ts: number, limit: number, side: "BUY" | "SELL"): Candle | undefined {
  return candlesAfter(symbol, ts).find((c) => (side === "BUY" ? c.low <= limit : c.high >= limit));
}

const rows = (table: "orders" | "trades") => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all() as Record<string, unknown>[];
const sum = (xs: number[]) => xs.reduce((n, x) => n + x, 0);

/** The accounting promises, checked as of `at`. */
function checkBooks(at: number) {
  const p = engine.portfolio(at);
  const s = p.summary;
  expect(s.cash).toBeGreaterThanOrEqual(0);
  expect(Number.isInteger(s.cash)).toBe(true);
  for (const h of p.holdings) expect(h.qty).toBeGreaterThan(0);
  expect(s.netWorth - p.account.startingCash).toBe(s.realizedPnl + s.unrealizedPnl - s.charges);

  const history = engine.tradeHistory(at);
  expect(p.account.startingCash + sum(history.map((h) => h.netAmount))).toBe(s.cash);
  expect(sum(history.map((h) => h.realizedPnl ?? 0))).toBe(s.realizedPnl);
  expect(sum(history.map((h) => h.charges))).toBe(s.charges);

  const perf = engine.performance(at);
  expect(perf.curve.at(-1)!.netWorth).toBe(s.netWorth);
  expect(perf.stats.tradeCount).toBe(history.length);
  expect(perf.stats.totalCharges).toBe(s.charges);
  return p;
}

describe("back-dated trades the books can absorb", () => {
  it("slots a back-dated buy in before a later one and leaves the later view whole", () => {
    const late = t(8, "10:15");
    const early = t(2, "11:15");
    buy("SBIN", 10, late);
    expect(buy("SBIN", 10, early).status).toBe("FILLED");

    expect(engine.portfolio(t(2, "11:14")).holdings).toHaveLength(0);
    expect(engine.portfolio(early).holdings[0].qty).toBe(10);
    expect(engine.portfolio(late).holdings[0].qty).toBe(20);
    expect(engine.tradeHistory(late).map((h) => h.simTime)).toEqual([late, early]); // newest first
    checkBooks(late);
  });

  it("allows a back-dated sell that still leaves the later sell its shares", () => {
    buy("ITC", 20, t(1, "10:15"));
    sell("ITC", 5, t(9, "11:15"));
    expect(sell("ITC", 5, t(4, "10:15")).status).toBe("FILLED");
    expect(engine.portfolio(t(9, "11:15")).holdings[0].qty).toBe(10);
    // One more of the same size is still fine; the books never go below zero.
    expect(sell("ITC", 5, t(5, "10:15")).status).toBe("FILLED");
    expect(engine.portfolio(t(9, "11:15")).holdings[0].qty).toBe(5);
    checkBooks(t(9, "11:15"));
  });

  it("takes an order back-dated to the very first candle of the data", () => {
    const first = t(0, "09:15");
    buy("LT", 3, t(6, "10:15"));
    const order = buy("LT", 4, first);
    expect(order.status).toBe("FILLED");
    expect(order.fillPrice).toBe(market.candlesOf("LT").find((c) => c.ts === first)!.close);

    const p = engine.portfolio(first);
    expect(p.holdings[0]).toMatchObject({ symbol: "LT", qty: 4 });
    expect(engine.tradeHistory(first)).toHaveLength(1);
    const perf = engine.performance(first);
    expect(perf.curve).toHaveLength(1);
    expect(perf.curve[0].netWorth).toBe(p.summary.netWorth);
    // Shares bought today carry the buy price as their day P&L basis, from the very first candle.
    expect(p.holdings[0].dayPnl).toBe(0);
    const noon = t(0, "12:15");
    expect(engine.portfolio(noon).holdings[0].dayPnl).toBe(4 * (market.priceAt("LT", noon) - order.fillPrice!));
    checkBooks(t(6, "10:15"));
  });
});

describe("back-dated trades that clash with later ones", () => {
  it("names the later sale a back-dated sell would leave short of shares", () => {
    const late = t(8, "11:15");
    buy("SBIN", 10, t(1, "10:15"));
    sell("SBIN", 10, late);

    const err = tradeError(() => sell("SBIN", 1, t(4, "10:15")), "LEDGER_CONFLICT");
    expect(err.status).toBe(422);
    expect(err.message).toContain(`your sell of 10 SBIN at ${label(late)}`);
    expect(err.message).toMatch(/without enough shares/);
    // The refused order leaves no trace at all.
    expect(rows("orders")).toHaveLength(2);
    expect(rows("trades")).toHaveLength(2);
  });

  it("names the later buy a back-dated buy would leave short of cash, and by how much", () => {
    const late = t(7, "10:15");
    buy("LT", 100, late);
    const at = t(3, "10:15");
    const itc = market.priceAt("ITC", at);
    const qty = Math.floor(START / itc); // every last paisa

    const err = tradeError(() => buy("ITC", qty, at), "LEDGER_CONFLICT");
    expect(err.message).toContain(`your buy of 100 LT at ${label(late)}`);
    expect(err.message).toMatch(/short by Rs /);
    expect(rows("orders")).toHaveLength(1);
    // A smaller one at the same moment goes through.
    expect(buy("ITC", Math.floor(qty / 4), at).status).toBe("FILLED");
    checkBooks(t(7, "10:15"));
  });

  it("points at the last trade of a chain when that is the only one that breaks", () => {
    const d2 = t(2, "10:15");
    const d4 = t(4, "10:15");
    const d6 = t(6, "10:15");
    const d8 = t(8, "10:15");
    buy("ITC", 100, d2);
    buy("ITC", 100, d4);
    sell("ITC", 100, d6);
    sell("ITC", 100, d8);

    // Selling the first 100 back on day 3 survives the day 4 buy and the day 6 sale,
    // and only runs out of shares at the very last trade.
    const err = tradeError(() => sell("ITC", 100, t(3, "10:15")), "LEDGER_CONFLICT");
    expect(err.message).toContain(label(d8));
    expect(err.message).not.toContain(label(d6));
    expect(rows("trades")).toHaveLength(4);
    checkBooks(d8);
  });

  it("counts a trade at the same timestamp as already done, not as a later one", () => {
    const at = t(5, "11:15");
    buy("TCS", 10, t(1, "10:15"));
    sell("TCS", 10, at);

    // The existing sale at the same second counts as earlier, so there is nothing left
    // to sell and the answer is the plain holdings error, not a ledger conflict.
    tradeError(() => sell("TCS", 1, at), "INSUFFICIENT_HOLDINGS");
    // A second earlier is a genuine back-date, and that one clashes.
    tradeError(() => sell("TCS", 1, at - 1), "LEDGER_CONFLICT");

    // A buy at that same second lands after the sale, so it is simply allowed.
    expect(buy("TCS", 10, at).status).toBe("FILLED");
    expect(engine.portfolio(at).holdings[0].qty).toBe(10);
    expect(engine.tradeHistory(at)).toHaveLength(3);
    checkBooks(at);
  });

  it("refuses to sell shares that a back-dated sale would already have gone", () => {
    buy("INFY", 10, t(1, "10:15"));
    expect(sell("INFY", 10, t(6, "10:15")).status).toBe("FILLED");
    // Going back to the 4th day to sell the same 10 shares is the README's example.
    const err = tradeError(() => sell("INFY", 10, t(4, "10:15")), "LEDGER_CONFLICT");
    expect(err.message).toContain("Trade later than that, or trade smaller here.");
  });
});

describe("back-dating and charges", () => {
  it("counts the charges of a back-dated buy against the later trade's cash", () => {
    engine.setChargesEnabled(true);
    const late = t(8, "11:15");
    const reliance = market.priceAt("RELIANCE", late);
    const lateQty = Math.floor((START * 0.5) / reliance);
    buy("RELIANCE", lateQty, late);
    const cashLeft = engine.portfolio(late).summary.cash;

    const at = t(3, "10:15");
    const itc = market.priceAt("ITC", at);
    const qty = Math.floor(cashLeft / itc);
    const charges = computeCharges("BUY", qty * itc).total;
    expect(qty * itc).toBeLessThanOrEqual(cashLeft); // the shares alone fit
    expect(qty * itc + charges).toBeGreaterThan(cashLeft); // the charges alone tip it over

    const err = tradeError(() => buy("ITC", qty, at), "LEDGER_CONFLICT");
    expect(err.message).toContain(`your buy of ${lateQty} RELIANCE at ${label(late)}`);

    // With charges switched off the identical order is affordable.
    engine.setChargesEnabled(false);
    expect(buy("ITC", qty, at).status).toBe("FILLED");
    expect(engine.portfolio(late).summary.cash).toBe(cashLeft - qty * itc);
    checkBooks(late);
  });

  it("bills the day's DP charge once when a sell is inserted before an existing sell", () => {
    // Debatable, documented as it stands: the rule asks whether the day has any other sell,
    // not whether that sell came first, so the DP sits on the later of the two. The day is
    // still charged exactly one DP, which is what the contract note promises.
    engine.setChargesEnabled(true);
    buy("SBIN", 30, t(1, "10:15"));
    const later = sell("SBIN", 10, t(4, "11:15"));
    const earlier = sell("SBIN", 10, t(4, "09:45"));

    const end = t(4, "12:15");
    const history = engine.tradeHistory(end);
    const dpOf = (id: number) => history.find((h) => h.orderId === id)!.chargesBreakdown.dp;
    expect(dpOf(earlier.id)).toBe(0);
    expect(dpOf(later.id)).toBe(1534);
    expect(sum(history.filter((h) => h.side === "SELL").map((h) => h.chargesBreakdown.dp))).toBe(1534);
    // A sell back-dated to another day is still charged its own DP.
    const otherDay = sell("SBIN", 5, t(3, "10:15"));
    expect(engine.tradeHistory(end).find((h) => h.orderId === otherDay.id)!.chargesBreakdown.dp).toBe(1534);
    checkBooks(end);
  });
});

describe("back-dating and resting limit orders", () => {
  it("rejects a resting buy at fill time when a back-dated trade took its cash", () => {
    const rest = t(5, "10:15");
    const limit = roundToTick(market.priceAt("TCS", rest) * 0.99, "down");
    const touch = firstTouch("TCS", rest, limit, "BUY");
    expect(touch).toBeDefined();
    const qty = Math.floor((START * 0.9) / limit);
    const order = engine.placeOrder({ symbol: "TCS", side: "BUY", type: "LIMIT", qty, limitPrice: limit, at: rest });
    expect(order.status).toBe("OPEN");

    // The resting order was placed later than this moment, so it reserves nothing here.
    const back = t(2, "10:15");
    const itc = market.priceAt("ITC", back);
    expect(buy("ITC", Math.floor((START * 0.9) / itc), back).status).toBe("FILLED");

    const view = engine.orders(touch!.ts).find((o) => o.id === order.id)!;
    expect(view).toMatchObject({ status: "REJECTED", fillPrice: null, resolvedAt: touch!.ts });
    expect(view.reason).toBe("Not enough cash when the limit price was reached");
    expect(engine.portfolio(touch!.ts).summary.blockedForOrders).toBe(0);
    checkBooks(t(-1, "15:15"));
  });

  it("rejects a resting sell at fill time when a back-dated sale took its shares", () => {
    buy("LT", 10, t(1, "10:15"));
    const rest = t(5, "10:15");
    const ltp = market.priceAt("LT", rest);
    const maxHigh = Math.max(...candlesAfter("LT", rest).map((c) => c.high));
    const limit = Math.min(roundToTick(ltp + (maxHigh - ltp) * 0.5, "up"), roundToTick(market.prevCloseAt("LT", rest) * 1.1, "down"));
    const order = engine.placeOrder({ symbol: "LT", side: "SELL", type: "LIMIT", qty: 6, limitPrice: limit, at: rest });
    expect(order.status).toBe("OPEN");
    // From day 5 the 6 shares are spoken for, so only 4 can be sold at the market.
    tradeError(() => sell("LT", 5, rest), "INSUFFICIENT_HOLDINGS");

    // Back on day 2 the order does not exist yet, so all 10 can go. Nothing warns.
    expect(sell("LT", 10, t(2, "10:15")).status).toBe("FILLED");
    const touch = firstTouch("LT", rest, limit, "SELL");
    expect(touch).toBeDefined();
    const view = engine.orders(touch!.ts).find((o) => o.id === order.id)!;
    expect(view.status).toBe("REJECTED");
    expect(view.reason).toBe("Not enough shares when the limit price was reached");
    checkBooks(touch!.ts);
  });

  it("refuses a resting fill that would leave a trade made after it unpayable", () => {
    // Regression: the fill of a back-dated resting order used to be checked only against the
    // ledger up to its own fill time, so it could spend cash a later trade had already used.
    const late = t(8, "10:15");
    const reliance = market.priceAt("RELIANCE", late);
    const lateQty = Math.floor((START * 0.8) / reliance);
    buy("RELIANCE", lateQty, late);

    const rest = t(2, "10:15");
    const limit = roundToTick(market.priceAt("TCS", rest) * 0.99, "down");
    const touch = firstTouch("TCS", rest, limit, "BUY");
    expect(touch).toBeDefined();
    expect(touch!.ts).toBeLessThan(late);
    const qty = Math.floor((START * 0.9) / limit);
    // Nothing stops the order resting: only orders that fill on the spot are checked.
    const order = engine.placeOrder({ symbol: "TCS", side: "BUY", type: "LIMIT", qty, limitPrice: limit, at: rest });
    expect(order.status).toBe("OPEN");

    const view = engine.orders(late).find((o) => o.id === order.id)!;
    expect(view).toMatchObject({ status: "REJECTED", fillPrice: null, resolvedAt: touch!.ts });
    expect(view.reason).toContain(`your buy of ${lateQty} RELIANCE at ${label(late)}`);
    expect(view.reason).toMatch(/short by Rs /);
    expect(engine.portfolio(late).summary.cash).toBe(START - engine.tradeHistory(late)[0].qty * reliance);
    checkBooks(late);
  });

  it("refuses a resting sell fill that would leave a later sale without shares", () => {
    buy("BHARTIARTL", 10, t(1, "10:15"));
    const late = t(9, "10:15");
    sell("BHARTIARTL", 10, late);

    const rest = t(2, "10:15");
    const ltp = market.priceAt("BHARTIARTL", rest);
    const maxHigh = Math.max(...candlesAfter("BHARTIARTL", rest).map((c) => c.high));
    const limit = Math.min(roundToTick(ltp + (maxHigh - ltp) * 0.5, "up"), roundToTick(market.prevCloseAt("BHARTIARTL", rest) * 1.1, "down"));
    const order = engine.placeOrder({ symbol: "BHARTIARTL", side: "SELL", type: "LIMIT", qty: 10, limitPrice: limit, at: rest });
    expect(order.status).toBe("OPEN");
    const touch = firstTouch("BHARTIARTL", rest, limit, "SELL");
    expect(touch).toBeDefined();
    expect(touch!.ts).toBeLessThan(late);

    const view = engine.orders(late).find((o) => o.id === order.id)!;
    expect(view.status).toBe("REJECTED");
    expect(view.reason).toContain(`your sell of 10 BHARTIARTL at ${label(late)}`);
    expect(engine.portfolio(late).holdings).toHaveLength(0);
    checkBooks(late);
  });

  it("names a limit fill as the clashing trade when one is back-dated under it", () => {
    const rest = t(1, "10:15");
    const limit = roundToTick(market.priceAt("TCS", rest) * 0.99, "down");
    const qty = Math.floor((START * 0.9) / limit);
    engine.placeOrder({ symbol: "TCS", side: "BUY", type: "LIMIT", qty, limitPrice: limit, at: rest });
    const touch = firstTouch("TCS", rest, limit, "BUY");
    expect(touch).toBeDefined();
    buy("ITC", 1, t(5, "10:15")); // writes the fill for good
    const fill = engine.tradeHistory(t(5, "10:15")).find((h) => h.symbol === "TCS")!;
    expect(fill.simTime).toBe(touch!.ts);

    // Day 0 is before the order was placed, so nothing is reserved there and the cash
    // check passes; the replay is what catches it.
    const at = t(0, "10:15");
    const itc = market.priceAt("ITC", at);
    const err = tradeError(() => buy("ITC", Math.floor(START / itc), at), "LEDGER_CONFLICT");
    expect(err.message).toContain(`your buy of ${qty} TCS at ${label(touch!.ts)}`);
    expect(rows("trades")).toHaveLength(2);
    checkBooks(t(5, "10:15"));
  });

  it("never shows more blocked than there is cash, or a negative available balance", () => {
    // Regression: the resting order reserved nine tenths of the cash, then a trade made
    // before it was ever placed spent that cash, and available cash came out negative.
    const rest = t(5, "10:15");
    const limit = roundToTick(market.priceAt("TCS", rest) * 0.99, "down");
    const qty = Math.floor((START * 0.9) / limit);
    engine.placeOrder({ symbol: "TCS", side: "BUY", type: "LIMIT", qty, limitPrice: limit, at: rest });
    const back = t(2, "10:15");
    buy("ITC", Math.floor((START * 0.9) / market.priceAt("ITC", back)), back);

    const s = engine.portfolio(rest).summary;
    expect(s.blockedForOrders).toBeLessThanOrEqual(s.cash);
    expect(s.availableCash).toBe(0);
    expect(s.cash).toBe(s.blockedForOrders + s.availableCash);
    tradeError(() => buy("ITC", 1, rest), "INSUFFICIENT_FUNDS");
    checkBooks(rest);
  });

  it("will not cancel an order from a view where it still looks open", () => {
    // Debatable, documented as it stands: the fill is already on the ledger, so cancelling
    // from before it would have to unwind a trade. The order reads OPEN at that time anyway.
    const at = t(1, "10:15");
    const limit = roundToTick(market.priceAt("SBIN", at) * 0.99, "down");
    const order = engine.placeOrder({ symbol: "SBIN", side: "BUY", type: "LIMIT", qty: 1, limitPrice: limit, at });
    const touch = firstTouch("SBIN", at, limit, "BUY");
    expect(touch).toBeDefined();
    buy("ITC", 1, t(9, "10:15")); // trading past the touch writes the fill for good

    const before = t(1, "11:15");
    expect(before).toBeLessThan(touch!.ts);
    expect(engine.orderView(order.id, before)!.status).toBe("OPEN");
    const err = tradeError(() => engine.cancelOrder(order.id, before), "NOT_OPEN");
    expect(err.message).toContain("already filled");
  });

  it("fills an order placed after another one but earlier in market time", () => {
    const late = t(6, "10:15");
    const lateLimit = roundToTick(market.prevCloseAt("INFY", late) * 0.9, "up");
    const second = engine.placeOrder({ symbol: "INFY", side: "BUY", type: "LIMIT", qty: 1, limitPrice: lateLimit, at: late });

    const early = t(1, "10:15");
    const earlyLimit = roundToTick(market.priceAt("TCS", early) * 0.99, "down");
    const first = engine.placeOrder({ symbol: "TCS", side: "BUY", type: "LIMIT", qty: 1, limitPrice: earlyLimit, at: early });
    const touch = firstTouch("TCS", early, earlyLimit, "BUY");
    expect(touch).toBeDefined();
    expect(touch!.ts).toBeLessThan(late); // it fills before the other order was even placed

    const seen = engine.orders(touch!.ts);
    expect(seen.map((o) => o.id)).toEqual([first.id]); // the other one is still in the future
    expect(seen[0].status).toBe("FILLED");
    expect(engine.orders(t(-1, "15:15")).map((o) => o.id).sort()).toEqual([first.id, second.id].sort());
  });

  it("cancels a back-dated order at its own placement time and never earlier", () => {
    const at = t(3, "10:15");
    const limit = roundToTick(market.prevCloseAt("ITC", at) * 0.9, "up");
    buy("ITC", 1, t(7, "10:15")); // a trade after the order, to prove the cancel ignores it
    const order = engine.placeOrder({ symbol: "ITC", side: "BUY", type: "LIMIT", qty: 1, limitPrice: limit, at });
    tradeError(() => engine.cancelOrder(order.id, at - 1), "NOT_FOUND");
    const cancelled = engine.cancelOrder(order.id, at);
    expect(cancelled).toMatchObject({ status: "CANCELLED", resolvedAt: at }); // max(at, placedAt)
    expect(engine.orders(t(7, "10:15")).find((o) => o.id === order.id)!.status).toBe("CANCELLED");
  });
});

describe("accounting after back-dating", () => {
  it("recomputes a later sale's realized P&L against the new average cost", () => {
    const early = t(0, "11:15");
    const mid = t(3, "11:15");
    const late = t(6, "11:15");
    const pEarly = market.priceAt("INFY", early);
    const pMid = market.priceAt("INFY", mid);
    const pLate = market.priceAt("INFY", late);

    buy("INFY", 10, mid);
    const sale = sell("INFY", 4, late);
    const before = 4 * pLate - 4 * pMid; // sold against the day 3 price alone
    expect(engine.portfolio(late).summary.realizedPnl).toBe(before);

    // Ten more shares bought back on the first day move the weighted average.
    expect(buy("INFY", 10, early).status).toBe("FILLED");
    const cost = 10 * pEarly + 10 * pMid;
    const removed = Math.round((cost * 4) / 20);
    const after = 4 * pLate - removed;
    expect(after).not.toBe(before);

    const p = engine.portfolio(late);
    expect(p.summary.realizedPnl).toBe(after);
    expect(p.holdings[0]).toMatchObject({ qty: 16, invested: cost - removed });
    expect(p.holdings[0].avgPrice).toBeCloseTo((cost - removed) / 16, 6);

    // The tape and the performance stats carry the same number.
    const tape = engine.tradeHistory(late).find((h) => h.orderId === sale.id)!;
    expect(tape.realizedPnl).toBe(after);
    const perf = engine.performance(late);
    expect(perf.stats.bestTrade).toMatchObject({ symbol: "INFY", pnl: after, simTime: late });
    expect(perf.stats.closedTrades).toBe(1);
    checkBooks(late);
  });

  it("keeps every identity and the whole curve in step after several back-dated trades", () => {
    engine.setChargesEnabled(true);
    buy("TCS", 20, t(10, "10:15"));
    sell("TCS", 5, t(12, "14:15"));
    buy("SBIN", 40, t(11, "09:45"));
    // Now go back and trade in the middle of all of it.
    buy("TCS", 10, t(2, "10:15"));
    sell("TCS", 3, t(5, "11:15"));
    buy("SBIN", 10, t(7, "12:15"));
    buy("TCS", 4, t(11, "15:15"));

    const end = t(13, "15:15");
    expect(engine.tradeHistory(end)).toHaveLength(7);
    for (const at of [t(2, "10:15"), t(4, "10:15"), t(6, "10:15"), t(8, "10:15"), t(11, "10:15"), end]) {
      const p = checkBooks(at);
      expect(p.summary.charges).toBeGreaterThan(0);
    }
    // Every point of the curve matches the portfolio at that candle.
    const perf = engine.performance(end);
    for (const ts of [t(3, "09:15"), t(6, "12:15"), t(11, "15:15")]) {
      expect(perf.curve.find((c) => c.ts === ts)!.netWorth).toBe(engine.portfolio(ts).summary.netWorth);
    }
    expect(perf.curve).toHaveLength(market.timeline.filter((ts) => ts <= end).length);
  });
});

describe("as-of views after back-dating", () => {
  it("fills in earlier views that used to be empty and leaves older ones alone", () => {
    const late = t(8, "10:15");
    buy("TCS", 5, late);
    const view = t(3, "10:15");
    expect(engine.portfolio(view).holdings).toHaveLength(0);
    expect(engine.orders(view)).toHaveLength(0);
    expect(engine.performance(view).stats.tradeCount).toBe(0);

    const back = buy("TCS", 2, t(3, "09:45"));
    expect(engine.portfolio(view).holdings[0].qty).toBe(2);
    expect(engine.tradeHistory(view)).toHaveLength(1);
    expect(engine.orders(view).map((o) => o.id)).toEqual([back.id]);
    expect(engine.performance(view).stats.tradeCount).toBe(1);

    // Older than the back-dated trade, nothing has changed.
    expect(engine.portfolio(t(3, "09:44")).holdings).toHaveLength(0);
    expect(engine.tradeHistory(t(2, "15:15"))).toHaveLength(0);
    // And the later view still holds everything.
    expect(engine.portfolio(late).holdings[0].qty).toBe(7);
  });

  it("writes nothing when a later time is viewed after a back-dated trade", () => {
    const at = t(4, "10:15");
    buy("RELIANCE", 10, t(9, "10:15"));
    const limit = roundToTick(market.priceAt("TCS", at) * 0.99, "down");
    engine.placeOrder({ symbol: "TCS", side: "BUY", type: "LIMIT", qty: 5, limitPrice: limit, at });
    buy("ITC", 5, t(1, "10:15"));
    const before = JSON.stringify({ orders: rows("orders"), trades: rows("trades") });

    for (const view of [t(0, "09:15"), t(5, "10:15"), t(-1, "15:15")]) {
      engine.portfolio(view);
      engine.orders(view);
      engine.tradeHistory(view);
      engine.performance(view);
    }
    expect(JSON.stringify({ orders: rows("orders"), trades: rows("trades") })).toBe(before);
  });
});

describe("HTTP layer", () => {
  it("answers a ledger conflict with 422, the code and the clashing trade", async () => {
    const app = createApp(engine);
    const late = t(8, "11:15");
    buy("SBIN", 100, t(1, "10:15"));
    sell("SBIN", 100, late);

    const res = await request(app).post("/api/orders").send({ symbol: "sbin", side: "SELL", qty: 40, at: t(4, "10:15") });
    expect(res.status).toBe(422);
    expect(res.headers["content-type"]).toMatch(/json/);
    expect(res.body.error.code).toBe("LEDGER_CONFLICT");
    expect(res.body.error.message).toContain(`your sell of 100 SBIN at ${label(late)}`);
    // Nothing was placed, so the account is exactly as it was.
    expect(rows("orders")).toHaveLength(2);
  });

  it("serves the rejection reason of a resting order a back-dated trade broke", async () => {
    const app = createApp(engine);
    const rest = t(5, "10:15");
    const limit = roundToTick(market.priceAt("TCS", rest) * 0.99, "down");
    const qty = Math.floor((START * 0.9) / limit);
    const order = engine.placeOrder({ symbol: "TCS", side: "BUY", type: "LIMIT", qty, limitPrice: limit, at: rest });
    const back = t(2, "10:15");
    buy("ITC", Math.floor((START * 0.9) / market.priceAt("ITC", back)), back);

    const res = await request(app).get(`/api/orders?at=${t(-1, "15:15")}`);
    expect(res.status).toBe(200);
    const view = res.body.find((o: { id: number }) => o.id === order.id);
    expect(view.status).toBe("REJECTED");
    expect(view.reason).toMatch(/Not enough cash/);
    const portfolio = await request(app).get(`/api/portfolio?at=${t(-1, "15:15")}`);
    expect(portfolio.body.summary.cash).toBeGreaterThanOrEqual(0);
  });
});
