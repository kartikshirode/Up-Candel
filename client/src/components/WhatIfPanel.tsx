import { useEffect, useState } from "react";
import { istToEpoch, type Side } from "../../../shared/market.ts";
import { api, type Meta, type WhatIf } from "../api.ts";
import { inr, int, pct, price, toLocalInput, tone, when } from "../format.ts";

/**
 * Hindsight, on purpose: pick a moment and an amount, and see what each stock would have
 * turned it into by the current clock time. Trading stays forward-only; this only looks.
 */
export function WhatIfPanel({ meta, at, onTrade }: { meta: Meta; at: number; onTrade: (side: Side, symbol: string) => void }) {
  const [from, setFrom] = useState(meta.range.start);
  const [amount, setAmount] = useState("100000");
  const [data, setData] = useState<WhatIf | null>(null);
  const [error, setError] = useState<string | null>(null);

  const effectiveFrom = Math.min(from, at);
  const amountNum = Number(amount);

  useEffect(() => {
    if (!(amountNum >= 100)) return;
    const timer = setTimeout(() => {
      api.whatIf(effectiveFrom, at, amountNum).then((d) => { setData(d); setError(null); }).catch((e: Error) => setError(e.message));
    }, 150);
    return () => clearTimeout(timer);
  }, [effectiveFrom, at, amountNum]);

  const best = data?.results[0];
  const worst = data?.results[data.results.length - 1];

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-muted">If I had put in</span>
          <span className="flex h-8 items-center rounded-md border border-line bg-raised px-2">
            <span className="text-muted">₹</span>
            <input
              inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ""))}
              className="w-24 bg-transparent px-1 outline-none num"
            />
          </span>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-muted">at</span>
          <input
            type="datetime-local"
            value={toLocalInput(effectiveFrom)}
            min={toLocalInput(meta.range.start)}
            max={toLocalInput(at)}
            onChange={(e) => {
              const [d, t] = e.target.value.split("T");
              if (d && t) setFrom(Math.max(meta.range.start, istToEpoch(d, t)));
            }}
            className="h-8 rounded-md border border-line bg-raised px-2 text-[12px] num"
          />
        </label>
        <span className="pb-1.5 text-muted">and held until now, {when(at)}</span>
      </div>

      {error && <p className="text-down">{error}</p>}
      {data && best && worst && (
        <>
          <p className="max-w-[72ch] leading-relaxed">
            Best: <b>{best.symbol}</b> would be worth <b className={tone(best.pnl)}>{inr(best.value)}</b> ({pct(best.returnPct)}).
            {" "}Worst: <b>{worst.symbol}</b> at <b className={tone(worst.pnl)}>{inr(worst.value)}</b> ({pct(worst.returnPct)}).
            <span className="text-muted"> Whole shares only; leftover cash is kept.</span>
          </p>
          <table className="data-table num">
            <thead>
              <tr><th>Instrument</th><th>Bought at</th><th>Shares</th><th>Price now</th><th>Worth now</th><th>P&L</th><th>Return</th><th><span className="sr-only">Actions</span></th></tr>
            </thead>
            <tbody>
              {data.results.map((r) => (
                <tr key={r.symbol}>
                  <td><span className="font-semibold">{r.symbol}</span> <span className="text-[11px] text-muted">{r.name}</span></td>
                  <td>{price(r.buyPrice)}</td>
                  <td>{int(r.shares)}</td>
                  <td>{price(r.priceNow)}</td>
                  <td>{inr(r.value)}</td>
                  <td className={tone(r.pnl)}>{inr(r.pnl, { sign: true })}</td>
                  <td className={tone(r.returnPct)}>
                    <span className="inline-flex items-center gap-2">
                      <Bar value={r.returnPct} max={Math.max(...data.results.map((x) => Math.abs(x.returnPct)), 0.01)} />
                      {pct(r.returnPct)}
                    </span>
                  </td>
                  <td>
                    <button className="rounded border border-line px-2 py-0.5 text-[11px] text-buy hover:border-buy" onClick={() => onTrade("BUY", r.symbol)}>Buy now</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function Bar({ value, max }: { value: number; max: number }) {
  const w = Math.round((Math.abs(value) / max) * 40);
  return (
    <span className="relative inline-block h-2 w-20" aria-hidden="true">
      <span className="absolute left-1/2 top-0 h-2 w-px bg-line" />
      <span
        className={`absolute top-0 h-2 rounded-sm ${value >= 0 ? "bg-up" : "bg-down"}`}
        style={value >= 0 ? { left: "50%", width: w } : { right: "50%", width: w }}
      />
    </span>
  );
}
