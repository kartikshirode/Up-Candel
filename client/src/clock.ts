/** Stepping rules for the simulated clock, kept pure so they can be tested. */

/** The next candle after `at`, or null once the data runs out. */
export function nextCandle(timeline: number[], at: number): number | null {
  return timeline.find((ts) => ts > at) ?? null;
}

/** The candle before `at`, or the first one if `at` is already at the start. */
export function prevCandle(timeline: number[], at: number): number {
  for (let i = timeline.length - 1; i >= 0; i--) if (timeline[i] < at) return timeline[i];
  return timeline[0] ?? at;
}

/** True once the clock has nothing left to play, so Play has to restart instead. */
export function atEndOfData(timeline: number[], at: number): boolean {
  return nextCandle(timeline, at) === null;
}
