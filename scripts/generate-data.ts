// Generates the synthetic market data in data/.
//
// Output:
//   data/stocks.csv            one row per stock (symbol, name, sector, previous close)
//   data/prices/<SYMBOL>.csv   30-minute OHLCV candles, 13 per trading day
//
// Model: each 30-minute log return is a mix of a market factor, a sector factor and
// stock-specific noise, so banks move together and the whole market has a mood.
// Days open with an overnight gap, volatility and volume are U-shaped through the
// session, and every price lands on the NSE tick grid. The seed is fixed, so running
// this twice gives byte-identical files.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CANDLE_STARTS, epochToIsoIst, istToEpoch, roundToTick } from "../shared/market.ts";

const SEED = 20260901;
const OUT_DIR = join(import.meta.dirname, "..", "data");

// 1-21 Sep 2026. Weekends are skipped, and so is Mon 14 Sep (Ganesh Chaturthi, NSE holiday).
// Fri 4 Sep (Janmashtami) is a trading day in 2026.
const HOLIDAYS = new Set(["2026-09-14"]);
const FIRST_DAY = "2026-09-01";
const LAST_DAY = "2026-09-21";

interface StockSpec {
  symbol: string;
  name: string;
  sector: string;
  prevClose: number; // INR, close on Mon 31 Aug 2026 (approximate real level)
  dailyVol: number; // daily sigma of log returns
  driftPerDay: number; // mean daily log return, gives each stock a personality
  adv: number; // average daily volume, shares
}

const STOCKS: StockSpec[] = [
  { symbol: "RELIANCE", name: "Reliance Industries", sector: "Energy", prevClose: 1240, dailyVol: 0.013, driftPerDay: 0.0012, adv: 10_000_000 },
  { symbol: "TCS", name: "Tata Consultancy Services", sector: "IT", prevClose: 2110, dailyVol: 0.014, driftPerDay: -0.0015, adv: 2_600_000 },
  { symbol: "INFY", name: "Infosys", sector: "IT", prevClose: 1030, dailyVol: 0.015, driftPerDay: -0.001, adv: 6_500_000 },
  { symbol: "HDFCBANK", name: "HDFC Bank", sector: "Banking", prevClose: 731, dailyVol: 0.012, driftPerDay: 0.0008, adv: 20_000_000 },
  { symbol: "ICICIBANK", name: "ICICI Bank", sector: "Banking", prevClose: 1340, dailyVol: 0.013, driftPerDay: 0.0015, adv: 12_000_000 },
  { symbol: "SBIN", name: "State Bank of India", sector: "Banking", prevClose: 987, dailyVol: 0.016, driftPerDay: 0.001, adv: 13_000_000 },
  { symbol: "ITC", name: "ITC", sector: "FMCG", prevClose: 266, dailyVol: 0.011, driftPerDay: 0.0002, adv: 12_000_000 },
  { symbol: "HINDUNILVR", name: "Hindustan Unilever", sector: "FMCG", prevClose: 1934, dailyVol: 0.011, driftPerDay: -0.0004, adv: 1_500_000 },
  { symbol: "BHARTIARTL", name: "Bharti Airtel", sector: "Telecom", prevClose: 1817, dailyVol: 0.014, driftPerDay: 0.0025, adv: 6_000_000 },
  { symbol: "LT", name: "Larsen & Toubro", sector: "Infrastructure", prevClose: 3885, dailyVol: 0.013, driftPerDay: 0.0006, adv: 2_000_000 },
];

// Scripted news days: an extra overnight gap on one stock. These give the replay a few
// moments worth trading around, and the README lists them.
const EVENTS: Record<string, Record<string, number>> = {
  "2026-09-08": { BHARTIARTL: 0.028 }, // tariff hike chatter
  "2026-09-10": { TCS: -0.034, INFY: -0.018 }, // weak IT guidance from a US peer
  "2026-09-17": { SBIN: 0.024 }, // PSU bank rerating
};

// Relative volatility and volume through the session, one weight per candle.
// The last candle is 15 minutes, so its volatility is also scaled by sqrt(0.5).
const VOL_SHAPE = [1.6, 1.25, 1.05, 0.9, 0.85, 0.8, 0.8, 0.85, 0.9, 0.95, 1.05, 1.2, 1.3];
const VOLUME_SHAPE = [2.2, 1.4, 1.1, 0.9, 0.8, 0.75, 0.7, 0.75, 0.8, 0.9, 1.1, 1.5, 1.3];

const MARKET_LOADING = 0.55;
const SECTOR_LOADING = 0.4;
const OVERNIGHT_SHARE = 0.45; // share of daily sigma that arrives as the opening gap
const SUBSTEPS = 6; // intra-candle path points used to find a realistic high and low

// mulberry32: small, fast, seedable PRNG
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
function normal(): number {
  // Box-Muller
  let u = 0;
  while (u === 0) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

function tradingDays(): string[] {
  const days: string[] = [];
  const d = new Date(`${FIRST_DAY}T00:00:00Z`);
  const end = new Date(`${LAST_DAY}T00:00:00Z`);
  for (; d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6 && !HOLIDAYS.has(iso)) days.push(iso);
  }
  return days;
}

interface Candle { ts: number; o: number; h: number; l: number; c: number; v: number }

