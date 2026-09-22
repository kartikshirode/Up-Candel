import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Side } from "../../shared/market.ts";
import { api, type Candle, type MarketSnapshot, type Meta, type Order, type Performance, type Portfolio, type Trade } from "./api.ts";
import { atEndOfData, nextCandle, prevCandle } from "./clock.ts";
import { AccountDialog } from "./components/AccountDialog.tsx";
import { BottomPanel, type TabId } from "./components/BottomPanel.tsx";
import { OrderTicket } from "./components/OrderTicket.tsx";
import { PriceChart } from "./components/PriceChart.tsx";
import { ShortcutsDialog } from "./components/ShortcutsDialog.tsx";
import { Tape } from "./components/Tape.tsx";
import { Toasts, type Toast } from "./components/Toasts.tsx";
import { TopBar } from "./components/TopBar.tsx";
import { Watchlist } from "./components/Watchlist.tsx";

import type { Speed } from "./constants.ts";
const STEP_MS = 1400;

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable, fine */ }
}

export default function App() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [at, setAtState] = useState<number>(0);
  const [symbol, setSymbol] = useState<string>(() => load("uc.symbol", "RELIANCE"));
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>(() => load("uc.speed", 2));
  const [version, setVersion] = useState(0); // bumped after anything changes the ledger
  const [tab, setTab] = useState<TabId>(() => load("uc.tab", "holdings"));
  const [ticketIntent, setTicketIntent] = useState<{ side: Side; nonce: number }>({ side: "BUY", nonce: 0 });
  const [dialog, setDialog] = useState<"shortcuts" | "account" | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const [market, setMarket] = useState<MarketSnapshot | null>(null);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [tapeTrades, setTapeTrades] = useState<Trade[]>([]);
  const [performance, setPerformance] = useState<Performance | null>(null);
  const [candles, setCandles] = useState<Candle[]>([]);

  const setAt = useCallback((ts: number) => {
    setAtState(ts);
    save("uc.at", ts);
  }, []);

  useEffect(() => {
    api.meta().then((m) => {
      setMeta(m);
      const saved = load<number | null>("uc.at", null);
      const start = saved !== null && saved >= m.range.start && saved <= m.range.end ? saved : (m.latestActivity ?? m.range.start);
      setAtState(start);
    }).catch((e: Error) => setBootError(e.message));
  }, []);

  useEffect(() => save("uc.symbol", symbol), [symbol]);
  useEffect(() => save("uc.speed", speed), [speed]);
  useEffect(() => save("uc.tab", tab), [tab]);

  const pushToast = useCallback((t: Omit<Toast, "id">) => {
    const id = Date.now() + Math.random();
    setToasts((list) => [...list.slice(-3), { ...t, id }]);
    setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), t.kind === "error" ? 6500 : 4000);
  }, []);

  // Everything on screen is "as of" the simulated clock. Late responses are dropped.
  const requestId = useRef(0);
  useEffect(() => {
    if (!meta || !at) return;
    const id = ++requestId.current;
    Promise.all([api.market(at), api.portfolio(at), api.orders(at), api.trades(at), api.performance(at)])
      .then(async ([m, p, o, t, perf]) => {
        if (id !== requestId.current) return;
        setMarket(m); setPortfolio(p); setOrders(o); setTrades(t); setPerformance(perf);
        // The tape also shows trades made "later" than the clock, dimmed.
        const tapeAt = Math.max(at, m.latestActivity ?? 0);
        const all = tapeAt === at ? t : await api.trades(tapeAt);
        if (id === requestId.current) setTapeTrades(all);
      })
      .catch((e: Error) => { if (id === requestId.current) pushToast({ kind: "error", title: "Couldn't load the market", body: e.message }); });
  }, [meta, at, version, pushToast]);

  const candleRequest = useRef(0);
  useEffect(() => {
    if (!meta || !at) return;
    const id = ++candleRequest.current;
    api.candles(symbol, at).then((r) => { if (id === candleRequest.current) setCandles(r.candles); }).catch(() => {});
  }, [meta, symbol, at, version]);

  const nextTs = useCallback((from: number) => {
    if (!meta) return from;
    return nextCandle(meta.timeline, from) ?? from;
  }, [meta]);
  const prevTs = useCallback((from: number) => (meta ? prevCandle(meta.timeline, from) : from), [meta]);
  const finished = !!meta && atEndOfData(meta.timeline, at);

  // Replay: advance one candle per tick, and stop on the last one.
  useEffect(() => {
    if (!playing || !meta) return;
    const timer = setInterval(() => {
      setAtState((current) => {
        const next = nextCandle(meta.timeline, current);
        if (next === null) { setPlaying(false); return current; }
        save("uc.at", next);
        return next;
      });
    }, STEP_MS / speed);
    return () => clearInterval(timer);
  }, [playing, speed, meta]);

  // Play at the end of the data starts the replay again from the first candle.
  const togglePlay = useCallback(() => {
    if (!meta) return;
    if (!playing && atEndOfData(meta.timeline, at)) setAt(meta.range.start);
    setPlaying((p) => !p);
  }, [meta, playing, at, setAt]);

  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  const openTicket = useCallback((side: Side, sym?: string) => {
    if (sym) setSymbol(sym);
    setTicketIntent((t) => ({ side, nonce: t.nonce + 1 }));
  }, []);

  // Keyboard shortcuts, in the spirit of Kite.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable]") || e.metaKey || e.ctrlKey || e.altKey) return;
      if (dialog) { if (e.key === "Escape") setDialog(null); return; }
      if (!meta) return;
      const symbols = meta.stocks.map((s) => s.symbol);
      const i = symbols.indexOf(symbol);
      switch (e.key) {
        case "b": case "B": e.preventDefault(); openTicket("BUY"); break;
        case "s": case "S": e.preventDefault(); openTicket("SELL"); break;
        case " ": e.preventDefault(); togglePlay(); break;
        case "ArrowRight": e.preventDefault(); setPlaying(false); setAt(nextTs(at)); break;
        case "ArrowLeft": e.preventDefault(); setPlaying(false); setAt(prevTs(at)); break;
        case "ArrowDown": e.preventDefault(); setSymbol(symbols[(i + 1) % symbols.length]); break;
        case "ArrowUp": e.preventDefault(); setSymbol(symbols[(i - 1 + symbols.length) % symbols.length]); break;
        case "h": setTab("holdings"); break;
        case "o": setTab("orders"); break;
        case "t": setTab("trades"); break;
        case "p": setTab("performance"); break;
        case "w": setTab("whatif"); break;
        case "?": case "/": e.preventDefault(); setDialog("shortcuts"); break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [meta, symbol, at, dialog, nextTs, prevTs, setAt, openTicket, togglePlay]);

  const quote = useMemo(() => market?.quotes.find((q) => q.symbol === symbol) ?? null, [market, symbol]);
  const holding = portfolio?.holdings.find((h) => h.symbol === symbol) ?? null;

  if (bootError) {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div>
          <p className="text-base font-semibold">The trading server isn't responding.</p>
          <p className="mt-1 text-muted">{bootError} Start it with <code className="text-text">npm run dev</code> and reload.</p>
        </div>
      </div>
    );
  }
  if (!meta || !at || !market || !portfolio || !performance) {
    return <div className="grid h-full place-items-center text-muted">Loading the market…</div>;
  }

  const latest = market.latestActivity;
  return (
    <div className="flex min-h-full flex-col lg:h-full">
      <TopBar
        at={at} meta={meta} status={market.status} portfolio={portfolio}
        playing={playing} speed={speed} finished={finished}
        onTogglePlay={togglePlay}
        onStep={(dir) => { setPlaying(false); setAt(dir > 0 ? nextTs(at) : prevTs(at)); }}
        onSpeed={setSpeed}
        onSeek={(ts) => { setPlaying(false); setAt(ts); }}
        onOpenShortcuts={() => setDialog("shortcuts")}
        onOpenAccount={() => setDialog("account")}
      />
      <Tape meta={meta} at={at} curve={performance.curve} trades={tapeTrades} onSeek={(ts) => { setPlaying(false); setAt(ts); }} />

      <main className="grid flex-1 grid-cols-1 gap-px bg-line lg:min-h-0 lg:grid-cols-[272px_minmax(0,1fr)_312px]">
        <Watchlist
          quotes={market.quotes} selected={symbol} holdings={portfolio.holdings}
          onSelect={setSymbol} onTrade={openTicket}
        />
        <section className="flex min-h-0 min-w-0 flex-col bg-ink">
          <PriceChart symbol={symbol} quote={quote} candles={candles} trades={trades} orders={orders} holding={holding} />
          <BottomPanel
            tab={tab} onTab={setTab} at={at} meta={meta}
            portfolio={portfolio} orders={orders} trades={trades} performance={performance}
            onSelect={setSymbol} onTrade={openTicket}
            onCancel={async (id) => {
              try {
                await api.cancelOrder(id, at);
                pushToast({ kind: "info", title: `Cancelled order #${id}` });
                refresh();
              } catch (e) {
                pushToast({ kind: "error", title: "Couldn't cancel", body: (e as Error).message });
              }
            }}
          />
        </section>
        <OrderTicket
          at={at} quote={quote} status={market.status} portfolio={portfolio} orders={orders} latestActivity={latest} timeline={meta.timeline}
          intent={ticketIntent}
          onJumpTo={(ts) => { setPlaying(false); setAt(ts); }}
          onPlaced={(order) => {
            const verb = order.side === "BUY" ? "Bought" : "Sold";
            if (order.status === "FILLED") {
              pushToast({ kind: "success", title: `${verb} ${order.qty} ${order.symbol} at ${(order.fillPrice! / 100).toLocaleString("en-IN", { style: "currency", currency: "INR" })}`, body: `Order #${order.id}` });
            } else {
              pushToast({ kind: "info", title: `Limit order #${order.id} placed`, body: `${order.side === "BUY" ? "Buy" : "Sell"} ${order.qty} ${order.symbol} when the price reaches ${(order.limitPrice! / 100).toLocaleString("en-IN", { style: "currency", currency: "INR" })}. It fills as the replay moves forward.` });
            }
            refresh();
          }}
          onError={(msg) => pushToast({ kind: "error", title: "Order not placed", body: msg })}
        />
      </main>

      {dialog === "shortcuts" && <ShortcutsDialog onClose={() => setDialog(null)} />}
      {dialog === "account" && (
        <AccountDialog
          portfolio={portfolio}
          onClose={() => setDialog(null)}
          onChanged={(msg, restart) => {
            pushToast({ kind: "success", title: msg });
            if (restart) { setPlaying(false); setAt(meta.range.start); }
            refresh();
            api.meta().then(setMeta).catch(() => {});
          }}
        />
      )}
      <Toasts toasts={toasts} onDismiss={(id) => setToasts((l) => l.filter((t) => t.id !== id))} />
    </div>
  );
}
