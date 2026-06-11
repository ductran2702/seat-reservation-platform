import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../auth";
import {
  api,
  ApiError,
  type AppConfig,
  type PaymentOutcome,
  type SeatView,
} from "../api";
import { useCountdown, formatSeconds } from "../hooks";

// Polling is the fallback transport. While the SSE stream is connected we
// slow it down to a drift guard; if the stream drops we go back to 3s.
const FAST_POLL_MS = 3000;
const SLOW_POLL_MS = 30000;
const MAX_SEATS = 2;

export function SeatsPage() {
  const { user, logout } = useAuth();
  const [seats, setSeats] = useState<SeatView[]>([]);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [holding, setHolding] = useState(false);
  const [paying, setPaying] = useState<PaymentOutcome | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const { seats } = await api.getSeats();
      setSeats(seats);
    } catch {
      // Ignore transient poll failures; the next tick retries.
    }
  }, []);

  useEffect(() => {
    refresh();
    api.config().then(setConfig).catch(() => undefined);

    let pollId: number | undefined;
    const setPolling = (ms: number) => {
      if (pollId !== undefined) window.clearInterval(pollId);
      pollId = window.setInterval(refresh, ms);
    };
    setPolling(FAST_POLL_MS);

    // Live availability over SSE: the gateway pushes a personalized snapshot
    // on connect and a seat_change event on every mutation (hold created,
    // cancelled, expired by the sweeper, payment confirmed/failed).
    // EventSource auto-reconnects; polling covers the gaps.
    const stream = new EventSource("/api/seats/stream");
    stream.addEventListener("snapshot", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as {
          seats?: SeatView[];
        };
        if (data.seats) setSeats(data.seats);
      } catch {
        // Malformed frame — the next poll corrects the view.
      }
    });
    stream.addEventListener("seat_change", () => {
      refresh();
    });
    stream.onopen = () => setPolling(SLOW_POLL_MS);
    stream.onerror = () => setPolling(FAST_POLL_MS);

    return () => {
      stream.close();
      if (pollId !== undefined) window.clearInterval(pollId);
    };
  }, [refresh]);

  const myHolds = seats.filter((s) => s.mine && s.status === "HELD");
  const maxHolds = config?.maxActiveReservationsPerUser ?? MAX_SEATS;
  // Reserved (CONFIRMED) seats are not holds — only pending HELD seats count.
  const remainingSlots = Math.max(0, maxHolds - myHolds.length);
  const busy = holding || paying !== null || cancelling;

  const toggleSelect = (seat: SeatView) => {
    if (seat.status !== "AVAILABLE" || busy) return;
    setError(null);
    setNotice(null);
    setSelected((prev) => {
      if (prev.includes(seat.id)) return prev.filter((id) => id !== seat.id);
      if (prev.length >= remainingSlots) {
        setNotice(`You can hold up to ${MAX_SEATS} seats at a time.`);
        return prev;
      }
      return [...prev, seat.id];
    });
  };

  const holdSelected = async () => {
    if (selected.length === 0) return;
    setError(null);
    setNotice(null);
    setHolding(true);
    try {
      const results = await Promise.allSettled(
        selected.map((id) => api.createReservation(id)),
      );
      const failed = results.filter(
        (r): r is PromiseRejectedResult => r.status === "rejected",
      );
      if (failed.length > 0) {
        const reason = failed[0].reason;
        setError(
          reason instanceof ApiError
            ? reason.message
            : "Some seats could not be held.",
        );
      }
      setSelected([]);
      await refresh();
    } finally {
      setHolding(false);
    }
  };

  const cancelAllHolds = async () => {
    const toCancel = myHolds
      .map((h) => h.reservationId)
      .filter((id): id is string => Boolean(id));
    if (toCancel.length === 0) return;

    setError(null);
    setNotice(null);
    setCancelling(true);
    try {
      const results = await Promise.allSettled(
        toCancel.map((id) => api.cancelReservation(id)),
      );
      const failed = results.find((r) => r.status === "rejected");
      if (failed && failed.status === "rejected") {
        const reason = failed.reason;
        setError(
          reason instanceof ApiError
            ? reason.message
            : "Could not cancel all holds.",
        );
      }
      await refresh();
    } finally {
      setCancelling(false);
    }
  };

  const payAll = async (outcome: PaymentOutcome) => {
    if (myHolds.length === 0) return;
    setError(null);
    setNotice(null);
    setPaying(outcome);
    try {
      for (const hold of myHolds) {
        if (!hold.reservationId) continue;
        await api.createIntent(hold.reservationId);
        await api.confirmPayment(hold.reservationId, outcome);
      }
      await refresh();
      if (outcome === "success") {
        setNotice("Payment successful — your seats are reserved.");
      } else if (outcome === "timeout") {
        setNotice("Payment timed out. Your seats are still held — try again.");
      } else {
        setNotice("Payment failed. Your holds have been released.");
      }
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.code === "hold_expired"
            ? "A hold expired before payment completed."
            : err.message
          : "Payment could not be processed.",
      );
      await refresh();
    } finally {
      setPaying(null);
    }
  };

  const earliestExpiry =
    myHolds.length > 0
      ? myHolds.reduce<string | null>((min, h) => {
          if (!h.holdExpiresAt) return min;
          if (!min) return h.holdExpiresAt;
          return new Date(h.holdExpiresAt) < new Date(min)
            ? h.holdExpiresAt
            : min;
        }, null)
      : null;
  const holdSecondsLeft = useCountdown(earliestExpiry);

  const priceCents = config?.seatPriceCents ?? 0;
  const totalCents = priceCents * myHolds.length;

  return (
    <div className="page">
      <header className="topbar">
        <h1>Choose your seats</h1>
        <div className="topbar-right">
          <span className="muted">{user?.email}</span>
          <button className="btn ghost" onClick={() => logout()}>
            Log out
          </button>
        </div>
      </header>

      {error && <div className="alert error">{error}</div>}
      {notice && <div className="alert info">{notice}</div>}

      <div className="seat-grid">
        {seats.map((seat) => (
          <SeatCard
            key={seat.id}
            seat={seat}
            selected={selected.includes(seat.id)}
            disabled={busy}
            onToggle={() => toggleSelect(seat)}
          />
        ))}
      </div>

      <div className="action-bar">
        <span className="muted">
          {selected.length > 0
            ? `${selected.length} seat${selected.length > 1 ? "s" : ""} selected`
            : `Select up to ${remainingSlots || MAX_SEATS} seat${
                (remainingSlots || MAX_SEATS) > 1 ? "s" : ""
              }`}
        </span>
        <button
          className="btn primary"
          disabled={selected.length === 0 || busy}
          onClick={holdSelected}
        >
          {holding ? "Holding…" : "Hold"}
        </button>
      </div>

      {myHolds.length > 0 && (
        <div className="card payment">
          <h2>Payment</h2>
          <p className="muted">
            You are holding {myHolds.length} seat
            {myHolds.length > 1 ? "s" : ""}. Complete payment before the hold
            expires.
          </p>

          <ul className="hold-list">
            {myHolds.map((h) => (
              <li key={h.id} className="hold-row">
                <span className="hold-seat">Seat {h.label}</span>
              </li>
            ))}
          </ul>

          <div className="checkout-row">
            <span className="muted">Expires in</span>
            <strong className={holdSecondsLeft === 0 ? "danger" : ""}>
              {holdSecondsLeft !== null
                ? formatSeconds(holdSecondsLeft)
                : "—"}
            </strong>
          </div>

          <div className="checkout-row">
            <span className="muted">Total</span>
            <strong>${(totalCents / 100).toFixed(2)}</strong>
          </div>

          <div className="cancel-row">
            <button
              className="btn ghost"
              disabled={busy}
              onClick={cancelAllHolds}
            >
              {cancelling ? "Cancelling…" : "Cancel"}
            </button>
          </div>

          <p className="muted hint">
            Simulated payment provider — choose an outcome:
          </p>
          <div className="pay-actions">
            <button
              className="btn primary"
              disabled={busy}
              onClick={() => payAll("success")}
            >
              {paying === "success" ? "Processing…" : "Pay all (success)"}
            </button>
            <button
              className="btn ghost"
              disabled={busy}
              onClick={() => payAll("fail")}
            >
              Simulate failure
            </button>
            <button
              className="btn ghost"
              disabled={busy}
              onClick={() => payAll("timeout")}
            >
              Simulate timeout
            </button>
          </div>
        </div>
      )}

      <p className="muted hint">
        Seat availability updates live (SSE), with polling as fallback.
      </p>
    </div>
  );
}

