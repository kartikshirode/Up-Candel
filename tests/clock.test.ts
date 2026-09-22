import { describe, expect, it } from "vitest";
import { atEndOfData, nextCandle, prevCandle } from "../client/src/clock.ts";
import { openDatabase } from "../server/db.ts";
import { Market } from "../server/market.ts";
import { CANDLE_SECONDS } from "../shared/market.ts";
import { HOLIDAYS, ist, t, TRADING_DAYS } from "./helpers.ts";

const market = new Market(openDatabase(":memory:"));
const timeline = market.timeline;
const first = timeline[0];
const last = timeline[timeline.length - 1];

describe("replay clock", () => {
  it("steps to the next candle, including across a closed day", () => {
    expect(nextCandle(timeline, first)).toBe(timeline[1]);
    expect(nextCandle(timeline, first + 60)).toBe(timeline[1]); // from between candles
    const lastOfDay = timeline[12];
    expect(nextCandle(timeline, lastOfDay)).toBe(timeline[13]); // 15:15 to the next day's 09:15
  });

  it("steps back to the previous candle and stops at the first", () => {
    expect(prevCandle(timeline, timeline[1])).toBe(first);
    expect(prevCandle(timeline, first)).toBe(first);
    expect(prevCandle(timeline, last + 3600)).toBe(last);
  });

  it("knows when the data has run out, so Play can offer a restart", () => {
    expect(atEndOfData(timeline, first)).toBe(false);
    expect(atEndOfData(timeline, timeline[timeline.length - 2])).toBe(false);
    expect(atEndOfData(timeline, last)).toBe(true);
    expect(atEndOfData(timeline, market.range.end)).toBe(true); // 15:30, past the last candle
  });
});

describe("replay clock edges", () => {
  it("steps forward from before the data and from inside a candle", () => {
    expect(nextCandle(timeline, first - 1)).toBe(first);
    expect(nextCandle(timeline, first - 7 * 24 * 3600)).toBe(first);
    expect(nextCandle(timeline, first + CANDLE_SECONDS - 1)).toBe(timeline[1]);
    expect(nextCandle(timeline, timeline[1] - 1)).toBe(timeline[1]);
  });

  it("has nothing left after the last candle, whatever the clock says", () => {
    expect(nextCandle(timeline, last)).toBeNull();
    expect(nextCandle(timeline, last + 1)).toBeNull();
    expect(nextCandle(timeline, last + 30 * 24 * 3600)).toBeNull();
    expect(atEndOfData(timeline, last + 30 * 24 * 3600)).toBe(true);
    // The last candle of an earlier day is not the end of the data.
    expect(atEndOfData(timeline, t(-2, "15:15"))).toBe(false);
    expect(atEndOfData(timeline, t(-1, "09:15"))).toBe(false);
  });

  it("steps over the weekend and the exchange holiday in one move", () => {
    const beforeHoliday = TRADING_DAYS.filter((d) => d < HOLIDAYS[0]).length - 1;
    expect(nextCandle(timeline, t(beforeHoliday, "15:15"))).toBe(t(beforeHoliday + 1, "09:15"));
    expect(prevCandle(timeline, t(beforeHoliday + 1, "09:15"))).toBe(t(beforeHoliday, "15:15"));
    // The holiday itself sits between the two, and stepping from it lands on the next session.
    const holiday = ist(HOLIDAYS[0], "12:00");
    expect(nextCandle(timeline, holiday)).toBe(t(beforeHoliday + 1, "09:15"));
    expect(prevCandle(timeline, holiday)).toBe(t(beforeHoliday, "15:15"));
  });

  it("steps back from inside a candle and pairs up with stepping forward", () => {
    expect(prevCandle(timeline, first + CANDLE_SECONDS - 1)).toBe(first);
    expect(prevCandle(timeline, timeline[5] + 60)).toBe(timeline[5]);
    for (const i of [0, 1, 12, 13, 100, timeline.length - 2]) {
      expect(prevCandle(timeline, nextCandle(timeline, timeline[i])!)).toBe(timeline[i]);
    }
  });

  it("clamps a step back from before the data to the first candle", () => {
    // Documents current behaviour: with nothing behind it, stepping back hands out the
    // first candle even though that is later than where the clock was.
    expect(prevCandle(timeline, first - 1)).toBe(first);
    expect(prevCandle(timeline, 1)).toBe(first);
  });

  it("says an empty timeline has already ended and never moves", () => {
    expect(nextCandle([], first)).toBeNull();
    expect(atEndOfData([], first)).toBe(true);
    expect(prevCandle([], first)).toBe(first);
  });

  it("walks the whole timeline forwards and back with nothing skipped", () => {
    const forward: number[] = [];
    for (let at: number | null = first; at !== null; at = nextCandle(timeline, at)) forward.push(at);
    expect(forward).toEqual(timeline);
    const back: number[] = [last];
    while (back[0] !== first) back.unshift(prevCandle(timeline, back[0]));
    expect(back).toEqual(timeline);
  });
});
