import { Router } from "express";
import { z } from "zod";
import { prisma } from "@srp/db";
import {
  ApiError,
  INTERNAL_SECRET_HEADER,
  asyncHandler,
  createInternalAuth,
} from "@srp/linkz-core";
import { env } from "../env.js";
import { toPaymentView, toReservationView } from "../lib/views.js";

const { requireAuth } = createInternalAuth(env.internalSecret);

export const paymentsRouter = Router();
paymentsRouter.use(requireAuth);

const outcomeSchema = z.enum(["success", "fail", "timeout"]);

// payment-svc mutates reservation rows on confirm/fail, but seat-svc is the
// write authority for seat state — report the mutation so cache invalidation
// and SSE fan-out happen there. Fire-and-forget (clients poll as fallback).
function reportSeatChange(type: string, seatId: string): void {
  fetch(`${env.seatSvcUrl}/internal/seat-changed`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [INTERNAL_SECRET_HEADER]: env.internalSecret,
    },
    body: JSON.stringify({ type, seatId }),
  }).catch(() => undefined);
}

// Step 1 — create a payment intent and hand back a (mock) checkout URL.
// Mirrors initiating a redirect to a hosted payment page.
paymentsRouter.post(
  "/:reservationId/intent",
  asyncHandler(async (req, res) => {
    const { reservationId } = req.params;
    const userId = req.userId!;
    const now = new Date();

    const result = await prisma.$transaction(async (tx) => {
      const reservation = await tx.reservation.findUnique({
        where: { id: reservationId },
        include: { seat: true, payment: true },
      });
      if (!reservation || reservation.userId !== userId) {
        throw new ApiError(404, "reservation_not_found");
      }
      if (reservation.status === "CONFIRMED") {
        return { reservation, alreadyConfirmed: true };
      }
      if (reservation.status !== "HELD") {
        throw new ApiError(409, "reservation_not_holdable");
      }
      if (reservation.holdExpiresAt <= now) {
        await tx.reservation.update({
          where: { id: reservationId },
          data: { status: "EXPIRED" },
        });
        throw new ApiError(409, "hold_expired", "Your seat hold has expired");
      }

      // One Payment per reservation (unique). Re-intent reuses/resets it.
      const payment = await tx.payment.upsert({
        where: { reservationId },
        update: { status: "PENDING", outcome: null, amountCents: env.seatPriceCents },
        create: {
          reservationId,
          amountCents: env.seatPriceCents,
          status: "PENDING",
        },
      });
      return { reservation, payment, alreadyConfirmed: false };
    });

    if (result.alreadyConfirmed) {
      res.json({
        reservation: toReservationView(result.reservation),
        alreadyConfirmed: true,
      });
      return;
    }

    res.status(201).json({
      reservation: toReservationView(result.reservation),
      payment: toPaymentView(result.payment!),
      // The SPA renders this mock provider page (built in the frontend phase).
      checkoutUrl: `${env.webOrigin}/checkout/${reservationId}`,
    });
  }),
);

// Step 2 — the mock provider "callback". Outcome is driven by ?outcome=.
// Idempotent: the one-Payment-per-reservation UNIQUE constraint plus the
// CONFIRMED no-op below mean a double-click/retry can never double-charge.
// TODO(prod): a real PSP's webhook (not this HTTP response) is the source of
// truth — verify its signature and dedupe on payment_intent_id, since PSPs
// redeliver webhooks aggressively.
paymentsRouter.post(
  "/:reservationId/confirm",
  asyncHandler(async (req, res) => {
    const { reservationId } = req.params;
    const userId = req.userId!;
    const outcome = outcomeSchema.parse(req.query.outcome);
    const now = new Date();
    let seatStateChanged: string | null = null;

    const result = await prisma.$transaction(async (tx) => {
      const reservation = await tx.reservation.findUnique({
        where: { id: reservationId },
        include: { seat: true, payment: true },
      });
      if (!reservation || reservation.userId !== userId) {
        throw new ApiError(404, "reservation_not_found");
      }
      // Idempotent: confirming an already-confirmed reservation is a no-op.
      if (reservation.status === "CONFIRMED") {
        return reservation;
      }
      if (reservation.status !== "HELD") {
        throw new ApiError(409, "reservation_not_holdable");
      }
      if (reservation.holdExpiresAt <= now) {
        await tx.reservation.update({
          where: { id: reservationId },
          data: { status: "EXPIRED" },
        });
        throw new ApiError(409, "hold_expired", "Your seat hold has expired");
      }
      if (!reservation.payment) {
        throw new ApiError(409, "no_payment_intent", "Start payment first");
      }

      if (outcome === "success") {
        await tx.payment.update({
          where: { reservationId },
          data: { status: "SUCCEEDED", outcome },
        });
        seatStateChanged = "reservation_confirmed";
        return tx.reservation.update({
          where: { id: reservationId },
          data: { status: "CONFIRMED", confirmedAt: now },
          include: { seat: true, payment: true },
        });
      }

      if (outcome === "fail") {
        await tx.payment.update({
          where: { reservationId },
          data: { status: "FAILED", outcome },
        });
        seatStateChanged = "reservation_failed";
        // Free the seat: a failed payment releases the hold.
        return tx.reservation.update({
          where: { id: reservationId },
          data: { status: "FAILED" },
          include: { seat: true, payment: true },
        });
      }

      // timeout: provider never confirmed; seat stays HELD and is retryable
      // until the hold expires.
      await tx.payment.update({
        where: { reservationId },
        data: { status: "TIMEOUT", outcome },
      });
      return tx.reservation.findUniqueOrThrow({
        where: { id: reservationId },
        include: { seat: true, payment: true },
      });
    });

    if (seatStateChanged) {
      reportSeatChange(seatStateChanged, result.seatId);
    }
    res.json({ reservation: toReservationView(result) });
  }),
);
