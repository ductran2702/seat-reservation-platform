import { Router } from "express";
import { z } from "zod";
import { prisma } from "@srp/db";
import { ApiError, asyncHandler, createInternalAuth } from "@srp/linkz-core";
import { env } from "../env.js";
import { toPaymentView, toReservationView } from "../lib/views.js";

const { requireAuth } = createInternalAuth(env.internalSecret);

export const paymentsRouter = Router();
paymentsRouter.use(requireAuth);

const outcomeSchema = z.enum(["success", "fail", "timeout"]);

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
        // Transactional outbox (Pattern B): the seat_change event commits in
        // the SAME transaction as the state flip — a crash can never confirm
        // a payment without enqueueing its event. The outbox worker delivers
        // it to seat-svc (cache invalidation + SSE) at-least-once.
        await tx.outboxEvent.create({
          data: {
            type: "reservation_confirmed",
            payload: { seatId: reservation.seatId, reservationId },
          },
        });
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
        await tx.outboxEvent.create({
          data: {
            type: "reservation_failed",
            payload: { seatId: reservation.seatId, reservationId },
          },
        });
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

    // Payment metrics: structured JSON with an `action` field so a log
    // aggregator can alert on a payment_failure spike.
    if (outcome === "success") {
      console.log(
        JSON.stringify({
          action: "payment_success",
          reservationId,
          userId,
          amountCents: result.payment?.amountCents ?? null,
        }),
      );
    } else {
      console.log(
        JSON.stringify({
          action: "payment_failure",
          reservationId,
          userId,
          outcome,
        }),
      );
    }

    res.json({ reservation: toReservationView(result) });
  }),
);
