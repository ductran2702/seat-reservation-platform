export type SeatStatus = "AVAILABLE" | "HELD" | "CONFIRMED";

export interface SeatView {
  id: string;
  label: string;
  status: SeatStatus;
  mine: boolean;
  reservationId: string | null;
  holdExpiresAt: string | null;
}

export type ReservationStatus =
  | "HELD"
  | "CONFIRMED"
  | "EXPIRED"
  | "CANCELLED"
  | "FAILED";

export interface ReservationView {
  id: string;
  seatId: string;
  seatLabel: string | null;
  status: ReservationStatus;
  holdExpiresAt: string;
  confirmedAt: string | null;
  paymentStatus: "PENDING" | "SUCCEEDED" | "FAILED" | "TIMEOUT" | null;
  createdAt: string;
}

export interface PaymentView {
  id: string;
  reservationId: string;
  amountCents: number;
  status: "PENDING" | "SUCCEEDED" | "FAILED" | "TIMEOUT";
  outcome: string | null;
  createdAt: string;
}

export interface User {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

export type PaymentOutcome = "success" | "fail" | "timeout";

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  allowRefresh = true,
): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
    ...options,
  });

  // Transparently refresh an expired access token once, then retry.
  if (
    res.status === 401 &&
    allowRefresh &&
    !path.startsWith("/api/auth/")
  ) {
    const refreshed = await fetch("/api/auth/refresh", {
      method: "POST",
      credentials: "include",
    });
    if (refreshed.ok) {
      return request<T>(path, options, false);
    }
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new ApiError(
      res.status,
      data?.error ?? "error",
      data?.message ?? res.statusText,
    );
  }
  return data as T;
}

export interface AppConfig {
  seatPriceCents: number;
  holdTtlSeconds: number;
  maxActiveReservationsPerUser: number;
}

export const api = {
  config: () => request<AppConfig>("/api/config"),
  me: () => request<{ user: User }>("/api/auth/me"),
  login: (email: string, password: string) =>
    request<{ user: User }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  register: (email: string, password: string, name: string) =>
    request<{ user: User }>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password, name }),
    }),
  logout: () => request<{ ok: true }>("/api/auth/logout", { method: "POST" }),
  getSeats: () => request<{ seats: SeatView[] }>("/api/seats"),
  createReservation: (seatId: string) =>
    request<{ reservation: ReservationView }>("/api/reservations", {
      method: "POST",
      // Client-generated idempotency key: retries of this hold attempt
      // (double-click, network blip) map to the same reservation server-side.
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ seatId }),
    }),
  getReservation: (id: string) =>
    request<{ reservation: ReservationView }>(`/api/reservations/${id}`),
  cancelReservation: (id: string) =>
    request<{ reservation: ReservationView }>(`/api/reservations/${id}`, {
      method: "DELETE",
    }),
  createIntent: (id: string) =>
    request<{
      reservation: ReservationView;
      payment?: PaymentView;
      checkoutUrl?: string;
      alreadyConfirmed?: boolean;
    }>(`/api/payments/${id}/intent`, { method: "POST" }),
  confirmPayment: (id: string, outcome: PaymentOutcome) =>
    request<{ reservation: ReservationView }>(
      `/api/payments/${id}/confirm?outcome=${outcome}`,
      { method: "POST" },
    ),
};
