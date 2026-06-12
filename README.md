# Polymarket order-execution service

A standalone microservice whose **only** job is to sign and submit authenticated
Polymarket CLOB orders. It holds the trading wallet key; the crypto-predictor
dashboard never does. The dashboard calls this service over HTTP when live
trading is toggled on.

It is meant to run on a **dedicated, locked-down host** (or its own container on
an internal network) — keep the wallet key off the dashboard box.

## Why a separate service

- **Blast-radius isolation.** Only this host can move funds. Compromising the
  dashboard (public-facing) doesn't expose the key.
- **One signer.** A single place builds, signs, and posts orders, so auth,
  allowances, and rate limits live in one spot.
- **Deploy independently.** The dashboard redeploys without touching the signer.

## Endpoints

All endpoints except `/health` require `Authorization: Bearer $ORDER_SERVICE_TOKEN`.

| Method | Path           | Purpose |
|--------|----------------|---------|
| GET    | `/health`      | Liveness + whether the wallet/token are configured (no secrets). |
| GET    | `/balance`     | Collateral balance in USD. |
| POST   | `/orders`      | Place a marketable BUY (fill-and-kill). Body: `{ tokenId, price, size }`. |
| GET    | `/orders`      | List open orders. |
| DELETE | `/orders/:id`  | Cancel one order. |
| POST   | `/cancel-all`  | Cancel every open order. |

`POST /orders` returns `{ ok, orderId, status, filledShares, makingAmount, error? }`.
`price` is the **marketable limit** (entry price + the caller's slippage cap); FAK
fills against the book up to that price and cancels any remainder, so nothing
rests on a market that closes in minutes.

## Configuration

Copy `.env.example` to `.env` and fill it in (see that file for details):

- `ORDER_SERVICE_TOKEN` — shared bearer secret; must match the dashboard.
- `POLYMARKET_WALLET_PRIVATE_KEY`, `POLYMARKET_ADDRESS`,
  `POLYMARKET_SIGNATURE_TYPE`, `POLYMARKET_CLOB_URL` — the trading account.

Collateral **allowances** (Exchange + NegRiskExchange spend of pUSD/USDC) must
already be set for the funder. Trading on polymarket.com once does this; the
service does not auto-approve and will surface a missing allowance as an order
error.

## Run

```bash
cp .env.example .env && $EDITOR .env   # set ORDER_SERVICE_TOKEN + wallet creds

# Docker Compose (recommended — for the dedicated order host)
docker compose up -d --build           # listens on :8070

# …or plain Docker
docker build -t pm-order-service .
docker run --env-file .env -p 8070:8070 pm-order-service

# …or Node directly
npm install && npm start
```

`docker-compose.yml` binds the port to all interfaces by default (guarded by the
bearer token). Set `ORDER_SERVICE_BIND` in `.env` to pin it to a private/VPN IP,
and `ORDER_SERVICE_PORT` to change the published port.

Smoke test:

```bash
curl -s localhost:8070/health | jq
curl -s localhost:8070/balance -H "Authorization: Bearer $ORDER_SERVICE_TOKEN" | jq
```
