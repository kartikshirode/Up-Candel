import type { ChargeBreakdown } from "../../shared/charges.ts";
import type { OrderType, Side } from "../../shared/market.ts";

export interface Meta {
  range: { start: number; end: number };
  timeline: number[];
  tradingDays: string[];
  stocks: { symbol: string; name: string; sector: string; exchange: string }[];
  account: { name: string; startingCash: number; chargesEnabled: boolean };
  latestActivity: number | null;
}

export interface MarketStatus { state: string; isOpen: boolean; label: string; tradingDay: string | null }

export interface Quote {
  symbol: string;
  name: string;
  sector: string;
  ltp: number;
  candleTs: number | null;
  prevClose: number;
  change: number;
  changePct: number;
  dayOpen: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  dayVolume: number;
  spark: number[];
}

export interface MarketSnapshot { at: number; status: MarketStatus; latestActivity: number | null; quotes: Quote[] }

export interface Candle { ts: number; open: number; high: number; low: number; close: number; volume: number }

export interface Holding {
  symbol: string; name: string; sector: string; qty: number; avgPrice: number; invested: number; ltp: number;
  currentValue: number; unrealizedPnl: number; unrealizedPct: number; dayPnl: number; dayChangePct: number; realizedPnl: number;
}

export interface Portfolio {
  account: { name: string; startingCash: number; chargesEnabled: boolean };
  summary: {
    cash: number; blockedForOrders: number; availableCash: number; invested: number; currentValue: number; netWorth: number;
    unrealizedPnl: number; realizedPnl: number; charges: number; totalPnl: number; totalPnlPct: number; dayPnl: number;
  };
  holdings: Holding[];
  closedPositions: { symbol: string; realizedPnl: number }[];
}

export interface Order {
  id: number; symbol: string; side: Side; type: OrderType; qty: number; limitPrice: number | null;
  status: "OPEN" | "FILLED" | "CANCELLED" | "REJECTED"; placedAt: number; resolvedAt: number | null;
  fillPrice: number | null; charges: number | null; reason: string | null; note: string | null;
}

export interface Trade {
  id: number; orderId: number; symbol: string; side: Side; qty: number; price: number; value: number; charges: number;
  chargesBreakdown: ChargeBreakdown; netAmount: number; realizedPnl: number | null; simTime: number; note: string | null;
}

export interface Performance {
  curve: { ts: number; netWorth: number; benchmark: number }[];
  stats: {
    portfolioReturnPct: number; benchmarkReturnPct: number; alphaPct: number; maxDrawdownPct: number; tradeCount: number;
    closedTrades: number; winRatePct: number | null; totalCharges: number;
    bestTrade: { symbol: string; pnl: number; simTime: number } | null;
    worstTrade: { symbol: string; pnl: number; simTime: number } | null;
  };
}

export interface WhatIf {
  from: number; at: number; amount: number;
  results: { symbol: string; name: string; buyPrice: number; priceNow: number; shares: number; value: number; pnl: number; returnPct: number }[];
}

export class ApiError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(body?.error?.code ?? "HTTP", body?.error?.message ?? `Request failed (${res.status}).`);
  return body as T;
}

export const api = {
  meta: () => call<Meta>("/api/meta"),
  market: (at: number) => call<MarketSnapshot>(`/api/market?at=${at}`),
  candles: (symbol: string, at: number) => call<{ symbol: string; candles: Candle[] }>(`/api/stocks/${symbol}/candles?at=${at}`),
  portfolio: (at: number) => call<Portfolio>(`/api/portfolio?at=${at}`),
  orders: (at: number) => call<Order[]>(`/api/orders?at=${at}`),
  trades: (at: number) => call<Trade[]>(`/api/transactions?at=${at}`),
  performance: (at: number) => call<Performance>(`/api/performance?at=${at}`),
  whatIf: (from: number, at: number, amountRupees: number) => call<WhatIf>(`/api/what-if?from=${from}&at=${at}&amount=${amountRupees}`),
  placeOrder: (body: { symbol: string; side: Side; type: OrderType; qty: number; limitPrice?: number; at: number; note?: string }) =>
    call<Order>("/api/orders", { method: "POST", body: JSON.stringify(body) }),
  cancelOrder: (id: number, at: number) => call<Order>(`/api/orders/${id}/cancel`, { method: "POST", body: JSON.stringify({ at }) }),
  setCharges: (chargesEnabled: boolean) => call<{ chargesEnabled: boolean }>("/api/account", { method: "PATCH", body: JSON.stringify({ chargesEnabled }) }),
  reset: (startingCash: number, chargesEnabled: boolean) =>
    call<{ ok: true }>("/api/account/reset", { method: "POST", body: JSON.stringify({ startingCash, chargesEnabled }) }),
  csvUrl: (at: number) => `/api/transactions?format=csv&at=${at}`,
};
