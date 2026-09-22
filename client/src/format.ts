import { epochToIst, IST_OFFSET_SECONDS } from "../../shared/market.ts";

const inrFmt = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const inrCompact = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", notation: "compact", maximumFractionDigits: 2 });
const intFmt = new Intl.NumberFormat("en-IN");

/** Paise to "₹12,34,567.89". */
export function inr(paise: number, opts: { sign?: boolean; compact?: boolean } = {}): string {
  const rupees = paise / 100;
  const body = (opts.compact ? inrCompact : inrFmt).format(Math.abs(rupees));
  if (opts.sign) return `${rupees > 0 ? "+" : rupees < 0 ? "−" : ""}${body}`;
  return rupees < 0 ? `−${body}` : body;
}

/** Paise to "2,076.10" without the currency sign, for prices in dense tables. */
export function price(paise: number): string {
  return (paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function pct(value: number | null, sign = true): string {
  if (value === null || !Number.isFinite(value)) return "–";
  const s = sign && value > 0 ? "+" : value < 0 ? "−" : "";
  return `${s}${Math.abs(value).toFixed(2)}%`;
}

export function int(n: number): string {
  return intFmt.format(n);
}

export function tone(n: number | null): "up" | "down" | "" {
  if (n === null || n === 0) return "";
  return n > 0 ? "up" : "down";
}

export function arrow(n: number): string {
  return n > 0 ? "▲" : n < 0 ? "▼" : "";
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Tue 1 Sep, 10:15" */
export function when(ts: number, withYear = false): string {
  const { date, time, weekday } = epochToIst(ts);
  const [y, m, d] = date.split("-").map(Number);
  return `${WEEKDAYS[weekday]} ${d} ${MONTHS[m - 1]}${withYear ? ` ${y}` : ""}, ${time}`;
}

export function dayLabel(date: string): { weekday: string; day: number; month: string } {
  const [y, m, d] = date.split("-").map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return { weekday, day: d, month: MONTHS[m - 1] };
}

/** Value for <input type="datetime-local">, in IST. */
export function toLocalInput(ts: number): string {
  const { date, time } = epochToIst(ts);
  return `${date}T${time}`;
}

/** Charts label their axis in UTC, so shift candle times to show IST. */
export function chartTime(ts: number): number {
  return ts + IST_OFFSET_SECONDS;
}
