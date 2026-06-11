import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Express } from "express";
import { expect } from "vitest";
import { prisma } from "@srp/db";
import { createApp as createAuthApp } from "../../apps/auth-svc/src/app.js";
import { createApp as createSeatApp } from "../../apps/seat-svc/src/app.js";
import { createApp as createPaymentApp } from "../../apps/payment-svc/src/app.js";
import { createApp as createGatewayApp } from "../../apps/gateway/src/app.js";

// Must match the services' env default so gateway → service calls are trusted.
const INTERNAL_SECRET = process.env.INTERNAL_SECRET ?? "dev_internal_secret";

let servers: Server[] = [];
let baseUrl = "";

async function listen(app: Express): Promise<{ server: Server; url: string }> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}` };
}

// Boots the full service topology in-process — auth, seat, and payment on
// ephemeral ports, fronted by a gateway wired to them. Tests exercise the
// real proxy/auth-header path exactly like production traffic.
export async function startTestServer(): Promise<string> {
  const auth = await listen(createAuthApp());
  const seat = await listen(createSeatApp());
  const payment = await listen(createPaymentApp());
  const gateway = await listen(
    createGatewayApp({
      authSvcUrl: auth.url,
      seatSvcUrl: seat.url,
      paymentSvcUrl: payment.url,
      internalSecret: INTERNAL_SECRET,
    }),
  );
  servers = [gateway.server, auth.server, seat.server, payment.server];
  baseUrl = gateway.url;
  return baseUrl;
}

export async function stopTestServer(): Promise<void> {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
          // Keep-alive sockets (client → gateway, gateway proxy → services)
          // would otherwise hold close() open.
          server.closeIdleConnections();
          setTimeout(() => server.closeAllConnections(), 1_000).unref();
        }),
    ),
  );
  servers = [];
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
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
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
