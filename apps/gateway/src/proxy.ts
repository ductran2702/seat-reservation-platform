import type { Request, RequestHandler } from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import { INTERNAL_SECRET_HEADER, USER_ID_HEADER } from "@srp/linkz-core";

// Proxies a path prefix to one of the internal services, attaching the
// service-to-service auth headers:
//   - X-Internal-Secret: proves the request came through the gateway
//   - X-User-Id: the identity verified by attachUser (JWT + tokenVersion)
// Incoming copies of these headers are stripped in attachUser so a client can
// never spoof an identity.
export function serviceProxy(
  pathFilter: string | string[],
  target: string,
  internalSecret: string,
): RequestHandler {
  return createProxyMiddleware({
    target,
    changeOrigin: true,
    pathFilter,
    on: {
      proxyReq: (proxyReq, req) => {
        proxyReq.setHeader(INTERNAL_SECRET_HEADER, internalSecret);
        const userId = (req as Request).userId;
        if (userId) {
          proxyReq.setHeader(USER_ID_HEADER, userId);
        }
      },
    },
  });
}
