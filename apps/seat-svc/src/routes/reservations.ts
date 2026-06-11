import { Router } from "express";
import { z } from "zod";
import { Prisma, prisma } from "@srp/db";
import {
  ApiError,
  asyncHandler,
  createInternalAuth,
} from "@srp/linkz-core";
import { env } from "../env.js";
import { publishSeatChange } from "../events.js";
import {
  cancelHoldExpiry,
  scheduleHoldExpiry,
} from "../expiryScheduler.js";
import { toReservationView } from "../lib/views.js";

const { requireAuth } = createInternalAuth(env.internalSecret);

export const reservationsRouter = Router();
reservationsRouter.use(requireAuth);

const createSchema = z.object({
  seatId: z.string().min(1),
});

// Client-generated key (UUID) sent in the Idempotency-Key header so retried
// POSTs (double-click, network blip) return the original reservation instead
// of creating a duplicate. Enforced by a UNIQUE constraint in the DB.
const idempotencyKeySchema = z.string().uuid().optional();

reservationsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const { seatId } = createSchema.parse(req.body);
    const idempotencyKey = idempotencyKeySchema.parse(
      req.get("Idempotency-Key") ?? undefined,
    );
    const userId = req.userId!;
    const now = new Date();
    let createdHold = false;

    try {
      const reservation = await prisma.$transaction(async (tx) => {
        // Lazily expire stale holds so counts and the partial unique index
        // reflect reality before we attempt a new hold. The background
        // sweeper (sweeper.ts) handles this on a clock; this remains as a
        // correctness backstop between ticks.
        await tx.reservation.updateMany({
          where: { status: "HELD", holdExpiresAt: { lt: now } },
          data: { status: "EXPIRED" },
        });

        const seat = await tx.seat.findUnique({ where: { id: seatId } });
        if (!seat) {
          throw new ApiError(404, "seat_not_found");
        }

        // Idempotent replay: the same Idempotency-Key always returns the
        // reservation created by the first attempt.
        if (idempotencyKey) {
          const replay = await tx.reservation.findUnique({
            where: { idempotencyKey },
            include: { seat: true, payment: true },
          });
          if (replay) {
            if (replay.userId !== userId) {
              throw new ApiError(409, "idempotency_key_conflict");
            }
            return replay;
          }
        }

        // Idempotent: if this user already actively holds/owns this seat,
        // return that reservation instead of creating a duplicate.
        const existing = await tx.reservation.findFirst({
          where: { seatId, userId, status: { in: ["HELD", "CONFIRMED"] } },
          include: { seat: true, payment: true },
        });
        if (existing) {
          return existing;
        }

        // Best-effort per-user hold limit — CONFIRMED reservations are not
        // holds and do not count (the hard guarantee is the seat-level partial
        // unique index; this count is not lock-serialized).
        const heldCount = await tx.reservation.count({
          where: { userId, status: "HELD" },
        });
        if (heldCount >= env.maxActiveReservationsPerUser) {
          throw new ApiError(
            409,
            "reservation_limit",
            `You can hold at most ${env.maxActiveReservationsPerUser} seats at once`,
          );
        }

        createdHold = true;
        return tx.reservation.create({
          data: {
            seatId,
            userId,
            idempotencyKey,
            status: "HELD",
            holdExpiresAt: new Date(now.getTime() + env.holdTtlSeconds * 1000),
          },
          include: { seat: true, payment: true },
        });
      });

      if (createdHold) {
        // Precise expiry: emit hold_expired the moment the countdown hits 0
        // (the interval sweeper remains as backstop).
        scheduleHoldExpiry(reservation);
        publishSeatChange({ type: "hold_created", seatId });
      }
      res.status(201).json({ reservation: toReservationView(reservation) });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        const target = Array.isArray(err.meta?.target)
          ? err.meta.target.join(",")
          : String(err.meta?.target ?? "");

        // Race on the SAME idempotency key (concurrent retries): return the
        // reservation the winning request created.
        if (idempotencyKey && target.includes("idempotencyKey")) {
          const winner = await prisma.reservation.findUnique({
            where: { idempotencyKey },
            include: { seat: true, payment: true },
          });
          if (winner && winner.userId === userId) {
            res.status(200).json({ reservation: toReservationView(winner) });
            return;
          }
          throw new ApiError(409, "idempotency_key_conflict");
        }

        // Partial unique index violation => another request holds this seat.
        throw new ApiError(409, "seat_unavailable", "Seat is no longer available");
      }
      throw err;
    }
  }),
);

reservationsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const reservation = await prisma.reservation.findUnique({
      where: { id: req.params.id },
      include: { seat: true, payment: true },
    });
    // 404 (not 403) when it isn't the caller's, to avoid leaking existence.
    if (!reservation || reservation.userId !== req.userId) {
      throw new ApiError(404, "reservation_not_found");
    }
    res.json({ reservation: toReservationView(reservation) });
  }),
);

// Voluntarily release a held seat (user backs out before paying).
reservationsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const reservation = await prisma.reservation.findUnique({
      where: { id: req.params.id },
      include: { seat: true, payment: true },
    });
    if (!reservation || reservation.userId !== req.userId) {
      throw new ApiError(404, "reservation_not_found");
    }
    if (reservation.status === "CONFIRMED") {
      throw new ApiError(409, "already_confirmed", "Confirmed seats cannot be cancelled");
    }
    // Only an active hold needs releasing; others are already inactive (idempotent).
    if (reservation.status === "HELD") {
      const updated = await prisma.reservation.update({
        where: { id: reservation.id },
        data: { status: "CANCELLED" },
        include: { seat: true, payment: true },
      });
      cancelHoldExpiry(reservation.id);
      publishSeatChange({ type: "hold_cancelled", seatId: reservation.seatId });
      res.json({ reservation: toReservationView(updated) });
      return;
    }
    res.json({ reservation: toReservationView(reservation) });
  }),
);
