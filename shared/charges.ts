import type { Side } from "./market.ts";

// Equity delivery charges, modelled on Zerodha's published schedule (zerodha.com/charges).
// Every amount is in paise and rounded per line, the way a contract note shows it.
export const RATES = {
  brokerage: 0, // zero brokerage on delivery
  stt: 0.001, // 0.1% on buy and sell
  exchange: 0.0000307, // NSE transaction charge
  sebi: 0.000001, // Rs 10 per crore
  stampBuy: 0.00015, // 0.015%, buy side only
  gst: 0.18, // on brokerage + exchange + SEBI fees
  dpPerSell: 1534, // Rs 15.34 per scrip per day on the sell side
};

export interface ChargeBreakdown {
  brokerage: number;
  stt: number;
  exchange: number;
  sebi: number;
  stamp: number;
  gst: number;
  dp: number;
  total: number;
}

export const NO_CHARGES: ChargeBreakdown = { brokerage: 0, stt: 0, exchange: 0, sebi: 0, stamp: 0, gst: 0, dp: 0, total: 0 };

/**
 * @param turnover qty x price, paise
 * @param firstSellOfDay DP charge is levied once per scrip per day
 */
export function computeCharges(side: Side, turnover: number, firstSellOfDay = true): ChargeBreakdown {
  const brokerage = RATES.brokerage;
  const stt = Math.round(turnover * RATES.stt);
  const exchange = Math.round(turnover * RATES.exchange);
  const sebi = Math.round(turnover * RATES.sebi);
  const stamp = side === "BUY" ? Math.round(turnover * RATES.stampBuy) : 0;
  const gst = Math.round((brokerage + exchange + sebi) * RATES.gst);
  const dp = side === "SELL" && firstSellOfDay ? RATES.dpPerSell : 0;
  return { brokerage, stt, exchange, sebi, stamp, gst, dp, total: brokerage + stt + exchange + sebi + stamp + gst + dp };
}
