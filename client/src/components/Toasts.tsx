export interface Toast { id: number; kind: "success" | "error" | "info"; title: string; body?: string }

const BAR: Record<Toast["kind"], string> = { success: "bg-up", error: "bg-down", info: "bg-chalk" };

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(360px,calc(100vw-32px))] flex-col gap-2" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} role={t.kind === "error" ? "alert" : "status"} className="toast-in pointer-events-auto flex overflow-hidden rounded-[2px] border border-line bg-raised">
          <span className={`w-1 shrink-0 ${BAR[t.kind]}`} />
          <div className="flex-1 px-3 py-2.5">
            <div className="font-semibold">{t.title}</div>
            {t.body && <div className="mt-0.5 text-[12px] leading-snug text-muted">{t.body}</div>}
          </div>
          <button className="px-3 text-muted hover:text-text" onClick={() => onDismiss(t.id)} aria-label="Dismiss">×</button>
        </div>
      ))}
    </div>
  );
}
