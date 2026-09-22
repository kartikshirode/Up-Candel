import { Dialog } from "./Dialog.tsx";

const KEYS: [string, string][] = [
  ["Space", "Play or pause the replay"],
  ["← →", "Step one candle back or forward"],
  ["↑ ↓", "Move through the watchlist"],
  ["B", "Buy the selected stock"],
  ["S", "Sell the selected stock"],
  ["H O T P W", "Holdings, Orders, Transactions, Performance, What if"],
  ["?", "Show this list"],
  ["Esc", "Close a dialog"],
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose}>
      <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2">
        {KEYS.map(([k, v]) => (
          <div key={k} className="contents">
            <dt><kbd className="rounded border border-line bg-raised px-1.5 py-0.5 text-[12px]">{k}</kbd></dt>
            <dd className="text-muted">{v}</dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}
