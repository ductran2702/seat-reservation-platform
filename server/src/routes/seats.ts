import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { isActive } from "../lib/reservations.js";
import { asyncHandler } from "../middleware/errors.js";
import { optionalAuth } from "../middleware/auth.js";

export const seatsRouter = Router();

// Public listing with live availability. Personalized (`mine`) when logged in.
seatsRouter.get(
  "/",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const now = new Date();
    const seats = await prisma.seat.findMany({
      orderBy: { label: "asc" },
      include: {
        // At most one HELD/CONFIRMED row per seat (partial unique index).
        reservations: { where: { status: { in: ["HELD", "CONFIRMED"] } } },
      },
    });

    const view = seats.map((seat) => {
      const active = seat.reservations.find((r) => isActive(r, now));
      const mine = Boolean(active && req.userId && active.userId === req.userId);
      return {
        id: seat.id,
        label: seat.label,
        status: active ? active.status : "AVAILABLE",
        mine,
        // Only expose the reservation handle/expiry to its owner.
        reservationId: mine ? active!.id : null,
        holdExpiresAt:
          mine && active!.status === "HELD"
            ? active!.holdExpiresAt.toISOString()
            : null,
      };
    });

    res.json({ seats: view });
  }),
);
