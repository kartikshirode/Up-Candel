import { useEffect, useRef, useState } from "react";
import { computeCharges } from "../../../shared/charges.ts";
import { epochToIst, roundToTick, tickPaise, type OrderType, type Side } from "../../../shared/market.ts";
import { api, ApiError, type MarketStatus, type Order, type Portfolio, type Quote } from "../api.ts";
import { inr, int, price, when } from "../format.ts";

interface Props {
  at: number;
  quote: Quote | null;
  status: MarketStatus;
  portfolio: Portfolio;
  orders: Order[];
  latestActivity: number | null;
  timeline: number[];
  intent: { side: Side; nonce: number };
  onJumpTo: (ts: number) => void;
  onPlaced: (order: Order) => void;
  onError: (message: string) => void;
}

export function OrderTicket(p: Props) {
  const [side, setSide] = useState<Side>(p.intent.side);
  const [type, setType] = useState<OrderType>("MARKET");
  const [qty, setQty] = useState("1");
  const [limit, setLimit] = useState("");
  const [note, setNote] = useState("");
  const [showCharges, setShowCharges] = useState(false);
  const [busy, setBusy] = useState(false);
  const qtyRef = useRef<HTMLInputElement>(null);

  // A new stock starts with a clean form.
  const symbol = p.quote?.symbol;
  useEffect(() => {
    setQty("1");
    setLimit("");
    setType("MARKET");
  }, [symbol]);

  // B or S (or a Buy/Sell button elsewhere) picks the side and puts the cursor on quantity.
  useEffect(() => {
    if (p.intent.nonce === 0) return;
    setSide(p.intent.side);
    qtyRef.current?.focus();
    qtyRef.current?.select();
  }, [p.intent]);

  const q = p.quote;
  if (!q) return <aside className="bg-panel" />;

  const s = p.portfolio.summary;
  const holding = p.portfolio.holdings.find((h) => h.symbol === q.symbol);
  const openSellQty = p.orders.filter((o) => o.status === "OPEN" && o.side === "SELL" && o.symbol === q.symbol).reduce((n, o) => n + o.qty, 0);
  const freeQty = (holding?.qty ?? 0) - openSellQty;

  const qtyNum = Number(qty);
  const qtyValid = Number.isInteger(qtyNum) && qtyNum > 0;
  const limitPaise = Math.round(Number(limit) * 100);
  const limitValid = type === "MARKET" || (Number.isFinite(limitPaise) && limitPaise > 0);
  const offTick = type === "LIMIT" && limitValid && limitPaise % tickPaise(limitPaise) !== 0;
  const fillsNow = type === "MARKET" || (side === "BUY" ? limitPaise >= q.ltp : limitPaise <= q.ltp);
  const px = type === "MARKET" || fillsNow ? q.ltp : limitPaise;
  const value = qtyValid ? qtyNum * px : 0;
  const charges = p.portfolio.account.chargesEnabled && qtyValid ? computeCharges(side, value) : null;
  const total = side === "BUY" ? value + (charges?.total ?? 0) : value - (charges?.total ?? 0);
  const maxBuy = Math.max(0, Math.floor(s.availableCash / (px * (p.portfolio.account.chargesEnabled ? 1.0012 : 1))));

  const pastLedger = p.latestActivity !== null && p.at < p.latestActivity;
  const nextOpen = p.timeline.find((ts) => ts > p.at);

  let blocker: { text: string; action?: { label: string; ts: number } } | null = null;
  if (!p.status.isOpen) {
    blocker = { text: `${p.status.label}. Orders are accepted 09:15 to 15:30 on trading days.`, action: nextOpen ? { label: `Go to ${when(nextOpen)}`, ts: nextOpen } : undefined };
  } else if (pastLedger) {
    blocker = { text: `Your ledger already has activity at ${when(p.latestActivity!)}. Trading only moves forward, so you can look back but not trade back.`, action: { label: `Jump to ${when(p.latestActivity!)}`, ts: p.latestActivity! } };
  }

  let problem: string | null = null;
  if (!qtyValid) problem = "Enter a whole number of shares.";
  else if (!limitValid) problem = "Enter a limit price.";
  else if (offTick) problem = `Price must be a multiple of ₹${price(tickPaise(limitPaise))}. Try ₹${price(roundToTick(limitPaise))}.`;
  else if (side === "BUY" && total > s.availableCash) problem = `Not enough cash. You can buy up to ${int(maxBuy)} shares.`;
  else if (side === "SELL" && qtyNum > freeQty) problem = freeQty > 0 ? `You can sell up to ${int(freeQty)} shares.` : `You don't hold any ${q.symbol}. Short selling isn't allowed.`;

  const submit = async () => {
    if (blocker || problem || busy) return;
    setBusy(true);
    try {
      const order = await api.placeOrder({
        symbol: q.symbol, side, type, qty: qtyNum, at: p.at,
        limitPrice: type === "LIMIT" ? limitPaise / 100 : undefined,
        note: note.trim() || undefined,
      });
      setNote("");
      // Hand the keyboard back to the app shortcuts.
      (document.activeElement as HTMLElement | null)?.blur();
      p.onPlaced(order);
    } catch (e) {
      p.onError(e instanceof ApiError ? e.message : "The server didn't respond.");
    } finally {
      setBusy(false);
    }
  };

  const accent = side === "BUY" ? "buy" : "sell";
  const verb = side === "BUY" ? "Buy" : "Sell";
  const label = type === "MARKET" || fillsNow ? `${verb} ${qtyValid ? int(qtyNum) : ""} ${q.symbol}` : `Place limit ${verb.toLowerCase()}`;

  return (
    <aside className="flex min-h-0 flex-col overflow-y-auto bg-panel scrollbar-thin" aria-label="Order ticket">
      <div className="grid grid-cols-2 gap-px border-b border-line bg-line" role="tablist" aria-label="Side">
        {(["BUY", "SELL"] as const).map((sd) => (
          <button
            key={sd}
            role="tab"
            aria-selected={side === sd}
            onClick={() => setSide(sd)}
            className={`h-10 font-semibold ${side === sd ? (sd === "BUY" ? "bg-buy text-white" : "bg-sell text-white") : "bg-panel text-muted hover:text-text"}`}
          >
            {sd === "BUY" ? "Buy" : "Sell"}
          </button>
        ))}
      </div>

      <form className="flex flex-col gap-3.5 p-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div className="flex items-baseline justify-between">
          <div className="text-[15px] font-semibold">{q.symbol}</div>
          <div className="text-[12px] text-muted num">LTP ₹{price(q.ltp)}</div>
        </div>

        <div className="flex overflow-hidden rounded-[2px] border border-line" role="radiogroup" aria-label="Order type">
          {(["MARKET", "LIMIT"] as const).map((t) => (
            <button
              type="button" key={t} role="radio" aria-checked={type === t}
              onClick={() => { setType(t); if (t === "LIMIT" && !limit) setLimit((q.ltp / 100).toFixed(2)); }}
              className={`h-8 flex-1 text-[12px] font-medium ${type === t ? "bg-raised text-text" : "text-muted hover:text-text"}`}
            >
              {t === "MARKET" ? "Market" : "Limit"}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">
            <span className="flex justify-between text-[11px] text-muted">
              Quantity
              <button
                type="button" className="text-chalk hover:underline"
                onClick={() => setQty(String(side === "BUY" ? maxBuy : Math.max(0, freeQty)))}
              >Max</button>
            </span>
            <input
              ref={qtyRef} inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/[^\d]/g, ""))}
              className="h-9 rounded-[2px] border border-line bg-raised px-2.5 text-[14px] num"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-muted">{type === "MARKET" ? "Price" : "Limit price"}</span>
            <input
              inputMode="decimal"
              disabled={type === "MARKET"}
              value={type === "MARKET" ? "At market" : limit}
              onChange={(e) => setLimit(e.target.value.replace(/[^\d.]/g, ""))}
              className="h-9 rounded-[2px] border border-line bg-raised px-2.5 text-[14px] num disabled:text-muted"
            />
          </label>
        </div>

        {type === "LIMIT" && limitValid && !offTick && (
          <p className="-mt-1 text-[11px] leading-snug text-muted">
            {fillsNow
              ? `This limit is at or through the market, so it fills now at ₹${price(q.ltp)}.`
              : `Rests until a later candle's ${side === "BUY" ? "low falls to" : "high reaches"} ₹${price(limitPaise)}. ${side === "BUY" ? "Cash for it is held aside meanwhile." : ""}`}
          </p>
        )}

        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-muted">Why this trade? <span className="text-faint">(optional, saved to your journal)</span></span>
          <textarea
            rows={2} maxLength={280} value={note} onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Buying the gap down after the IT guidance news"
            className="resize-none rounded-[2px] border border-line bg-raised px-2.5 py-1.5 text-[12px] placeholder:text-faint"
          />
        </label>

        <dl className="flex flex-col gap-1.5 rounded-[2px] border border-line p-3 text-[12px] num">
          <Row k={`Price (${type === "MARKET" || fillsNow ? `${q.candleTs ? epochToIst(q.candleTs).time : "prev"} candle` : "limit"})`} v={`₹${price(px)}`} />
          <Row k="Order value" v={inr(value)} />
          <div className="flex justify-between">
            <dt className="text-muted">
              Charges{" "}
              {charges && <button type="button" className="text-chalk hover:underline" onClick={() => setShowCharges((x) => !x)}>{showCharges ? "hide" : "details"}</button>}
            </dt>
            <dd>{charges ? inr(charges.total) : "Off"}</dd>
          </div>
          {charges && showCharges && (
            <div className="ml-2 flex flex-col gap-0.5 border-l border-line pl-2 text-[11px] text-muted">
              <Row k="STT (0.1%)" v={inr(charges.stt)} />
              <Row k="Exchange txn" v={inr(charges.exchange)} />
              <Row k="SEBI fee" v={inr(charges.sebi)} />
              {side === "BUY" ? <Row k="Stamp duty (0.015%)" v={inr(charges.stamp)} /> : <Row k="DP charge (first sell of the day)" v={inr(charges.dp)} />}
              <Row k="GST (18%)" v={inr(charges.gst)} />
              <Row k="Brokerage" v="₹0 on delivery" />
            </div>
          )}
          <div className="mt-1 flex justify-between border-t border-line pt-1.5 font-semibold">
            <dt>{side === "BUY" ? "You pay" : "You receive"}</dt>
            <dd>{inr(total)}</dd>
          </div>
          <Row k="Available cash" v={inr(s.availableCash)} muted />
          {side === "SELL" && <Row k="Shares you can sell" v={int(Math.max(0, freeQty))} muted />}
        </dl>

        {blocker ? (
          <div className="rounded-[2px] border border-line bg-raised p-3 text-[12px] leading-snug">
            <p className="text-muted">{blocker.text}</p>
            {blocker.action && (
              <button type="button" onClick={() => p.onJumpTo(blocker.action!.ts)} className="mt-2 font-medium text-chalk hover:underline">
                {blocker.action.label}
              </button>
            )}
          </div>
        ) : (
          <>
            {problem && <p className="text-[12px] text-down" role="alert">{problem}</p>}
            <button
              type="submit"
              disabled={!!problem || busy}
              className={`h-10 rounded-[2px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-45 ${accent === "buy" ? "bg-buy" : "bg-sell"}`}
            >
              {busy ? "Placing…" : label}
            </button>
          </>
        )}
        <p className="text-[11px] leading-snug text-faint">
          Market orders fill at the close of the candle for the selected time. Virtual money only.
        </p>
      </form>
    </aside>
  );
}

function Row({ k, v, muted }: { k: string; v: string; muted?: boolean }) {
  return (
    <div className={`flex justify-between ${muted ? "text-muted" : ""}`}>
      <dt className={muted ? "" : "text-muted"}>{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}
