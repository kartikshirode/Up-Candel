// Window-relative time helpers for the tests.
//
// The generated market data covers a fixed stretch of trading days. Tests say
// "the 3rd trading day" or "the first weekend" instead of naming a calendar
// date, so moving the window does not break them.

import { openDatabase } from "../server/db.ts";
import { Market } from "../server/market.ts";
import { epochToIst, istToEpoch } from "../shared/market.ts";

const ONE_DAY = 24 * 60 * 60;

/** Every trading day in the generated data, ascending. Read once at load. */
export const TRADING_DAYS: string[] = new Market(openDatabase(":memory:")).tradingDays;

/** The i-th trading day. Negative counts back from the end, so day(-1) is the last. */
export const day = (i: number): string => {
  const d = TRADING_DAYS.at(i);
  if (!d) throw new Error(`no trading day at index ${i}`);
  return d;
};

/** A timestamp at `time` IST on the i-th trading day. t(0, "09:15") is the very first candle. */
export const t = (i: number, time: string): number => istToEpoch(day(i), time);

/** A timestamp on any calendar date, for the days the market is shut. */
export const ist = (date: string, time: string): number => istToEpoch(date, time);

/** `n` calendar days past the last trading day: beyond the end of the data. */
export const afterEnd = (n: number, time: string): number => t(-1, time) + n * ONE_DAY;

function closedDates() {
  const weekend: string[] = [];
  const holiday: string[] = [];
  const last = ist(day(-1), "12:00");
  for (let ts = ist(day(0), "12:00"); ts <= last; ts += ONE_DAY) {
    const { date, weekday } = epochToIst(ts);
    if (TRADING_DAYS.includes(date)) continue;
    (weekday === 0 || weekday === 6 ? weekend : holiday).push(date);
  }
  return { weekend, holiday };
}

/** Saturdays and Sundays inside the window, ascending. */
export const WEEKENDS: string[] = closedDates().weekend;

/** Weekdays inside the window that the exchange was shut anyway. */
export const HOLIDAYS: string[] = closedDates().holiday;
