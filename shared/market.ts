// Market conventions shared by the data generator, the server and the client.
// All timestamps are epoch seconds (UTC). The market itself runs on IST.

export const IST_OFFSET_SECONDS = 5.5 * 60 * 60;
export const CANDLE_SECONDS = 30 * 60;

// NSE normal session, IST. The last candle (15:15) only covers 15 minutes.
export const SESSION_OPEN = { h: 9, m: 15 };
export const SESSION_CLOSE = { h: 15, m: 30 };
export const CANDLE_STARTS = [
  "09:15", "09:45", "10:15", "10:45", "11:15", "11:45", "12:15",
  "12:45", "13:15", "13:45", "14:15", "14:45", "15:15",
] as const;

export type Side = "BUY" | "SELL";
export type OrderType = "MARKET" | "LIMIT";

/** "2026-09-01" + "09:15" (IST) to epoch seconds. */
export function istToEpoch(date: string, time: string): number {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  return Date.UTC(y, mo - 1, d, h, mi) / 1000 - IST_OFFSET_SECONDS;
}

/** Epoch seconds to IST calendar parts. */
export function epochToIst(ts: number) {
  const d = new Date((ts + IST_OFFSET_SECONDS) * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return { date, time, weekday: d.getUTCDay() };
}

/** ISO string with the +05:30 offset, as written to the CSV files. */
export function epochToIsoIst(ts: number): string {
  const { date, time } = epochToIst(ts);
  return `${date}T${time}:00+05:30`;
}

export function sessionBounds(date: string) {
  return {
    open: istToEpoch(date, "09:15"),
    close: istToEpoch(date, "15:30"),
  };
}

/** NSE tick size by price band (revised 15 Apr 2025), in paise. */
export function tickPaise(pricePaise: number): number {
  const rupees = pricePaise / 100;
  if (rupees < 250) return 1;
  if (rupees < 1000) return 5;
  if (rupees < 5000) return 10;
  if (rupees < 10000) return 50;
  if (rupees < 20000) return 100;
  return 500;
}

export function roundToTick(pricePaise: number, mode: "nearest" | "up" | "down" = "nearest"): number {
  const t = tickPaise(pricePaise);
  const q = pricePaise / t;
  const n = mode === "up" ? Math.ceil(q - 1e-9) : mode === "down" ? Math.floor(q + 1e-9) : Math.round(q);
  return n * t;
}