function SeatCard({
  seat,
  selected,
  disabled,
  onToggle,
}: {
  seat: SeatView;
  selected: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const clickable = seat.status === "AVAILABLE" && !disabled;

  const stateClass = selected
    ? "selected"
    : seat.status === "CONFIRMED" && seat.mine
      ? "reserved"
      : seat.status === "HELD" && seat.mine
        ? "mine"
        : seat.status === "AVAILABLE"
          ? "available"
          : "taken";

  return (
    <div
      className={`card seat ${stateClass} ${clickable ? "clickable" : ""}`}
      onClick={clickable ? onToggle : undefined}
      role={clickable ? "button" : undefined}
    >
      <div className="seat-label">{seat.label}</div>

      {seat.status === "AVAILABLE" && (
        <div className={`badge ${selected ? "mine" : "available"}`}>
          {selected ? "Selected ✓" : "Available"}
        </div>
      )}

      {seat.status === "HELD" && seat.mine && (
        <div className="badge mine">On hold</div>
      )}

      {seat.status === "HELD" && !seat.mine && (
        <div className="badge taken">On hold</div>
      )}

      {seat.status === "CONFIRMED" && (
        <div className={`badge ${seat.mine ? "mine" : "taken"}`}>
          {seat.mine ? "Reserved by you ✓" : "Reserved"}
        </div>
      )}
    </div>
  );
}
