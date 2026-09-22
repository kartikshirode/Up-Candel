import { useMemo, useRef } from "react";
import { epochToIst, sessionBounds } from "../../../shared/market.ts";
import type { Meta, Performance, Trade } from "../api.ts";
import { dayLabel, inr, pct, when } from "../format.ts";

interface Props {
  meta: Meta;
  at: number;
  curve: Performance["curve"];
  trades: Trade[];
  onSeek: (ts: number) => void;
}

/**
 * The replay tape: every trading day in the data as one segment, the playhead where the
 * simulated clock is, and a dot for each of your trades. Days already replayed are tinted
 * by how the whole market (equal-weight index) did; days ahead stay blank, so there is no
 * peeking at the future from here.
 */
export function Tape({ meta, at, curve, trades, onSeek }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const days = meta.tradingDays;
  const n = days.length;

  const position = useMemo(() => {
    let pos = 0;
    days.forEach((d, i) => {
      const { open, close } = sessionBounds(d);
      if (at >= open) pos = i + Math.min(1, (at - open) / (close - open));
    });
    return pos;
  }, [days, at]);

  const dayMoves = useMemo(() => {
    const lastByDay = new Map<string, number>();
    for (const p of curve) lastByDay.set(epochToIst(p.ts).date, p.benchmark);
    let prev = meta.account.startingCash;
    return days.map((d) => {
      const v = lastByDay.get(d);
      if (v === undefined) return null;
      const move = (v / prev - 1) * 100;
      prev = v;
      return move;
    });
  }, [curve, days, meta.account.startingCash]);

  const seekFromPointer = (clientX: number) => {
    const box = ref.current!.getBoundingClientRect();
    const x = Math.min(0.99999, Math.max(0, (clientX - box.left) / box.width)) * n;
    const day = days[Math.floor(x)];
    const { open, close } = sessionBounds(day);
    const target = open + (x - Math.floor(x)) * (close - open);
    let snapped = open;
    for (const ts of meta.timeline) if (ts <= target) snapped = ts;
    onSeek(snapped);
  };

  const slotOf = (ts: number) => {
    const d = days.indexOf(epochToIst(ts).date);
    const { open, close } = sessionBounds(days[d]);
    return d + (ts - open) / (close - open);
  };

  return (
    <div className="border-b border-line bg-panel px-4 pb-2 pt-1">
      <div
        ref={ref}
        role="slider"
        aria-label="Replay position"
        aria-valuemin={meta.range.start}
        aria-valuemax={meta.range.end}
        aria-valuenow={at}
        aria-valuetext={when(at)}
        tabIndex={0}
        className="relative flex h-10 cursor-pointer select-none"
        onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture?.(e.pointerId); seekFromPointer(e.clientX); }}
        onPointerMove={(e) => { if (e.buttons === 1) seekFromPointer(e.clientX); }}
      >
        {days.map((d, i) => {
          const l = dayLabel(d);
          const newMonth = i === 0 || dayLabel(days[i - 1]).month !== l.month;
          const move = dayMoves[i];
          const tint = move === null ? "transparent"
            : `color-mix(in srgb, var(--color-${move >= 0 ? "up" : "down"}) ${Math.min(55, 12 + Math.abs(move) * 22)}%, transparent)`;
          return (
            <div key={d} className="relative flex-1 border-l border-line first:border-l-0" title={move === null ? `${l.weekday} ${l.day} ${l.month}` : `${l.weekday} ${l.day} ${l.month}: market ${pct(move)}`}>
              <div className={`cond px-1.5 pt-0.5 text-[12px] uppercase leading-tight ${i < Math.floor(position) ? "text-muted" : i === Math.floor(position) ? "text-text" : "text-faint"}`}>
                <span className="font-semibold">{l.day}</span> <span className="hidden sm:inline">{newMonth ? l.month : l.weekday}</span>
              </div>
              <div className="absolute inset-x-0 bottom-0 h-[5px]" style={{ background: tint }} />
              <div className="absolute inset-x-0 bottom-[5px] flex justify-between px-px">
                {Array.from({ length: 13 }, (_, k) => <span key={k} className="h-1 w-px bg-line" />)}
              </div>
            </div>
          );
        })}

        <div className="pointer-events-none absolute inset-y-0 left-0 bg-chalk/[0.06]" style={{ width: `${(position / n) * 100}%` }} />

        {trades.map((t) => {
          const future = t.simTime > at;
          return (
            <span
              key={t.id}
              className={`absolute bottom-[9px] h-2 w-2 -translate-x-1/2 rounded-full ring-2 ring-panel ${t.side === "BUY" ? "bg-buy" : "bg-sell"} ${future ? "opacity-30" : ""}`}
              style={{ left: `${(slotOf(t.simTime) / n) * 100}%` }}
              title={`${t.side === "BUY" ? "Bought" : "Sold"} ${t.qty} ${t.symbol} at ${inr(t.price)}, ${when(t.simTime)}`}
            />
          );
        })}

        <div className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-chalk" style={{ left: `${(position / n) * 100}%` }}>
          <span className="absolute -top-0.5 left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 bg-chalk" />
        </div>
      </div>
    </div>
  );
}
