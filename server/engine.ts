import { epochToIst, roundToTick, tickPaise, type OrderType, type Side } from "../shared/market.ts";
import { computeCharges, NO_CHARGES, type ChargeBreakdown } from "../shared/charges.ts";
import type { DB } from "./db.ts";
import type { Market } from "./market.ts";

export class TradeError extends Error {
  constructor(public code: string, message: string, public status = 422) {
    super(message);
  }
}

export interface OrderRow {
  id: number;
  symbol: string;
  side: Side;
  type: OrderType;
  qty: number;
  limit_price: number | null;
  status: "OPEN" | "FILLED" | "CANCELLED" | "REJECTED";
  placed_at: number;
  resolved_at: number | null;
  reason: string | null;
  note: string | null;
}

export interface TradeRow {
  id: number;
  order_id: number;
  symbol: string;
  side: Side;
  qty: number;
  price: number;
  charges: number;
  charges_json: string;
  sim_time: number;
  note: string | null;
}

interface Position { qty: number; cost: number; todayQty: number; todayCost: number; realized: number }

interface Ledger {
  cash: number;
  positions: Map<string, Position>;
  realized: number;
  charges: number;
  realizedByTrade: Map<number, number>;
}

export interface PlaceOrderInput {
  symbol: string;
  side: Side;
  type: OrderType;
  qty: number;
  limitPrice?: number; // paise
  at: number;
  note?: string;
}

