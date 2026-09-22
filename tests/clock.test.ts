import { describe, expect, it } from "vitest";
import { atEndOfData, nextCandle, prevCandle } from "../client/src/clock.ts";
import { openDatabase } from "../server/db.ts";
import { Market } from "../server/market.ts";

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
