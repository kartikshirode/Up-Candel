import type { Side } from "../../../shared/market.ts";
import { api, type Meta, type Order, type Performance, type Portfolio, type Trade } from "../api.ts";
import { arrow, inr, int, pct, price, tone, when } from "../format.ts";
import { PerformancePanel } from "./PerformancePanel.tsx";
import { WhatIfPanel } from "./WhatIfPanel.tsx";

export type TabId = "holdings" | "orders" | "trades" | "performance" | "whatif";

interface Props {
  tab: TabId;
  onTab: (t: TabId) => void;
  at: number;
  meta: Meta;
  portfolio: Portfolio;
  orders: Order[];
  trades: Trade[];
  performance: Performance;
  onSelect: (symbol: string) => void;
  onTrade: (side: Side, symbol: string) => void;
  onCancel: (id: number) => void;
}

export function BottomPanel(p: Props) {
  const openCount = p.orders.filter((o) => o.status === "OPEN").length;
  const tabs: { id: TabId; label: string; count?: number; key: string }[] = [
    { id: "holdings", label: "Holdings", count: p.portfolio.holdings.length, key: "H" },
    { id: "orders", label: "Orders", count: openCount || undefined, key: "O" },
    { id: "trades", label: "Transactions", count: p.trades.length, key: "T" },
    { id: "performance", label: "Performance", key: "P" },
    { id: "whatif", label: "What if", key: "W" },
  ];

  return (
    <div className="flex h-[46%] min-h-[300px] flex-col border-t border-line bg-panel lg:min-h-0">
      <div className="flex items-center gap-1 overflow-x-auto border-b border-line px-2" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={p.tab === t.id}
            onClick={() => p.onTab(t.id)}
            title={`${t.label} (${t.key})`}
            className={`cond relative h-9 shrink-0 px-3 text-[14px] font-semibold uppercase ${p.tab === t.id ? "text-text" : "text-muted hover:text-text"}`}
          >
            {t.label}
            {t.count !== undefined && <span className="ml-1.5 rounded bg-raised px-1.5 text-[11px] text-muted num">{t.count}</span>}
            {p.tab === t.id && <span className="absolute inset-x-2 bottom-0 h-[3px] bg-chalk" />}
          </button>
        ))}
        {p.tab === "trades" && p.trades.length > 0 && (
          <a href={api.csvUrl(p.at)} className="ml-auto shrink-0 rounded-[2px] border border-line px-2.5 py-1 text-[12px] text-muted hover:text-text" download>
            Export CSV
          </a>
        )}
      </div>
      <div className="scrollbar-thin min-h-0 flex-1 overflow-auto">
        {p.tab === "holdings" && <Holdings {...p} />}
        {p.tab === "orders" && <Orders {...p} />}
        {p.tab === "trades" && <Trades {...p} />}
        {p.tab === "performance" && <PerformancePanel performance={p.performance} portfolio={p.portfolio} />}
        {p.tab === "whatif" && <WhatIfPanel meta={p.meta} at={p.at} onTrade={p.onTrade} />}
      </div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="grid h-full min-h-[140px] place-items-center px-6 text-center text-muted">{children}</div>;
}

