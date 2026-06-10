import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import {
  cleanupSeat,
  createTestSeat,
  holdSeat,
  registerUser,
  startTestServer,
  stopTestServer,
  url,
} from "./helpers.js";

beforeAll(startTestServer);
afterAll(stopTestServer);

describe("payment failure paths", () => {
  it("confirm?outcome=fail → reservation FAILED, seat bookable again", async () => {
    const seat = await createTestSeat();
    const { cookie } = await registerUser();

    try {
      const hold = await holdSeat(cookie, seat.id);
      expect(hold.status).toBe(201);
      const reservationId = (hold.body.reservation as { id: string }).id;

      await fetch(url(`/api/payments/${reservationId}/intent`), {
        method: "POST",
        headers: { Cookie: cookie },
      });

      const confirm = await fetch(
        url(`/api/payments/${reservationId}/confirm?outcome=fail`),
        { method: "POST", headers: { Cookie: cookie } },
      );
      expect(confirm.status).toBe(200);
      const body = await confirm.json();
      expect(body.reservation.status).toBe("FAILED");

      const active = await prisma.reservation.count({
        where: { seatId: seat.id, status: { in: ["HELD", "CONFIRMED"] } },
      });
      expect(active).toBe(0);

      // Another user can now hold the seat.
      const { cookie: other } = await registerUser("Other");
      const retry = await holdSeat(other, seat.id);
      expect(retry.status).toBe(201);
    } finally {
      await cleanupSeat(seat.id);
    }
  });

  it("confirm?outcome=timeout stays HELD; retry with success confirms", async () => {
    const seat = await createTestSeat();
    const { cookie } = await registerUser();

    try {
      const hold = await holdSeat(cookie, seat.id);
      const reservationId = (hold.body.reservation as { id: string }).id;

      await fetch(url(`/api/payments/${reservationId}/intent`), {
        method: "POST",
        headers: { Cookie: cookie },
      });

      const timeout = await fetch(
        url(`/api/payments/${reservationId}/confirm?outcome=timeout`),
        { method: "POST", headers: { Cookie: cookie } },
      );
      expect(timeout.status).toBe(200);
      expect((await timeout.json()).reservation.status).toBe("HELD");

      const success = await fetch(
        url(`/api/payments/${reservationId}/confirm?outcome=success`),
        { method: "POST", headers: { Cookie: cookie } },
      );
      expect(success.status).toBe(200);
      expect((await success.json()).reservation.status).toBe("CONFIRMED");
    } finally {
      await cleanupSeat(seat.id);
    }
  });

  it("intent on an expired hold → 409 hold_expired", async () => {
    const seat = await createTestSeat();
    const { cookie } = await registerUser();

    try {
      const hold = await holdSeat(cookie, seat.id);
      const reservationId = (hold.body.reservation as { id: string }).id;

      await prisma.reservation.update({
        where: { id: reservationId },
        data: { holdExpiresAt: new Date(Date.now() - 60_000) },
      });

      const intent = await fetch(url(`/api/payments/${reservationId}/intent`), {
        method: "POST",
        headers: { Cookie: cookie },
      });
      expect(intent.status).toBe(409);
      expect((await intent.json()).error).toBe("hold_expired");
    } finally {
      await cleanupSeat(seat.id);
    }
  });
});

describe("hold lifecycle", () => {
  it("DELETE cancels a HELD reservation and frees the seat", async () => {
    const seat = await createTestSeat();
    const { cookie } = await registerUser();

    try {
      const hold = await holdSeat(cookie, seat.id);
      const reservationId = (hold.body.reservation as { id: string }).id;

      const del = await fetch(url(`/api/reservations/${reservationId}`), {
        method: "DELETE",
        headers: { Cookie: cookie },
      });
      expect(del.status).toBe(200);
      expect((await del.json()).reservation.status).toBe("CANCELLED");

      const active = await prisma.reservation.count({
        where: { seatId: seat.id, status: { in: ["HELD", "CONFIRMED"] } },
      });
      expect(active).toBe(0);
    } finally {
      await cleanupSeat(seat.id);
    }
  });

  it("CONFIRMED seats do not count toward the per-user hold limit", async () => {
    const [s1, s2, s3] = await Promise.all([
      createTestSeat(),
      createTestSeat(),
      createTestSeat(),
    ]);
    const { cookie } = await registerUser();

    try {
      const h1 = await holdSeat(cookie, s1.id);
      const r1 = (h1.body.reservation as { id: string }).id;
      await fetch(url(`/api/payments/${r1}/intent`), {
        method: "POST",
        headers: { Cookie: cookie },
      });
      await fetch(url(`/api/payments/${r1}/confirm?outcome=success`), {
        method: "POST",
        headers: { Cookie: cookie },
      });

      const h2 = await holdSeat(cookie, s2.id);
      const h3 = await holdSeat(cookie, s3.id);
      expect(h2.status).toBe(201);
      expect(h3.status).toBe(201);
    } finally {
      await Promise.all([s1, s2, s3].map((s) => cleanupSeat(s.id)));
    }
  });

  it("third simultaneous hold for same user → 409 reservation_limit", async () => {
    const [s1, s2, s3] = await Promise.all([
      createTestSeat(),
      createTestSeat(),
      createTestSeat(),
    ]);
    const { cookie } = await registerUser();

    try {
      expect((await holdSeat(cookie, s1.id)).status).toBe(201);
      expect((await holdSeat(cookie, s2.id)).status).toBe(201);

      const third = await holdSeat(cookie, s3.id);
      expect(third.status).toBe(409);
      expect(third.body.error).toBe("reservation_limit");
    } finally {
      await Promise.all([s1, s2, s3].map((s) => cleanupSeat(s.id)));
    }
  });
});
