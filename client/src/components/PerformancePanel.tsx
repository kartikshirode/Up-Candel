import { ColorType, createChart, LineSeries, LineStyle, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { useEffect, useRef } from "react";
import type { Performance, Portfolio } from "../api.ts";
import { chartTime, inr, pct, tone, when } from "../format.ts";

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function PerformancePanel({ performance, portfolio }: { performance: Performance; portfolio: Portfolio }) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const mine = useRef<ISeriesApi<"Line"> | null>(null);
  const index = useRef<ISeriesApi<"Line"> | null>(null);

  useEffect(() => {
    const c = createChart(box.current!, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: css("--color-panel") }, textColor: css("--color-muted"), fontFamily: "IBM Plex Sans", fontSize: 11, attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: "rgba(42,57,87,0.35)" } },
      rightPriceScale: { borderColor: css("--color-line") },
      timeScale: { borderColor: css("--color-line"), timeVisible: true },
      localization: { priceFormatter: (p: number) => `₹${(p / 100000).toFixed(2)}L` },
      handleScroll: false,
      handleScale: false,
    });
    index.current = c.addSeries(LineSeries, { color: css("--color-muted"), lineWidth: 1, lineStyle: LineStyle.Dashed, title: "Market", priceLineVisible: false });
    mine.current = c.addSeries(LineSeries, { color: css("--color-flame"), lineWidth: 2, title: "You", priceLineVisible: false });
    chart.current = c;
    return () => { c.remove(); chart.current = null; };
  }, []);

  useEffect(() => {
    if (!chart.current) return;
    mine.current!.setData(performance.curve.map((p) => ({ time: chartTime(p.ts) as UTCTimestamp, value: p.netWorth / 100 })));
    index.current!.setData(performance.curve.map((p) => ({ time: chartTime(p.ts) as UTCTimestamp, value: p.benchmark / 100 })));
    chart.current.timeScale().fitContent();
  }, [performance]);

  const s = performance.stats;
  const beat = s.alphaPct >= 0;

  return (
    <div className="grid h-full min-h-[260px] grid-cols-1 md:grid-cols-[250px_minmax(0,1fr)]">
      <div className="flex flex-col gap-3 border-b border-line p-4 md:border-b-0 md:border-r">
        <div>
          <div className="text-[11px] text-muted">Your return vs the market</div>
          <div className="mt-0.5 flex items-baseline gap-2 num">
            <span className={`text-[20px] font-semibold ${tone(s.portfolioReturnPct)}`}>{pct(s.portfolioReturnPct)}</span>
            <span className="text-muted">vs {pct(s.benchmarkReturnPct)}</span>
          </div>
          <p className="mt-1 text-[12px] leading-snug text-muted">
            {s.tradeCount === 0
              ? "You haven't traded yet, so you're sitting in cash."
              : beat
                ? `You're ${pct(s.alphaPct, false)} ahead of an equal-weight basket of all ten stocks.`
                : `You're ${pct(Math.abs(s.alphaPct), false)} behind an equal-weight basket of all ten stocks.`}
          </p>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-[12px] num">
          <Stat k="Net worth" v={inr(portfolio.summary.netWorth)} />
          <Stat k="Max drawdown" v={pct(-s.maxDrawdownPct)} cls={s.maxDrawdownPct > 0 ? "down" : ""} />
          <Stat k="Trades" v={String(s.tradeCount)} />
          <Stat k="Win rate" v={s.winRatePct === null ? "–" : `${s.winRatePct.toFixed(0)}% of ${s.closedTrades}`} />
          <Stat k="Best sell" v={s.bestTrade ? `${s.bestTrade.symbol} ${inr(s.bestTrade.pnl, { sign: true })}` : "–"} cls={tone(s.bestTrade?.pnl ?? null)} title={s.bestTrade ? when(s.bestTrade.simTime) : undefined} />
          <Stat k="Worst sell" v={s.worstTrade ? `${s.worstTrade.symbol} ${inr(s.worstTrade.pnl, { sign: true })}` : "–"} cls={tone(s.worstTrade?.pnl ?? null)} title={s.worstTrade ? when(s.worstTrade.simTime) : undefined} />
          <Stat k="Charges paid" v={inr(s.totalCharges)} />
          <Stat k="Started with" v={inr(portfolio.account.startingCash, { compact: true })} />
        </dl>
      </div>
      <div className="relative min-h-[220px]">
        <div className="absolute left-4 top-2 z-10 flex gap-4 text-[11px] text-muted">
          <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 bg-flame" />You (cash + holdings)</span>
          <span className="flex items-center gap-1.5"><span className="h-0 w-4 border-t border-dashed border-muted" />Market, same starting cash</span>
        </div>
        <div ref={box} className="absolute inset-0 top-7" role="img" aria-label="Net worth over time against the equal-weight market basket" />
      </div>
    </div>
  );
}

function Stat({ k, v, cls = "", title }: { k: string; v: string; cls?: string; title?: string }) {
  return (
    <div title={title}>
      <dt className="text-[11px] text-muted">{k}</dt>
      <dd className={`font-medium ${cls}`}>{v}</dd>
    </div>
  );
}
