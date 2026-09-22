import { useState } from "react";
import { api, type Portfolio } from "../api.ts";
import { inr } from "../format.ts";
import { Dialog } from "./Dialog.tsx";

interface Props {
  portfolio: Portfolio;
  onClose: () => void;
  onChanged: (message: string, restartClock: boolean) => void;
}

export function AccountDialog({ portfolio, onClose, onChanged }: Props) {
  const [charges, setCharges] = useState(portfolio.account.chargesEnabled);
  const [capital, setCapital] = useState(String(portfolio.account.startingCash / 100));
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const capitalNum = Number(capital);
  const capitalOk = capitalNum >= 10_000 && capitalNum <= 10_00_00_000;

  const run = async (fn: () => Promise<unknown>, msg: string, restart: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged(msg, restart);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="Account" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div className="text-[12px] leading-relaxed text-muted">
          Signed in as <span className="text-text">{portfolio.account.name}</span>, the single demo user. Started with{" "}
          <span className="text-text">{inr(portfolio.account.startingCash)}</span> of virtual money.
        </div>

        <label className="flex items-start gap-3">
          <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--color-flame)]" checked={charges} onChange={(e) => setCharges(e.target.checked)} />
          <span>
            <span className="font-medium">Apply real delivery charges</span>
            <span className="block text-[12px] text-muted">STT, exchange, SEBI, stamp duty, GST and DP, as on a Zerodha contract note. Applies to new trades.</span>
          </span>
        </label>
        {charges !== portfolio.account.chargesEnabled && (
          <button
            disabled={busy}
            onClick={() => run(() => api.setCharges(charges), charges ? "Charges turned on" : "Charges turned off", false)}
            className="h-9 self-start rounded-md border border-line bg-raised px-3 font-medium hover:border-muted"
          >Save charges setting</button>
        )}

        <div className="border-t border-line pt-4">
          <div className="font-medium">Start over</div>
          <p className="mt-0.5 text-[12px] text-muted">Deletes every order and transaction and puts the clock back to the first candle.</p>
          <label className="mt-3 flex flex-col gap-1">
            <span className="text-[11px] text-muted">Starting capital (₹10,000 to ₹10 crore)</span>
            <input inputMode="numeric" value={capital} onChange={(e) => setCapital(e.target.value.replace(/[^\d]/g, ""))} className="h-9 rounded-md border border-line bg-raised px-2.5 num" />
          </label>
          {!confirming ? (
            <button
              disabled={!capitalOk}
              onClick={() => setConfirming(true)}
              className="mt-3 h-9 rounded-md border border-down/60 px-3 font-medium text-down hover:bg-down/10 disabled:opacity-40"
            >Reset account</button>
          ) : (
            <div className="mt-3 flex items-center gap-2">
              <button
                disabled={busy}
                onClick={() => run(() => api.reset(capitalNum, charges), `Account reset with ${inr(capitalNum * 100)}`, true)}
                className="h-9 rounded-md bg-down px-3 font-semibold text-white"
              >Yes, delete my trades</button>
              <button onClick={() => setConfirming(false)} className="h-9 px-3 text-muted hover:text-text">Keep them</button>
            </div>
          )}
        </div>
        {error && <p className="text-down">{error}</p>}
      </div>
    </Dialog>
  );
}
