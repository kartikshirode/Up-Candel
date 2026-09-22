import { createApp } from "./app.ts";
import { openDatabase } from "./db.ts";
import { Engine } from "./engine.ts";
import { Market } from "./market.ts";

const db = openDatabase();
const market = new Market(db);
const engine = new Engine(db, market);
const port = Number(process.env.PORT ?? 3001);

createApp(engine).listen(port, () => {
  console.log(`Up-Candel API on http://localhost:${port}`);
  console.log(`Loaded ${market.stocks.length} stocks, ${market.timeline.length} candles each, ${market.tradingDays.length} trading days.`);
});
