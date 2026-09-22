import { istToEpoch } from "../../../shared/market.ts";
import type { MarketStatus, Meta, Portfolio } from "../api.ts";
import { SPEEDS, type Speed } from "../constants.ts";
import { inr, pct, toLocalInput, tone, when } from "../format.ts";

interface Props {
  at: number;
  meta: Meta;
  status: MarketStatus;
  portfolio: Portfolio;
  playing: boolean;
  speed: Speed;
  onTogglePlay: () => void;
  onStep: (dir: 1 | -1) => void;
  onSpeed: (s: Speed) => void;
  onSeek: (ts: number) => void;
  onOpenShortcuts: () => void;
  onOpenAccount: () => void;
}

const btn = "grid h-8 w-8 place-items-center rounded-[2px] border border-line bg-raised text-text hover:border-muted disabled:opacity-40";

export function TopBar(p: Props) {
  const s = p.portfolio.summary;
  const statusDot = p.status.isOpen ? "bg-up" : p.status.state === "PRE_OPEN" ? "bg-chalk" : "bg-faint";

  return (
    <header className="flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-line bg-panel px-4 py-2.5">
      <div className="flex items-center gap-2.5">
        <img src="/favicon.svg" alt="" className="h-7 w-7" />
        <div className="cond border-b-2 border-chalk pb-0.5 text-[19px] font-bold uppercase leading-none" title="Virtual money only. NSE market replay.">Up-Candel</div>
      </div>

      <div className="flex items-center gap-3">
        <div className="leading-tight">
          <div className="font-mono text-[15px] text-chalk num" aria-live="polite">{when(p.at, true)} <span className="text-muted">IST</span></div>
          <div className="flex items-center gap-1.5 text-[11px] text-muted">
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${statusDot}`} />
            {p.status.label}
          </div>
        </div>
        <label className="sr-only" htmlFor="clock">Jump to date and time</label>
        <input
          id="clock"
          type="datetime-local"
          className="h-8 rounded-[2px] border border-line bg-raised px-2 text-[12px] num"
          value={toLocalInput(p.at)}
          min={toLocalInput(p.meta.range.start)}
          max={toLocalInput(p.meta.range.end)}
          onChange={(e) => {
            const [date, time] = e.target.value.split("T");
            if (!date || !time) return;
            const ts = istToEpoch(date, time);
            p.onSeek(Math.min(p.meta.range.end, Math.max(p.meta.range.start, ts)));
          }}
          title="Pick any date and time. Prices show the candle for that moment."
        />
      </div>

      <div className="flex items-center gap-1.5" role="group" aria-label="Replay controls">
        <button className={btn} onClick={() => p.onStep(-1)} title="Back one candle (←)" aria-label="Back one candle">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M3 2h2v12H3zM14 2v12L6 8z" /></svg>
        </button>
        <button
          className={`${btn} w-auto gap-1.5 px-3 ${p.playing ? "border-chalk text-chalk" : ""}`}
          onClick={p.onTogglePlay}
          title="Play or pause the replay (Space)"
        >
          {p.playing
            ? <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M3 2h4v12H3zM9 2h4v12H9z" /></svg>
            : <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M3 2v12l11-6z" /></svg>}
          <span className="text-[12px] font-medium">{p.playing ? "Pause" : "Play"}</span>
        </button>
        <button className={btn} onClick={() => p.onStep(1)} title="Forward one candle (→)" aria-label="Forward one candle">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2 2v12l8-6zM11 2h2v12h-2z" /></svg>
        </button>
        <div className="ml-1 flex overflow-hidden rounded-[2px] border border-line" role="radiogroup" aria-label="Replay speed">
          {SPEEDS.map((sp) => (
            <button
              key={sp}
              role="radio"
              aria-checked={p.speed === sp}
              onClick={() => p.onSpeed(sp)}
              className={`h-8 px-2 text-[12px] num ${p.speed === sp ? "bg-chalk/15 text-chalk" : "bg-raised text-muted hover:text-text"}`}
            >
              {sp}×
            </button>
          ))}
        </div>
      </div>

      <dl className="ml-auto flex flex-wrap items-center gap-x-6 gap-y-1">
        <Stat label="Net worth" value={inr(s.netWorth)} hint={`Cash ${inr(s.cash)}${s.blockedForOrders > 0 ? `, of which ${inr(s.blockedForOrders)} is held for open orders` : ""}`} />
        <Stat label="Day's P&L" value={inr(s.dayPnl, { sign: true })} cls={tone(s.dayPnl)} />
        <Stat label="Total P&L" value={`${inr(s.totalPnl, { sign: true })}`} sub={pct(s.totalPnlPct)} cls={tone(s.totalPnl)} />
        <div className="flex gap-1.5">
          <button className={btn} onClick={p.onOpenAccount} title="Account and reset" aria-label="Account settings">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="5.5" r="2.8" /><path d="M2.5 14c.8-2.8 3-4 5.5-4s4.7 1.2 5.5 4" /></svg>
          </button>
          <button className={btn} onClick={p.onOpenShortcuts} title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">
            <span className="text-[13px] font-semibold">?</span>
          </button>
        </div>
      </dl>
    </header>
  );
}

function Stat({ label, value, sub, cls = "", hint }: { label: string; value: string; sub?: string; cls?: string; hint?: string }) {
  return (
    <div className="leading-tight" title={hint}>
      <dt className="cond text-[11.5px] uppercase text-muted">{label}</dt>
      <dd className={`text-[14px] font-semibold num ${cls}`}>
        {value}
        {sub && <span className="ml-1 text-[11px] font-medium">{sub}</span>}
      </dd>
    </div>
  );
}
