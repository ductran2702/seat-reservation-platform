import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  await prisma.$disconnect();
});

// Registers a throwaway user and returns the access_token cookie header.
async function registerUser(): Promise<string> {
  const email = `race_${randomUUID()}@test.local`;
  const res = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password123", name: "Race" }),
  });
  expect(res.status).toBe(201);
  const setCookies = res.headers.getSetCookie();
  const access = setCookies.find((c) => c.startsWith("access_token="));
  expect(access, "register should set an access_token cookie").toBeTruthy();
  return access!.split(";")[0];
}

describe("seat hold concurrency", () => {
  it("two concurrent holds on the same seat → only one wins", async () => {
    // Dedicated seat so the test is isolated from seeded/demo data.
    const seat = await prisma.seat.create({
      data: { label: `RACE-${randomUUID().slice(0, 8)}` },
    });

    try {
      const [cookieA, cookieB] = await Promise.all([
        registerUser(),
        registerUser(),
      ]);

      const hold = (cookie: string) =>
        fetch(`${baseUrl}/api/reservations`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: cookie },
          body: JSON.stringify({ seatId: seat.id }),
        });

      // Fire both holds simultaneously.
      const [resA, resB] = await Promise.all([hold(cookieA), hold(cookieB)]);
      const statuses = [resA.status, resB.status].sort();

      // Exactly one winner (201 Created) and one loser (409 Conflict).
      expect(statuses).toEqual([201, 409]);

      const loser = resA.status === 409 ? resA : resB;
      const loserBody = await loser.json();
      expect(loserBody.error).toBe("seat_unavailable");

      // The DB invariant: at most one active reservation for the seat.
      const active = await prisma.reservation.count({
        where: { seatId: seat.id, status: { in: ["HELD", "CONFIRMED"] } },
      });
      expect(active).toBe(1);
    } finally {
      await prisma.reservation.deleteMany({ where: { seatId: seat.id } });
      await prisma.seat.delete({ where: { id: seat.id } });
    }
  });
});