const fmt = (paise: number) => `Rs ${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtTime = (ts: number) => { const t = epochToIst(ts); return `${t.date} ${t.time}`; };

/**
 * The trading engine. All money is integer paise and all times are simulated market time.
 *
 * Two rules keep the ledger consistent while the user moves the clock around:
 *  - Every view is "as of" the selected time: only trades at or before it count.
 *  - Trading only moves forward: a new order cannot be placed earlier than the latest
 *    activity already on the ledger.
 */
export class Engine {
  constructor(private readonly db: DB, readonly market: Market) {}

  account() {
    return this.db.prepare("SELECT name, starting_cash, charges_enabled FROM account WHERE id = 1").get() as {
      name: string; starting_cash: number; charges_enabled: number;
    };
  }

  setChargesEnabled(enabled: boolean) {
    this.db.prepare("UPDATE account SET charges_enabled = ? WHERE id = 1").run(enabled ? 1 : 0);
  }

  reset(startingCash: number, chargesEnabled: boolean) {
    this.db.transaction(() => {
      this.db.exec("DELETE FROM trades; DELETE FROM orders; DELETE FROM sqlite_sequence WHERE name IN ('trades', 'orders');");
      this.db.prepare("UPDATE account SET starting_cash = ?, charges_enabled = ? WHERE id = 1").run(startingCash, chargesEnabled ? 1 : 0);
    })();
  }

  /** Latest simulated time anything happened on the ledger, or null for a fresh account. */
  latestActivity(): number | null {
    const row = this.db.prepare(`
      SELECT MAX(t) AS t FROM (
        SELECT MAX(sim_time) AS t FROM trades
        UNION ALL SELECT MAX(placed_at) FROM orders
        UNION ALL SELECT MAX(resolved_at) FROM orders
      )`).get() as { t: number | null };
    return row.t;
  }

  private trades(at: number): TradeRow[] {
    return this.db.prepare("SELECT * FROM trades WHERE sim_time <= ? ORDER BY sim_time, id").all(at) as TradeRow[];
  }

  /** Replays the trade ledger up to `at` using the weighted average cost method. */
  private ledger(at: number): Ledger {
    const startingCash = this.account().starting_cash;
    const day = this.market.status(at).tradingDay ?? epochToIst(at).date;
    const led: Ledger = { cash: startingCash, positions: new Map(), realized: 0, charges: 0, realizedByTrade: new Map() };
    for (const t of this.trades(at)) {
      const gross = t.qty * t.price;
      const pos = led.positions.get(t.symbol) ?? { qty: 0, cost: 0, todayQty: 0, todayCost: 0, realized: 0 };
      const isToday = epochToIst(t.sim_time).date === day;
      led.charges += t.charges;
      if (t.side === "BUY") {
        led.cash -= gross + t.charges;
        pos.qty += t.qty;
        pos.cost += gross;
        if (isToday) { pos.todayQty += t.qty; pos.todayCost += gross; }
      } else {
        led.cash += gross - t.charges;
        // Average cost is unchanged by a sale; the cost basis leaves in proportion.
        const removed = Math.round((pos.cost * t.qty) / pos.qty);
        const realized = gross - removed;
        pos.realized += realized;
        led.realized += realized;
        led.realizedByTrade.set(t.id, realized);
        pos.qty -= t.qty;
        pos.cost -= removed;
        if (pos.todayQty > 0) {
          // Shares sold today come out of today's buys last, so older holdings keep their day P&L basis.
          const fromToday = Math.max(0, t.qty - (pos.qty + t.qty - pos.todayQty));
          if (fromToday > 0) {
            pos.todayCost -= Math.round((pos.todayCost * fromToday) / pos.todayQty);
            pos.todayQty -= fromToday;
          }
        }
        if (pos.qty === 0) { pos.cost = 0; pos.todayQty = 0; pos.todayCost = 0; }
      }
      led.positions.set(t.symbol, pos);
    }
    return led;
  }

  private openOrders(at?: number): OrderRow[] {
    return at === undefined
      ? (this.db.prepare("SELECT * FROM orders WHERE status = 'OPEN' ORDER BY placed_at, id").all() as OrderRow[])
      : (this.db.prepare("SELECT * FROM orders WHERE status = 'OPEN' AND placed_at <= ? ORDER BY placed_at, id").all(at) as OrderRow[]);
  }

  private chargesFor(side: Side, symbol: string, qty: number, price: number, at: number): ChargeBreakdown {
    if (!this.account().charges_enabled) return NO_CHARGES;
    let firstSellOfDay = true;
    if (side === "SELL") {
      const day = epochToIst(at).date;
      const sells = this.db.prepare("SELECT sim_time FROM trades WHERE symbol = ? AND side = 'SELL'").all(symbol) as { sim_time: number }[];
      firstSellOfDay = !sells.some((s) => epochToIst(s.sim_time).date === day);
    }
    return computeCharges(side, qty * price, firstSellOfDay);
  }

  /** Cash already promised to resting buy orders, and shares promised to resting sell orders. */
  private reservations(at: number, excludeOrderId?: number) {
    let cash = 0;
    const shares = new Map<string, number>();
    for (const o of this.openOrders(at)) {
      if (o.id === excludeOrderId) continue;
      if (o.side === "BUY") {
        cash += o.qty * o.limit_price! + (this.account().charges_enabled ? computeCharges("BUY", o.qty * o.limit_price!).total : 0);
      } else {
        shares.set(o.symbol, (shares.get(o.symbol) ?? 0) + o.qty);
      }
    }
    return { cash, shares };
  }

  private insertFill(order: Pick<OrderRow, "id" | "symbol" | "side" | "qty" | "note">, price: number, at: number, charges: ChargeBreakdown) {
    this.db.prepare(`INSERT INTO trades (order_id, symbol, side, qty, price, charges, charges_json, sim_time, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(order.id, order.symbol, order.side, order.qty, price, charges.total, JSON.stringify(charges), at, order.note);
    this.db.prepare("UPDATE orders SET status = 'FILLED', resolved_at = ? WHERE id = ?").run(at, order.id);
  }

  /**
   * Walks resting limit orders forward through the candles up to `at` and fills any whose
   * price was reached. A buy fills when a candle's low touches the limit, at the better of the
   * limit and the candle open (so a gap down fills at the open). Sells mirror this.
   */
  processPendingOrders(at: number) {
    const run = this.db.transaction(() => {
      for (;;) {
        let next: { order: OrderRow; ts: number; price: number } | null = null;
        for (const o of this.openOrders()) {
          const list = this.market.candlesOf(o.symbol);
          const from = this.market.indexAt(o.symbol, o.placed_at) + 1;
          for (let i = from; i < list.length && list[i].ts <= at; i++) {
            const c = list[i];
            const hit = o.side === "BUY" ? c.low <= o.limit_price! : c.high >= o.limit_price!;
            if (!hit) continue;
            const price = o.side === "BUY" ? Math.min(o.limit_price!, c.open) : Math.max(o.limit_price!, c.open);
            if (!next || c.ts < next.ts || (c.ts === next.ts && o.id < next.order.id)) next = { order: o, ts: c.ts, price };
            break;
          }
        }
        if (!next) return;

        const { order, ts, price } = next;
        const charges = this.chargesFor(order.side, order.symbol, order.qty, price, ts);
        const led = this.ledger(ts);
        const reserved = this.reservations(ts, order.id);
        let rejection: string | null = null;
        if (order.side === "BUY" && order.qty * price + charges.total > led.cash - reserved.cash) {
          rejection = "Not enough cash when the limit price was reached";
        }
        const held = led.positions.get(order.symbol)?.qty ?? 0;
        if (order.side === "SELL" && order.qty > held - (reserved.shares.get(order.symbol) ?? 0)) {
          rejection = "Not enough shares when the limit price was reached";
        }
        if (rejection) {
          this.db.prepare("UPDATE orders SET status = 'REJECTED', resolved_at = ?, reason = ? WHERE id = ?").run(ts, rejection, order.id);
        } else {
          this.insertFill(order, price, ts, charges);
        }
      }
    });
    run();
  }

  placeOrder(input: PlaceOrderInput) {
    const { symbol, side, type, qty, at } = input;
    const note = input.note?.trim() || null;
    const stock = this.market.stock(symbol);
    if (!stock) throw new TradeError("UNKNOWN_SYMBOL", `No stock called ${symbol}.`, 404);
    if (!Number.isInteger(qty) || qty <= 0) throw new TradeError("BAD_QTY", "Quantity must be a whole number above zero.");

    const status = this.market.status(at);
    if (!status.isOpen) throw new TradeError("MARKET_CLOSED", `Market is closed at ${fmtTime(at)} (${status.label}). Orders are accepted 09:15-15:30 on trading days.`);

    this.processPendingOrders(at);

    const latest = this.latestActivity();
    if (latest !== null && at < latest) {
      throw new TradeError("TIME_TRAVEL", `Your ledger already has activity at ${fmtTime(latest)}. Trading only moves forward, so move the clock to ${fmtTime(latest)} or later, or reset the account.`);
    }

    const ltp = this.market.priceAt(symbol, at);
    let limit: number | null = null;
    if (type === "LIMIT") {
      limit = input.limitPrice ?? NaN;
      if (!Number.isInteger(limit) || limit <= 0) throw new TradeError("BAD_PRICE", "Enter a limit price above zero.");
      const tick = tickPaise(limit);
      if (limit % tick !== 0) {
        throw new TradeError("BAD_TICK", `Limit price must be a multiple of the tick size, ${fmt(tick)} at this price. Try ${fmt(roundToTick(limit))}.`);
      }
      const ref = this.market.prevCloseAt(symbol, at);
      if (limit > ref * 1.1 || limit < ref * 0.9) {
        throw new TradeError("PRICE_BAND", `Limit price is outside today's price band of ${fmt(roundToTick(ref * 0.9, "up"))} to ${fmt(roundToTick(ref * 1.1, "down"))}.`);
      }
    }

    // A limit order at or through the market price is marketable and fills straight away.
    const fillsNow = type === "MARKET" || (side === "BUY" ? limit! >= ltp : limit! <= ltp);
    const fillPrice = fillsNow ? ltp : limit!;

    const led = this.ledger(at);
    const reserved = this.reservations(at);
    const charges = this.chargesFor(side, symbol, qty, fillPrice, at);
    if (side === "BUY") {
      const need = qty * fillPrice + charges.total;
      const available = led.cash - reserved.cash;
      if (need > available) {
        const maxQty = Math.floor(available / (fillPrice * 1.0012));
        throw new TradeError("INSUFFICIENT_FUNDS", `This order needs ${fmt(need)} but you have ${fmt(Math.max(0, available))} available. You can buy up to ${Math.max(0, maxQty)} shares.`);
      }
    } else {
      const held = led.positions.get(symbol)?.qty ?? 0;
      const free = held - (reserved.shares.get(symbol) ?? 0);
      if (qty > free) {
        throw new TradeError("INSUFFICIENT_HOLDINGS", free > 0
          ? `You can sell at most ${free} ${symbol} shares${held !== free ? " (the rest are in open sell orders)" : ""}.`
          : `You don't hold any ${symbol} shares to sell. Short selling isn't allowed.`);
      }
    }

    const orderId = this.db.transaction(() => {
      const res = this.db.prepare(`INSERT INTO orders (symbol, side, type, qty, limit_price, status, placed_at, note)
        VALUES (?, ?, ?, ?, ?, 'OPEN', ?, ?)`).run(symbol, side, type, qty, limit, at, note);
      const id = Number(res.lastInsertRowid);
      if (fillsNow) this.insertFill({ id, symbol, side, qty, note }, fillPrice, at, charges);
      return id;
    })();

    return this.orderView(orderId, at)!;
  }

  cancelOrder(id: number, at: number) {
    this.processPendingOrders(at);
    const order = this.db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as OrderRow | undefined;
    if (!order || order.placed_at > at) throw new TradeError("NOT_FOUND", "No such order at this time.", 404);
    if (order.status !== "OPEN") throw new TradeError("NOT_OPEN", `Order #${id} is already ${order.status.toLowerCase()}.`);
    const latest = this.latestActivity();
    if (latest !== null && at < latest) {
      throw new TradeError("TIME_TRAVEL", `Your ledger already has activity at ${fmtTime(latest)}. Move the clock forward to cancel.`);
    }
    this.db.prepare("UPDATE orders SET status = 'CANCELLED', resolved_at = ? WHERE id = ?").run(at, id);
    return this.orderView(id, at)!;
  }

  private orderAsOf(o: OrderRow, at: number) {
    // Seen from an earlier time, an order that filled or was cancelled later is still open.
    const resolvedByThen = o.resolved_at !== null && o.resolved_at <= at;
    const trade = resolvedByThen && o.status === "FILLED"
      ? (this.db.prepare("SELECT price, charges, sim_time FROM trades WHERE order_id = ?").get(o.id) as { price: number; charges: number; sim_time: number })
      : null;
    return {
      id: o.id,
      symbol: o.symbol,
      side: o.side,
      type: o.type,
      qty: o.qty,
      limitPrice: o.limit_price,
      status: resolvedByThen ? o.status : "OPEN",
      placedAt: o.placed_at,
      resolvedAt: resolvedByThen ? o.resolved_at : null,
      fillPrice: trade?.price ?? null,
      charges: trade?.charges ?? null,
      reason: resolvedByThen ? o.reason : null,
      note: o.note,
    };
  }

  orderView(id: number, at: number) {
    const o = this.db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as OrderRow | undefined;
    return o ? this.orderAsOf(o, at) : null;
  }

  orders(at: number) {
    this.processPendingOrders(at);
    const rows = this.db.prepare("SELECT * FROM orders WHERE placed_at <= ? ORDER BY placed_at DESC, id DESC").all(at) as OrderRow[];
    return rows.map((o) => this.orderAsOf(o, at));
  }

  tradeHistory(at: number) {
    this.processPendingOrders(at);
    const led = this.ledger(at);
    return this.trades(at).reverse().map((t) => ({
      id: t.id,
      orderId: t.order_id,
      symbol: t.symbol,
      side: t.side,
      qty: t.qty,
      price: t.price,
      value: t.qty * t.price,
      charges: t.charges,
      chargesBreakdown: JSON.parse(t.charges_json) as ChargeBreakdown,
      netAmount: t.side === "BUY" ? -(t.qty * t.price + t.charges) : t.qty * t.price - t.charges,
      realizedPnl: led.realizedByTrade.get(t.id) ?? null,
      simTime: t.sim_time,
      note: t.note,
    }));
  }

  portfolio(at: number) {
    this.processPendingOrders(at);
    const account = this.account();
    const led = this.ledger(at);
    const reserved = this.reservationsAsOf(at);

    const holdings = [...led.positions.entries()]
      .filter(([, p]) => p.qty > 0)
      .map(([symbol, p]) => {
        const stock = this.market.stock(symbol)!;
        const q = this.market.quote(symbol, at);
        const value = p.qty * q.ltp;
        const heldQty = p.qty - p.todayQty;
        const todayAvg = p.todayQty > 0 ? p.todayCost / p.todayQty : 0;
        const dayPnl = Math.round(heldQty * (q.ltp - q.prevClose) + p.todayQty * (q.ltp - todayAvg));
        return {
          symbol,
          name: stock.name,
          sector: stock.sector,
          qty: p.qty,
          avgPrice: p.cost / p.qty,
          invested: p.cost,
          ltp: q.ltp,
          currentValue: value,
          unrealizedPnl: value - p.cost,
          unrealizedPct: ((value - p.cost) / p.cost) * 100,
          dayPnl,
          dayChangePct: q.changePct,
          realizedPnl: p.realized,
        };
      })
      .sort((a, b) => b.currentValue - a.currentValue);

    const invested = holdings.reduce((n, h) => n + h.invested, 0);
    const currentValue = holdings.reduce((n, h) => n + h.currentValue, 0);
    const unrealized = currentValue - invested;
    const netWorth = led.cash + currentValue;
    const realizedBySymbol = [...led.positions.entries()].filter(([, p]) => p.qty === 0 && p.realized !== 0)
      .map(([symbol, p]) => ({ symbol, realizedPnl: p.realized }));

    return {
      account: { name: account.name, startingCash: account.starting_cash, chargesEnabled: !!account.charges_enabled },
      summary: {
        cash: led.cash,
        blockedForOrders: reserved,
        availableCash: led.cash - reserved,
        invested,
        currentValue,
        netWorth,
        unrealizedPnl: unrealized,
        realizedPnl: led.realized,
        charges: led.charges,
        totalPnl: netWorth - account.starting_cash,
        totalPnlPct: ((netWorth - account.starting_cash) / account.starting_cash) * 100,
        dayPnl: holdings.reduce((n, h) => n + h.dayPnl, 0),
      },
      holdings,
      closedPositions: realizedBySymbol,
    };
  }

  /** Cash blocked by buy orders that were open at `at`. */
  private reservationsAsOf(at: number): number {
    const charges = !!this.account().charges_enabled;
    return this.orders(at)
      .filter((o) => o.status === "OPEN" && o.side === "BUY")
      .reduce((n, o) => n + o.qty * o.limitPrice! + (charges ? computeCharges("BUY", o.qty * o.limitPrice!).total : 0), 0);
  }

  /**
   * Net worth at every candle from the start of the data to `at`, next to an equal-weight
   * index of all ten stocks that starts with the same money. Also trade statistics.
   */
  performance(at: number) {
    this.processPendingOrders(at);
    const startingCash = this.account().starting_cash;
    const points = this.market.timeline.filter((ts) => ts <= at);
    const trades = this.trades(at);
    const led = this.ledger(at);
    const symbols = this.market.stocks.map((s) => s.symbol);

    const positions = new Map<string, number>();
    let cash = startingCash;
    let ti = 0;
    let peak = startingCash;
    let maxDrawdown = 0;
    const curve = points.map((ts) => {
      for (; ti < trades.length && trades[ti].sim_time <= ts; ti++) {
        const t = trades[ti];
        const gross = t.qty * t.price;
        cash += t.side === "BUY" ? -(gross + t.charges) : gross - t.charges;
        positions.set(t.symbol, (positions.get(t.symbol) ?? 0) + (t.side === "BUY" ? t.qty : -t.qty));
      }
      let value = cash;
      for (const [symbol, qty] of positions) value += qty * this.market.priceAt(symbol, ts);
      const index = symbols.reduce((n, s) => n + this.market.priceAt(s, ts) / this.market.stock(s)!.prev_close, 0) / symbols.length;
      peak = Math.max(peak, value);
      maxDrawdown = Math.max(maxDrawdown, (peak - value) / peak);
      return { ts, netWorth: Math.round(value), benchmark: Math.round(startingCash * index) };
    });

    const last = curve[curve.length - 1];
    const sells = trades.filter((t) => t.side === "SELL").map((t) => ({ t, pnl: led.realizedByTrade.get(t.id)! }));
    const wins = sells.filter((s) => s.pnl > 0);
    const best = sells.reduce<typeof sells[number] | null>((b, s) => (!b || s.pnl > b.pnl ? s : b), null);
    const worst = sells.reduce<typeof sells[number] | null>((w, s) => (!w || s.pnl < w.pnl ? s : w), null);
    const portfolioReturn = last ? (last.netWorth / startingCash - 1) * 100 : 0;
    const benchmarkReturn = last ? (last.benchmark / startingCash - 1) * 100 : 0;

    return {
      curve,
      stats: {
        portfolioReturnPct: portfolioReturn,
        benchmarkReturnPct: benchmarkReturn,
        alphaPct: portfolioReturn - benchmarkReturn,
        maxDrawdownPct: maxDrawdown * 100,
        tradeCount: trades.length,
        closedTrades: sells.length,
        winRatePct: sells.length ? (wins.length / sells.length) * 100 : null,
        bestTrade: best ? { symbol: best.t.symbol, pnl: best.pnl, simTime: best.t.sim_time } : null,
        worstTrade: worst ? { symbol: worst.t.symbol, pnl: worst.pnl, simTime: worst.t.sim_time } : null,
        totalCharges: led.charges,
      },
    };
  }

  /** "If I had put this much into each stock at `from`, what would it be worth at `at`?" */
  whatIf(from: number, at: number, amount: number) {
    const rows = this.market.stocks.map((s) => {
      const buy = this.market.priceAt(s.symbol, from);
      const now = this.market.priceAt(s.symbol, at);
      const shares = Math.floor(amount / buy);
      const leftover = amount - shares * buy;
      const value = shares * now + leftover;
      return { symbol: s.symbol, name: s.name, buyPrice: buy, priceNow: now, shares, value, pnl: value - amount, returnPct: (now / buy - 1) * 100 };
    });
    return { from, at, amount, results: rows.sort((a, b) => b.returnPct - a.returnPct) };
  }
}
