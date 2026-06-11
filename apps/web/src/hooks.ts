import { useEffect, useState } from "react";

// Returns whole seconds remaining until `target`, ticking every second.
// Null when no target; clamped at 0.
export function useCountdown(target: string | null | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!target) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [target]);

  if (!target) return null;
  const remainingMs = new Date(target).getTime() - now;
  return Math.max(0, Math.floor(remainingMs / 1000));
}

export function formatSeconds(total: number): string {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
