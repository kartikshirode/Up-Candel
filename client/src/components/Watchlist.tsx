import type { Side } from "../../../shared/market.ts";
import type { Holding, Quote } from "../api.ts";
import { arrow, pct, price, tone } from "../format.ts";

interface Props {
  quotes: Quote[];
  selected: string;
  holdings: Holding[];
  onSelect: (symbol: string) => void;
  onTrade: (side: Side, symbol: string) => void;
}

export function Watchlist({ quotes, selected, holdings, onSelect, onTrade }: Props) {
  const held = new Set(holdings.map((h) => h.symbol));
  return (
    <aside className="flex min-h-0 flex-col bg-panel" aria-label="Watchlist">
      <div className="flex items-baseline justify-between px-3 pb-1.5 pt-2.5">
        <h2 className="cond text-[15px] font-semibold uppercase">Watchlist</h2>
        <span className="text-[11px] text-faint">NSE, 10 stocks</span>
      </div>
      <ul className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        {quotes.map((q) => {
          const active = q.symbol === selected;
          return (
            <li key={q.symbol}>
              <div
                role="button"
                tabIndex={0}
                aria-current={active}
                onClick={() => onSelect(q.symbol)}
                onKeyDown={(e) => { if (e.key === "Enter") onSelect(q.symbol); }}
                className={`group relative grid cursor-pointer grid-cols-[1fr_52px_auto] items-center gap-2 border-b border-dashed border-line/60 px-3 py-2 ${active ? "bg-raised" : "hover:bg-raised/50"}`}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 font-semibold">
                    <span className={active ? "text-chalk" : "text-transparent"} aria-hidden="true">▸</span>
                    {q.symbol}
                    {held.has(q.symbol) && <span className="h-1.5 w-1.5 rounded-full bg-buy" title="You hold this" />}
                  </div>
                  <div className="truncate text-[11px] text-muted">{q.name}</div>
                </div>
                <Spark values={q.spark} up={q.change >= 0} />
                <div className="text-right num">
                  <div className={`font-medium ${tone(q.change)}`}>{price(q.ltp)}</div>
                  <div className={`text-[11px] ${tone(q.change)}`}>{arrow(q.change)} {pct(q.changePct)}</div>
                </div>
                <div className="absolute inset-y-0 right-2 hidden items-center gap-1 group-hover:flex group-focus-within:flex">
                  <button
                    className="h-6 rounded bg-buy px-2 text-[11px] font-semibold text-white"
                    onClick={(e) => { e.stopPropagation(); onTrade("BUY", q.symbol); }}
                  >Buy</button>
                  <button
                    className="h-6 rounded bg-sell px-2 text-[11px] font-semibold text-white"
                    onClick={(e) => { e.stopPropagation(); onTrade("SELL", q.symbol); }}
                  >Sell</button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="border-t border-line px-3 py-2 text-[11px] leading-snug text-faint">
        Change is against the previous session's close. ↑ ↓ to move, B or S to trade.
      </p>
    </aside>
  );
}

function Spark({ values, up }: { values: number[]; up: boolean }) {
  if (values.length < 2) return <span />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 50 + 1},${19 - ((v - min) / span) * 16}`).join(" ");
  return (
    <svg width="52" height="20" aria-hidden="true">
      <polyline points={pts} fill="none" stroke={up ? "var(--color-up)" : "var(--color-down)"} strokeWidth="1.25" strokeLinejoin="round" />
    </svg>
  );
}
