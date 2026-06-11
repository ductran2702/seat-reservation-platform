import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@srp/db";
import {
  cleanupSeat,
  createTestSeat,
  registerUser,
  startTestServer,
  stopTestServer,
  url,
} from "./helpers.js";

beforeAll(startTestServer);
afterAll(stopTestServer);

describe("seat hold concurrency", () => {
  it("two concurrent holds on the same seat → only one wins", async () => {
    const seat = await createTestSeat();

    try {
      const [{ cookie: cookieA }, { cookie: cookieB }] = await Promise.all([
        registerUser("A"),
        registerUser("B"),
      ]);

      const hold = (cookie: string) =>
        fetch(url("/api/reservations"), {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: cookie },
          body: JSON.stringify({ seatId: seat.id }),
        });

      const [resA, resB] = await Promise.all([hold(cookieA), hold(cookieB)]);
      const statuses = [resA.status, resB.status].sort();

      expect(statuses).toEqual([201, 409]);

      const loser = resA.status === 409 ? resA : resB;
      const loserBody = (await loser.json()) as { error: string };
      expect(loserBody.error).toBe("seat_unavailable");

      const active = await prisma.reservation.count({
        where: { seatId: seat.id, status: { in: ["HELD", "CONFIRMED"] } },
      });
      expect(active).toBe(1);
    } finally {
      await cleanupSeat(seat.id);
    }
  });
});
