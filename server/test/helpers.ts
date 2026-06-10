import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { expect } from "vitest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";

let server: Server;
let baseUrl = "";

export async function startTestServer(): Promise<string> {
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  return baseUrl;
}

export async function stopTestServer(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  await prisma.$disconnect();
}

export function url(path: string): string {
  return `${baseUrl}${path}`;
}

/** Registers a throwaway user and returns the access_token cookie header. */
export async function registerUser(
  name = "Test",
): Promise<{ cookie: string; email: string }> {
  const email = `test_${randomUUID()}@test.local`;
  const res = await fetch(url("/api/auth/register"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password123", name }),
  });
  expect(res.status).toBe(201);
  const setCookies = res.headers.getSetCookie();
  const access = setCookies.find((c) => c.startsWith("access_token="));
  expect(access).toBeTruthy();
  return { cookie: access!.split(";")[0], email };
}

export async function createTestSeat(): Promise<{ id: string; label: string }> {
  return prisma.seat.create({
    data: { label: `T-${randomUUID().slice(0, 8)}` },
  });
}

export async function holdSeat(
  cookie: string,
  seatId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url("/api/reservations"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ seatId }),
  });
  return { status: res.status, body: await res.json() };
}

export async function cleanupSeat(seatId: string): Promise<void> {
  const reservations = await prisma.reservation.findMany({
    where: { seatId },
    select: { id: true },
  });
  const ids = reservations.map((r) => r.id);
  if (ids.length > 0) {
    await prisma.payment.deleteMany({
      where: { reservationId: { in: ids } },
    });
    await prisma.reservation.deleteMany({ where: { seatId } });
  }
  await prisma.seat.delete({ where: { id: seatId } }).catch(() => undefined);
}
