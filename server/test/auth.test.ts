import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, stopTestServer, url } from "./helpers.js";

beforeAll(startTestServer);
afterAll(stopTestServer);

/** Registers a throwaway user and returns its refresh_token cookie. */
async function registerWithRefresh(): Promise<string> {
  const res = await fetch(url("/api/auth/register"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `auth_${randomUUID()}@test.local`,
      password: "password123",
      name: "Auth Test",
    }),
  });
  expect(res.status).toBe(201);
  const refresh = res.headers
    .getSetCookie()
    .find((c) => c.startsWith("refresh_token="));
  expect(refresh).toBeTruthy();
  return refresh!.split(";")[0];
}

function refresh(cookie: string): Promise<Response> {
  return fetch(url("/api/auth/refresh"), {
    method: "POST",
    headers: { Cookie: cookie },
  });
}

describe("auth session lifecycle", () => {
  it("refresh after logout is rejected (server-side revocation)", async () => {
    const refreshCookie = await registerWithRefresh();

    const out = await fetch(url("/api/auth/logout"), {
      method: "POST",
      headers: { Cookie: refreshCookie },
    });
    expect(out.status).toBe(200);

    // Clearing the cookie is not enough — a stolen copy must be dead too.
    const replay = await refresh(refreshCookie);
    expect(replay.status).toBe(401);
  });

  it("rotation revokes the old token; reuse burns the whole session family", async () => {
    const refreshCookie = await registerWithRefresh();

    const first = await refresh(refreshCookie);
    expect(first.status).toBe(200);
    const rotated = first.headers
      .getSetCookie()
      .find((c) => c.startsWith("refresh_token="))!
      .split(";")[0];
    expect(rotated).not.toBe(refreshCookie);

    // Presenting the rotated-out token again is treated as theft...
    const reuse = await refresh(refreshCookie);
    expect(reuse.status).toBe(401);
    expect((await reuse.json()).error).toBe("refresh_token_reused");

    // ...and every session of the user is revoked, including the fresh one.
    const burned = await refresh(rotated);
    expect(burned.status).toBe(401);
  });

  it("two concurrent refreshes with the same token → only one wins", async () => {
    const refreshCookie = await registerWithRefresh();

    const [a, b] = await Promise.all([
      refresh(refreshCookie),
      refresh(refreshCookie),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 401]);
  });
});
