import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { env } from "../lib/env.js";
import { toReservationView } from "../lib/reservations.js";
import { ApiError, asyncHandler } from "../middleware/errors.js";
import { requireAuth } from "../middleware/auth.js";

export const reservationsRouter = Router();
reservationsRouter.use(requireAuth);

const createSchema = z.object({
  seatId: z.string().min(1),
});

reservationsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const { seatId } = createSchema.parse(req.body);
    const userId = req.userId!;
    const now = new Date();

    try {
      const reservation = await prisma.$transaction(async (tx) => {
        // Lazily expire stale holds so counts and the partial unique index
        // reflect reality before we attempt a new hold.
        await tx.reservation.updateMany({
          where: { status: "HELD", holdExpiresAt: { lt: now } },
          data: { status: "EXPIRED" },
        });

        const seat = await tx.seat.findUnique({ where: { id: seatId } });
        if (!seat) {
          throw new ApiError(404, "seat_not_found");
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

        // Best-effort per-user limit (the hard guarantee is the seat-level
        // partial unique index; this count is not lock-serialized).
        const activeCount = await tx.reservation.count({
          where: { userId, status: { in: ["HELD", "CONFIRMED"] } },
        });
        if (activeCount >= env.maxActiveReservationsPerUser) {
          throw new ApiError(
            409,
            "reservation_limit",
            `You can hold at most ${env.maxActiveReservationsPerUser} seats at once`,
          );
        }

        return tx.reservation.create({
          data: {
            seatId,
            userId,
            status: "HELD",
            holdExpiresAt: new Date(now.getTime() + env.holdTtlSeconds * 1000),
          },
          include: { seat: true, payment: true },
        });
      });

      res.status(201).json({ reservation: toReservationView(reservation) });
    } catch (err) {
      // Partial unique index violation => another request holds this seat.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
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
