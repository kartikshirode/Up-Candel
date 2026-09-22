import {
  CandlestickSeries, ColorType, createChart, createSeriesMarkers, CrosshairMode, HistogramSeries, LineStyle,
  type IChartApi, type IPriceLine, type ISeriesApi, type ISeriesMarkersPluginApi, type Time, type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef } from "react";
import { epochToIst } from "../../../shared/market.ts";
import type { Candle, Holding, Order, Quote, Trade } from "../api.ts";
import { arrow, chartTime, int, pct, price, tone } from "../format.ts";

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

interface Props {
  symbol: string;
  quote: Quote | null;
  candles: Candle[];
  trades: Trade[];
  orders: Order[];
  holding: Holding | null;
}

export function PriceChart({ symbol, quote, candles, trades, orders, holding }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candleSeries = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeries = useRef<ISeriesApi<"Histogram"> | null>(null);
  const markers = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const lines = useRef<IPriceLine[]>([]);
  const shownSymbol = useRef<string | null>(null);

  useEffect(() => {
    const c = createChart(box.current!, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: css("--color-ink") }, textColor: css("--color-muted"), fontFamily: "IBM Plex Sans", fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: "rgba(42,57,87,0.35)" }, horzLines: { color: "rgba(42,57,87,0.35)" } },
      rightPriceScale: { borderColor: css("--color-line") },
      timeScale: { borderColor: css("--color-line"), timeVisible: true, secondsVisible: false, rightOffset: 4, barSpacing: 9 },
      crosshair: { mode: CrosshairMode.Normal },
      localization: { priceFormatter: (p: number) => p.toFixed(2) },
    });
    candleSeries.current = c.addSeries(CandlestickSeries, {
      upColor: css("--color-up"), downColor: css("--color-down"), borderVisible: false,
      wickUpColor: css("--color-up"), wickDownColor: css("--color-down"),
    });
    volumeSeries.current = c.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    c.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    markers.current = createSeriesMarkers(candleSeries.current, []);
    chart.current = c;
    return () => {
      c.remove();
      chart.current = null;
      shownSymbol.current = null;
      lines.current = [];
    };
  }, []);

  useEffect(() => {
    const series = candleSeries.current;
    if (!series || !chart.current) return;
    series.setData(candles.map((c) => ({ time: chartTime(c.ts) as UTCTimestamp, open: c.open / 100, high: c.high / 100, low: c.low / 100, close: c.close / 100 })));
    volumeSeries.current!.setData(candles.map((c) => ({
      time: chartTime(c.ts) as UTCTimestamp, value: c.volume,
      color: c.close >= c.open ? "rgba(38,180,110,0.35)" : "rgba(239,83,80,0.35)",
    })));

    // Your fills for this stock, as arrows on the candle they happened in.
    const candleTimes = new Set(candles.map((c) => c.ts));
    markers.current!.setMarkers(trades
      .filter((t) => t.symbol === symbol && candleTimes.has(t.simTime))
      .sort((a, b) => a.simTime - b.simTime)
      .map((t) => ({
        time: chartTime(t.simTime) as UTCTimestamp,
        position: t.side === "BUY" ? "belowBar" : "aboveBar",
        shape: t.side === "BUY" ? "arrowUp" : "arrowDown",
        color: t.side === "BUY" ? css("--color-buy") : css("--color-sell"),
        text: `${t.side === "BUY" ? "B" : "S"} ${t.qty}`,
      })));

    for (const l of lines.current) series.removePriceLine(l);
    lines.current = [];
    if (holding) {
      lines.current.push(series.createPriceLine({ price: holding.avgPrice / 100, color: css("--color-flame"), lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: true, title: `Avg cost (${holding.qty})` }));
    }
    for (const o of orders.filter((x) => x.symbol === symbol && x.status === "OPEN")) {
      lines.current.push(series.createPriceLine({
        price: o.limitPrice! / 100, color: o.side === "BUY" ? css("--color-buy") : css("--color-sell"),
        lineStyle: LineStyle.Dotted, lineWidth: 1, axisLabelVisible: true, title: `Limit ${o.side === "BUY" ? "buy" : "sell"} ${o.qty}`,
      }));
    }

    if (shownSymbol.current !== symbol) {
      chart.current.timeScale().fitContent();
      if (candles.length > 90) chart.current.timeScale().setVisibleLogicalRange({ from: candles.length - 90, to: candles.length + 4 });
      shownSymbol.current = symbol;
    } else {
      chart.current.timeScale().scrollToRealTime();
    }
  }, [symbol, candles, trades, orders, holding]);

  const candleLabel = quote?.candleTs ? `${epochToIst(quote.candleTs).time} candle` : "last close before the data";

  return (
    <div className="flex min-h-[340px] flex-1 flex-col lg:min-h-0">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-1 border-b border-line px-4 py-2.5">
        <div>
          <div className="flex items-baseline gap-2">
            <h1 className="text-[17px] font-bold tracking-tight">{symbol}</h1>
            <span className="text-muted">{quote?.name}</span>
            <span className="rounded border border-line px-1.5 text-[11px] text-muted">{quote?.sector}</span>
          </div>
          {quote && (
            <div className="flex items-baseline gap-2 num">
              <span className={`text-[22px] font-semibold ${tone(quote.change)}`}>₹{price(quote.ltp)}</span>
              <span className={`font-medium ${tone(quote.change)}`}>{arrow(quote.change)} {price(Math.abs(quote.change))} ({pct(quote.changePct)})</span>
            </div>
          )}
        </div>
        {quote?.dayOpen != null && (
          <dl className="grid grid-cols-4 gap-x-5 text-[12px] num">
            {[["Open", price(quote.dayOpen)], ["High", price(quote.dayHigh!)], ["Low", price(quote.dayLow!)], ["Prev close", price(quote.prevClose)]].map(([k, v]) => (
              <div key={k}><dt className="text-[11px] text-muted">{k}</dt><dd>{v}</dd></div>
            ))}
          </dl>
        )}
        <div className="ml-auto text-right text-[11px] leading-snug text-muted">
          <div>Price from the {candleLabel}</div>
          {quote && quote.dayVolume > 0 && <div className="num">Volume today {int(quote.dayVolume)}</div>}
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={box} className="absolute inset-0" aria-label={`${symbol} 30-minute candlestick chart up to the selected time`} role="img" />
        {candles.length === 0 && (
          <div className="absolute inset-0 grid place-items-center text-muted">
            No candles yet. The first one prints at 09:15. Press → or Play.
          </div>
        )}
      </div>
    </div>
  );
}
