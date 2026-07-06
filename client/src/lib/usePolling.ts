import { useEffect } from "react";

/**
 * Re-run `callback` every `intervalMs` while the component is mounted, so
 * derived views (open-ticket counts, "on shift now") stay roughly live. The
 * callback is not invoked immediately — pair it with an initial load effect.
 * The interval is re-established whenever `callback` changes, so pass a stable
 * (useCallback-wrapped) function to avoid resetting the timer each render.
 */
export function usePolling(callback: () => void, intervalMs: number): void {
  useEffect(() => {
    const id = window.setInterval(callback, intervalMs);
    return () => window.clearInterval(id);
  }, [callback, intervalMs]);
}
