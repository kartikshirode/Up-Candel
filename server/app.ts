import express, { type NextFunction, type Request, type Response } from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CANDLE_SECONDS, epochToIsoIst } from "../shared/market.ts";
import { RATES } from "../shared/charges.ts";
import { Engine, TradeError } from "./engine.ts";

const atQuery = z.coerce.number().int().positive();

/** Reads the simulated time from ?at=, defaulting to the first candle of the data. */
function atOf(req: Request, engine: Engine): number {
  const raw = req.query.at;
  if (raw === undefined) return engine.market.range.start;
  const parsed = atQuery.safeParse(raw);
  if (!parsed.success) throw new TradeError("BAD_TIME", "The at parameter must be epoch seconds.", 400);
  return parsed.data;
}

const orderBody = z.object({
  symbol: z.string().trim().toUpperCase(),
  side: z.enum(["BUY", "SELL"]),
  type: z.enum(["MARKET", "LIMIT"]).default("MARKET"),
  qty: z.number().int().positive().max(1_000_000),
  limitPrice: z.number().positive().optional(), // rupees
  at: z.number().int().positive(),
  note: z.string().max(280).optional(),
});

const resetBody = z.object({
  startingCash: z.number().min(10_000).max(10_00_00_000).default(10_00_000), // rupees
  chargesEnabled: z.boolean().default(true),
});

export function createApp(engine: Engine) {
  const app = express();
  app.use(express.json());
  const { market } = engine;

  app.get("/api/health", (_req, res) => { res.json({ ok: true }); });

  app.get("/api/meta", (_req, res) => {
    const account = engine.account();
    res.json({
      range: market.range,
      timeline: market.timeline,
      tradingDays: market.tradingDays,
      candleSeconds: CANDLE_SECONDS,
      stocks: market.stocks.map((s) => ({ symbol: s.symbol, name: s.name, sector: s.sector, exchange: s.exchange })),
      account: { name: account.name, startingCash: account.starting_cash, chargesEnabled: !!account.charges_enabled },
      latestActivity: engine.latestActivity(),
      chargeRates: RATES,
    });
  });

  app.get("/api/market", (req, res) => {
    const at = atOf(req, engine);
    res.json({
      at,
      status: market.status(at),
      latestActivity: engine.latestActivity(),
      quotes: market.stocks.map((s) => {
        const list = market.candlesOf(s.symbol);
        const i = market.indexAt(s.symbol, at);
        // Closes of the current session so far, for the watchlist sparkline.
        const q = market.quote(s.symbol, at);
        const spark = q.candleTs === null ? [] : list.slice(Math.max(0, i - 12), i + 1).map((c) => c.close);
        return { ...q, name: s.name, sector: s.sector, spark };
      }),
    });
  });

  app.get("/api/stocks/:symbol/candles", (req, res) => {
    const at = atOf(req, engine);
    const symbol = String(req.params.symbol).toUpperCase();
    if (!market.stock(symbol)) throw new TradeError("UNKNOWN_SYMBOL", `No stock called ${symbol}.`, 404);
    res.json({
      symbol,
      quote: market.quote(symbol, at),
      candles: market.candlesOf(symbol).filter((c) => c.ts <= at),
    });
  });

  app.get("/api/portfolio", (req, res) => { res.json(engine.portfolio(atOf(req, engine))); });
  app.get("/api/orders", (req, res) => { res.json(engine.orders(atOf(req, engine))); });
  app.get("/api/performance", (req, res) => { res.json(engine.performance(atOf(req, engine))); });

  app.get("/api/transactions", (req, res) => {
    const trades = engine.tradeHistory(atOf(req, engine));
    if (req.query.format !== "csv") { res.json(trades); return; }
    const rupees = (p: number | null) => (p === null ? "" : (p / 100).toFixed(2));
    const quote = (s: string | null) => (s ? `"${s.replaceAll('"', '""')}"` : "");
    const lines = ["trade_id,order_id,time_ist,symbol,side,qty,price,value,charges,net_amount,realized_pnl,note"];
    for (const t of [...trades].reverse()) {
      lines.push([t.id, t.orderId, epochToIsoIst(t.simTime), t.symbol, t.side, t.qty, rupees(t.price), rupees(t.value), rupees(t.charges), rupees(t.netAmount), rupees(t.realizedPnl), quote(t.note)].join(","));
    }
    res.type("text/csv").attachment("up-candel-tradebook.csv").send(lines.join("\n") + "\n");
  });

  app.get("/api/what-if", (req, res) => {
    const at = atOf(req, engine);
    const from = req.query.from === undefined ? market.range.start : atQuery.parse(req.query.from);
    const amount = req.query.amount === undefined ? 1_00_000_00 : Math.round(z.coerce.number().positive().parse(req.query.amount) * 100);
    if (from > at) throw new TradeError("BAD_RANGE", "The start time must be before the current time.", 400);
    res.json(engine.whatIf(from, at, amount));
  });

  app.post("/api/orders", (req, res) => {
    const body = orderBody.parse(req.body);
    const order = engine.placeOrder({
      ...body,
      limitPrice: body.limitPrice === undefined ? undefined : Math.round(body.limitPrice * 100),
    });
    res.status(201).json(order);
  });

  app.post("/api/orders/:id/cancel", (req, res) => {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const at = z.object({ at: z.number().int().positive() }).parse(req.body).at;
    res.json(engine.cancelOrder(id, at));
  });

  app.patch("/api/account", (req, res) => {
    const { chargesEnabled } = z.object({ chargesEnabled: z.boolean() }).parse(req.body);
    engine.setChargesEnabled(chargesEnabled);
    res.json({ chargesEnabled });
  });

  app.post("/api/account/reset", (req, res) => {
    const body = resetBody.parse(req.body ?? {});
    engine.reset(Math.round(body.startingCash * 100), body.chargesEnabled);
    res.json({ ok: true });
  });

  app.use("/api", (_req, res) => { res.status(404).json({ error: { code: "NOT_FOUND", message: "No such endpoint." } }); });

  // In production the built React app is served from the same process.
  const clientDist = join(import.meta.dirname, "..", "client", "dist");
  if (existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.get("/{*splat}", (_req, res) => { res.sendFile(join(clientDist, "index.html")); });
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof TradeError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
    } else if (err instanceof z.ZodError) {
      const first = err.issues[0];
      res.status(400).json({ error: { code: "BAD_REQUEST", message: `${first.path.join(".") || "body"}: ${first.message}` } });
    } else {
      console.error(err);
      res.status(500).json({ error: { code: "INTERNAL", message: "Something went wrong on the server." } });
    }
  });

  return app;
}