function generate() {
  const days = tradingDays();
  const sectors = [...new Set(STOCKS.map((s) => s.sector))];
  const sectorSize = Object.fromEntries(sectors.map((s) => [s, STOCKS.filter((x) => x.sector === s).length]));

  const candles: Record<string, Candle[]> = Object.fromEntries(STOCKS.map((s) => [s.symbol, []]));
  const lastClose: Record<string, number> = Object.fromEntries(STOCKS.map((s) => [s.symbol, s.prevClose * 100]));

  for (const day of days) {
    const dayOpenClose = { ...lastClose };
    const dailyVolume = Object.fromEntries(STOCKS.map((s) => [s.symbol, s.adv * Math.exp(0.3 * normal() - 0.045)]));
    const events = EVENTS[day] ?? {};
    const mktGap = normal();
    const sectorGap = Object.fromEntries(sectors.map((s) => [s, normal()]));

    for (let k = 0; k < CANDLE_STARTS.length; k++) {
      const ts = istToEpoch(day, CANDLE_STARTS[k]);
      const zMkt = normal();
      const zSector = Object.fromEntries(sectors.map((s) => [s, normal()]));
      const barFraction = k === CANDLE_STARTS.length - 1 ? 0.5 : 1;

      for (const s of STOCKS) {
        const sectorLoad = sectorSize[s.sector] > 1 ? SECTOR_LOADING : 0;
        const idioLoad = Math.sqrt(1 - MARKET_LOADING ** 2 - sectorLoad ** 2);
        const mix = (m: number, sec: number) => MARKET_LOADING * m + sectorLoad * sec + idioLoad * normal();

        let open = lastClose[s.symbol];
        if (k === 0) {
          const gapSigma = s.dailyVol * OVERNIGHT_SHARE;
          const gap = gapSigma * mix(mktGap, sectorGap[s.sector]) + (events[s.symbol] ?? 0);
          open = roundToTick(open * Math.exp(gap));
        }

        const barSigma = ((s.dailyVol * Math.sqrt(1 - OVERNIGHT_SHARE ** 2)) / Math.sqrt(12.5)) * VOL_SHAPE[k] * Math.sqrt(barFraction);
        const drift = (s.driftPerDay / 12.5) * barFraction;
        const r = drift - 0.5 * barSigma ** 2 + barSigma * mix(zMkt, zSector[s.sector]);

        // Brownian bridge from open to close to get the path's extremes.
        const eps = Array.from({ length: SUBSTEPS }, normal);
        const mean = eps.reduce((a, b) => a + b, 0) / SUBSTEPS;
        const subSigma = barSigma / Math.sqrt(SUBSTEPS);
        let logP = Math.log(open);
        let hi = open;
        let lo = open;
        for (const e of eps) {
          logP += r / SUBSTEPS + subSigma * (e - mean);
          const p = Math.exp(logP);
          hi = Math.max(hi, p);
          lo = Math.min(lo, p);
        }

        // Dynamic price band sanity cap: +/-10% of the previous day's close.
        const ref = dayOpenClose[s.symbol];
        const close = roundToTick(Math.min(ref * 1.1, Math.max(ref * 0.9, Math.exp(logP))));
        const high = Math.max(roundToTick(hi, "up"), open, close);
        const low = Math.min(roundToTick(lo, "down"), open, close);

        const volumeWeight = VOLUME_SHAPE[k] / VOLUME_SHAPE.reduce((a, b) => a + b, 0);
        const surprise = 1 + 0.25 * Math.abs(r) / barSigma;
        const v = Math.round(dailyVolume[s.symbol] * volumeWeight * surprise * Math.exp(0.2 * normal()));

        candles[s.symbol].push({ ts, o: open, h: high, l: low, c: close, v });
        lastClose[s.symbol] = close;
      }
    }
  }
  return { days, candles };
}

function rupees(paise: number): string {
  return (paise / 100).toFixed(2);
}

function main() {
  const { days, candles } = generate();
  mkdirSync(join(OUT_DIR, "prices"), { recursive: true });

  const stockRows = ["symbol,name,sector,exchange,prev_close"];
  for (const s of STOCKS) stockRows.push(`${s.symbol},${s.name},${s.sector},NSE,${s.prevClose.toFixed(2)}`);
  writeFileSync(join(OUT_DIR, "stocks.csv"), stockRows.join("\n") + "\n");

  for (const s of STOCKS) {
    const rows = ["timestamp,open,high,low,close,volume"];
    for (const c of candles[s.symbol]) {
      rows.push(`${epochToIsoIst(c.ts)},${rupees(c.o)},${rupees(c.h)},${rupees(c.l)},${rupees(c.c)},${c.v}`);
    }
    writeFileSync(join(OUT_DIR, "prices", `${s.symbol}.csv`), rows.join("\n") + "\n");
  }

  const total = Object.values(candles).reduce((n, list) => n + list.length, 0);
  console.log(`Wrote ${STOCKS.length} stocks x ${days.length} trading days (${days[0]} to ${days.at(-1)}), ${total} candles.`);
  for (const s of STOCKS) {
    const list = candles[s.symbol];
    const move = (list.at(-1)!.c / (s.prevClose * 100) - 1) * 100;
    console.log(`  ${s.symbol.padEnd(11)} ${rupees(s.prevClose * 100).padStart(8)} -> ${rupees(list.at(-1)!.c).padStart(8)}  ${move >= 0 ? "+" : ""}${move.toFixed(2)}%`);
  }
}

main();