function Holdings({ portfolio, onSelect, onTrade }: Props) {
  const { holdings, summary, closedPositions } = portfolio;
  if (holdings.length === 0) {
    return (
      <Empty>
        <div>
          <p>No holdings at this point in time.</p>
          <p className="mt-1 text-faint">Pick a stock in the watchlist and press B to buy.{closedPositions.length > 0 && ` Realized so far: ${inr(summary.realizedPnl, { sign: true })}.`}</p>
        </div>
      </Empty>
    );
  }
  return (
    <table className="data-table num">
      <thead>
        <tr>
          <th>Instrument</th><th>Qty</th><th>Avg cost</th><th>LTP</th><th>Invested</th><th>Current value</th>
          <th>P&L</th><th>Net chg</th><th>Day's P&L</th><th><span className="sr-only">Actions</span></th>
        </tr>
      </thead>
      <tbody>
        {holdings.map((h) => (
          <tr key={h.symbol} className="cursor-pointer" onClick={() => onSelect(h.symbol)}>
            <td><span className="font-semibold">{h.symbol}</span> <span className="text-[11px] text-muted">{h.sector}</span></td>
            <td>{int(h.qty)}</td>
            <td>{price(Math.round(h.avgPrice))}</td>
            <td>{price(h.ltp)}</td>
            <td>{inr(h.invested)}</td>
            <td>{inr(h.currentValue)}</td>
            <td className={tone(h.unrealizedPnl)}>{inr(h.unrealizedPnl, { sign: true })}</td>
            <td className={tone(h.unrealizedPnl)}>{arrow(h.unrealizedPnl)} {pct(h.unrealizedPct)}</td>
            <td className={tone(h.dayPnl)}>{inr(h.dayPnl, { sign: true })}</td>
            <td>
              <button className="rounded border border-line px-2 py-0.5 text-[11px] text-sell hover:border-sell" onClick={(e) => { e.stopPropagation(); onTrade("SELL", h.symbol); }}>Sell</button>
            </td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td>Total</td><td /><td /><td />
          <td>{inr(summary.invested)}</td>
          <td>{inr(summary.currentValue)}</td>
          <td className={tone(summary.unrealizedPnl)}>{inr(summary.unrealizedPnl, { sign: true })}</td>
          <td className={tone(summary.unrealizedPnl)}>{summary.invested ? pct((summary.unrealizedPnl / summary.invested) * 100) : ""}</td>
          <td className={tone(summary.dayPnl)}>{inr(summary.dayPnl, { sign: true })}</td>
          <td />
        </tr>
        <tr className="text-[12px]">
          <td colSpan={10} className="text-left! font-normal! text-muted">
            Realized P&L {" "}<span className={tone(summary.realizedPnl)}>{inr(summary.realizedPnl, { sign: true })}</span>
            <span className="mx-3 text-faint">|</span>
            Charges paid <span className="text-text">{inr(summary.charges)}</span>
            <span className="mx-3 text-faint">|</span>
            Total P&L after charges <span className={`font-semibold ${tone(summary.totalPnl)}`}>{inr(summary.totalPnl, { sign: true })}</span>
          </td>
        </tr>
      </tfoot>
    </table>
  );
}

const STATUS_STYLE: Record<Order["status"], string> = {
  OPEN: "text-chalk",
  FILLED: "text-up",
  CANCELLED: "text-muted",
  REJECTED: "text-down",
};

function Orders({ orders, onCancel, onSelect }: Props) {
  if (orders.length === 0) return <Empty>No orders yet. Market orders fill straight away; limit orders wait here until the replay reaches their price.</Empty>;
  return (
    <table className="data-table num">
      <thead>
        <tr><th>Placed</th><th className="text-left!">Instrument</th><th>Side</th><th>Type</th><th>Qty</th><th>Limit</th><th>Status</th><th>Fill price</th><th>Resolved</th><th><span className="sr-only">Actions</span></th></tr>
      </thead>
      <tbody>
        {orders.map((o) => (
          <tr key={o.id} onClick={() => onSelect(o.symbol)} className="cursor-pointer">
            <td className="text-muted">{when(o.placedAt)}</td>
            <td className="text-left! font-semibold">{o.symbol}</td>
            <td className={o.side === "BUY" ? "text-buy" : "text-sell"}>{o.side === "BUY" ? "Buy" : "Sell"}</td>
            <td>{o.type === "MARKET" ? "Market" : "Limit"}</td>
            <td>{int(o.qty)}</td>
            <td>{o.limitPrice ? price(o.limitPrice) : "–"}</td>
            <td className={STATUS_STYLE[o.status]} title={o.reason ?? undefined}>{o.status[0] + o.status.slice(1).toLowerCase()}{o.reason ? " *" : ""}</td>
            <td>{o.fillPrice ? price(o.fillPrice) : "–"}</td>
            <td className="text-muted">{o.resolvedAt ? when(o.resolvedAt) : "–"}</td>
            <td>
              {o.status === "OPEN" && (
                <button className="rounded border border-line px-2 py-0.5 text-[11px] text-muted hover:text-text" onClick={(e) => { e.stopPropagation(); onCancel(o.id); }}>Cancel</button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Trades({ trades, onSelect }: Props) {
  if (trades.length === 0) return <Empty>No transactions up to this time. Every buy and sell lands here with its charges and realized P&L.</Empty>;
  return (
    <table className="data-table num">
      <thead>
        <tr><th>Time</th><th className="text-left!">Instrument</th><th>Side</th><th>Qty</th><th>Price</th><th>Value</th><th>Charges</th><th>Net amount</th><th>Realized P&L</th><th className="text-left!">Note</th></tr>
      </thead>
      <tbody>
        {trades.map((t) => {
          const b = t.chargesBreakdown;
          const breakdown = `STT ${inr(b.stt)}, exchange ${inr(b.exchange)}, SEBI ${inr(b.sebi)}, stamp ${inr(b.stamp)}, GST ${inr(b.gst)}, DP ${inr(b.dp)}`;
          return (
            <tr key={t.id} onClick={() => onSelect(t.symbol)} className="cursor-pointer">
              <td className="text-muted">{when(t.simTime)}</td>
              <td className="text-left! font-semibold">{t.symbol}</td>
              <td className={t.side === "BUY" ? "text-buy" : "text-sell"}>{t.side === "BUY" ? "Buy" : "Sell"}</td>
              <td>{int(t.qty)}</td>
              <td>{price(t.price)}</td>
              <td>{inr(t.value)}</td>
              <td title={breakdown}>{inr(t.charges)}</td>
              <td className={tone(t.netAmount)}>{inr(t.netAmount, { sign: true })}</td>
              <td className={tone(t.realizedPnl)}>{t.realizedPnl === null ? "–" : inr(t.realizedPnl, { sign: true })}</td>
              <td className="max-w-[260px] truncate text-left! text-muted" title={t.note ?? undefined}>{t.note ?? ""}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
