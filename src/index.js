/**
 * Polymarket order-execution microservice — HTTP entrypoint.
 *
 * The crypto-predictor dashboard's engine calls this service whenever live
 * trading is on; it is the only component that signs and submits real CLOB
 * orders, so it is meant to run on a dedicated, locked-down host with the
 * trading wallet key in its environment and nothing else.
 *
 * Endpoints (all except /health require `Authorization: Bearer <ORDER_SERVICE_TOKEN>`):
 *   GET  /health        -> { ok, configured, signerAddress?, funder?, signatureType? }
 *   GET  /balance       -> { balanceUsd }
 *   POST /orders        -> body { tokenId, price, size } (marketable BUY, FAK)
 *                          -> { ok, orderId, status, filledShares, makingAmount, error? }
 *   GET  /orders        -> open orders
 *   DELETE /orders/:id  -> cancel one order
 *   POST /cancel-all    -> cancel every open order
 *
 * Auth: ORDER_SERVICE_TOKEN is REQUIRED for the mutating/account endpoints. The
 * service still boots without it (so /health works and misconfig is visible),
 * but every authed route returns 503 until a token is set — this thing moves
 * real money, so it never operates wide-open by accident.
 */
import "dotenv/config";
import http from "http";
import {
  configured,
  identity,
  placeBuyOrder,
  balanceUsd,
  openOrders,
  cancelOrder,
  cancelAll,
} from "./trader.js";

const PORT = Number(process.env.PORT ?? 8070);
const TOKEN = process.env.ORDER_SERVICE_TOKEN || "";

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1_000_000) req.destroy(); // 1MB guard
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve(null); // signal malformed body
      }
    });
    req.on("error", () => resolve(null));
  });
}

/** Constant-time-ish bearer check. Returns null on success, or an error tuple. */
function authError(req) {
  if (!TOKEN) return [503, "ORDER_SERVICE_TOKEN not set — refusing to operate"];
  const header = req.headers["authorization"] || "";
  const expected = `Bearer ${TOKEN}`;
  if (header.length !== expected.length || header !== expected) return [401, "unauthorized"];
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = req.url ?? "/";
  const path = url.split("?")[0];
  const method = req.method ?? "GET";

  try {
    // Health is public so orchestrators and the dashboard can probe reachability
    // and configuration without holding the trading token.
    if (path === "/health" && method === "GET") {
      const id = identity();
      return json(res, 200, {
        ok: true,
        configured: configured(),
        tokenSet: Boolean(TOKEN),
        signerAddress: id.signerAddress ?? null,
        funder: id.funder ?? null,
        signatureType: id.signatureType ?? null,
        serverTime: new Date().toISOString(),
      });
    }

    // Everything below is authenticated.
    const auth = authError(req);
    if (auth) return json(res, auth[0], { error: auth[1] });

    if (path === "/balance" && method === "GET") {
      const balanceUsdValue = await balanceUsd();
      return json(res, 200, { balanceUsd: balanceUsdValue });
    }

    if (path === "/orders" && method === "POST") {
      const body = await readJsonBody(req);
      if (!body) return json(res, 400, { error: "malformed JSON body" });
      const { tokenId, price, size } = body;
      if (!tokenId || typeof price !== "number" || typeof size !== "number") {
        return json(res, 400, { error: "tokenId (string), price (number), size (number) required" });
      }
      try {
        const result = await placeBuyOrder({ tokenId, price, size });
        return json(res, result.ok ? 200 : 502, result);
      } catch (err) {
        return json(res, 502, { ok: false, error: String(err?.message ?? err) });
      }
    }

    if (path === "/orders" && method === "GET") {
      return json(res, 200, { orders: await openOrders() });
    }

    if (path.startsWith("/orders/") && method === "DELETE") {
      const id = decodeURIComponent(path.slice("/orders/".length));
      if (!id) return json(res, 400, { error: "order id required" });
      return json(res, 200, await cancelOrder(id));
    }

    if (path === "/cancel-all" && method === "POST") {
      return json(res, 200, await cancelAll());
    }

    return json(res, 404, { error: "not found", path });
  } catch (err) {
    return json(res, 500, { error: String(err?.message ?? err) });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  const id = identity();
  console.log(
    `[order-service] listening on :${PORT} — configured=${configured()} tokenSet=${Boolean(TOKEN)} signer=${id.signerAddress ?? "none"}`,
  );
  if (!TOKEN) {
    console.warn("[order-service] WARNING: ORDER_SERVICE_TOKEN is not set; authed endpoints will return 503.");
  }
});

process.on("SIGINT", () => server.close(() => process.exit(0)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
