/**
 * Polymarket CLOB trading core — the authenticated, real-funds layer.
 *
 * This module owns the trading wallet and is the only place that signs and
 * submits live orders. It uses @polymarket/clob-client-v2, which signs orders
 * against the CTF Exchange V2 and settles in pUSD (the collateral token used
 * for all trading post the 2026-04-28 migration). The legacy v1 SDK signed
 * against the old exchange/USDC.e and is rejected for pUSD-funded accounts.
 *
 * Auth mirrors scripts/check-balance-sdk.mjs and the official quickstart:
 *   - L1: the wallet PRIVATE KEY signs the EIP-712 ClobAuth struct via
 *     createOrDeriveApiKey(), yielding deterministic L2 API creds.
 *   - L2: those creds (HMAC) authenticate /order; the SDK handles both.
 * The ethers v6 wallet is wrapped in a v5-shaped signer ({ _signTypedData })
 * because the SDK detects ethers signers by the v5 method name.
 *
 * signature_type / funder follow the account: 0 = EOA (signer is the funder),
 * 1 = email/magic proxy, 2 = browser-wallet proxy (funder is the proxy that
 * holds collateral). For a proxy the funder address is REQUIRED — orders pull
 * collateral from it.
 *
 * Collateral allowances (Exchange V2 spend of pUSD) must already be set for the
 * funder; trading on polymarket.com once does this. We do not auto-approve — a
 * missing allowance surfaces as an order error.
 */
import { Wallet } from "ethers";
import { ClobClient, Chain, OrderType, Side, AssetType } from "@polymarket/clob-client-v2";

const DEFAULT_CLOB = "https://clob.polymarket.com";

const ts = () => new Date().toISOString();
const log = (msg) => console.log(`[order-service] ${ts()} ${msg}`);
const logErr = (msg) => console.error(`[order-service] ${ts()} ${msg}`);
/** JSON that won't throw on circular refs and is truncated to keep logs sane. */
function safeJson(v) {
  try {
    const s = JSON.stringify(v);
    return s.length > 2000 ? `${s.slice(0, 2000)}…` : s;
  } catch {
    return String(v);
  }
}

function readConfig() {
  const privateKey = process.env.POLYMARKET_WALLET_PRIVATE_KEY;
  if (!privateKey) return null;
  const signatureType = Number(process.env.POLYMARKET_SIGNATURE_TYPE ?? "0");
  const funder = process.env.POLYMARKET_ADDRESS || null;
  // A proxy account routes collateral through its funder; without it a signed
  // order has no account to draw from, so treat it as unconfigured.
  if (signatureType !== 0 && !funder) return null;
  return {
    clobUrl: (process.env.POLYMARKET_CLOB_URL || DEFAULT_CLOB).replace(/\/$/, ""),
    privateKey,
    signatureType,
    funder,
  };
}

/** Whether the wallet credentials needed to trade are present. */
export function configured() {
  return readConfig() !== null;
}

let cache = null; // { client, signerAddress, funder, signatureType }

async function getClient() {
  const cfg = readConfig();
  if (!cfg) {
    throw new Error(
      "order-service not configured: set POLYMARKET_WALLET_PRIVATE_KEY (+ POLYMARKET_ADDRESS for proxy accounts)",
    );
  }
  if (cache) return cache;

  const wallet = new Wallet(cfg.privateKey);
  // ethers v6 renamed _signTypedData -> signTypedData; the SDK sniffs for the v5
  // name, so present a v5-shaped adapter over the v6 wallet.
  const signer = {
    address: wallet.address,
    getAddress: async () => wallet.address,
    _signTypedData: (domain, types, value) => wallet.signTypedData(domain, types, value),
  };
  const funder = cfg.funder ?? undefined;

  // v2 uses an options-object constructor and SignatureTypeV2 (0=EOA,
  // 1=POLY_PROXY, 2=POLY_GNOSIS_SAFE, 3=POLY_1271). The numeric values match
  // the legacy enum, so the configured POLYMARKET_SIGNATURE_TYPE carries over.
  const base = {
    host: cfg.clobUrl,
    chain: Chain.POLYGON,
    signer,
    signatureType: cfg.signatureType,
    funderAddress: funder,
  };
  const bootstrap = new ClobClient(base);
  const creds = await bootstrap.createOrDeriveApiKey();
  const client = new ClobClient({ ...base, creds });

  cache = {
    client,
    signerAddress: wallet.address,
    funder: cfg.funder,
    signatureType: cfg.signatureType,
  };
  return cache;
}

/** Non-secret identity for /health — never returns the key or API secret. */
export function identity() {
  const cfg = readConfig();
  if (!cfg) return { configured: false };
  const wallet = new Wallet(cfg.privateKey);
  return {
    configured: true,
    signerAddress: wallet.address,
    funder: cfg.funder,
    signatureType: cfg.signatureType,
    clobUrl: cfg.clobUrl,
  };
}

function clampPrice(p) {
  if (!Number.isFinite(p)) throw new Error(`invalid price: ${p}`);
  return Math.min(0.999, Math.max(0.001, p));
}

/**
 * Submit a marketable BUY for `size` shares of `tokenId`, fill-and-kill at
 * `price` (caller has already added its slippage cap). FAK sweeps the book up to
 * the limit and cancels any unfilled remainder, so nothing rests on a market
 * that closes in minutes. Returns the fill (possibly partial). Throws on a
 * hard failure so the HTTP layer can surface a 502.
 */
export async function placeBuyOrder({ tokenId, price, size }) {
  if (!tokenId) throw new Error("tokenId required");
  if (!Number.isFinite(size) || size <= 0) throw new Error(`invalid size: ${size}`);
  const limitPrice = clampPrice(price);
  const { client } = await getClient();
  // Logs go to stdout/stderr so `docker compose logs order-service` shows the
  // full order flow. Only order params/results are logged — never keys or creds.
  log(`BUY token=${tokenId} price=${limitPrice} size=${size}`);
  try {
    const order = await client.createOrder({
      tokenID: tokenId,
      price: limitPrice,
      size,
      side: Side.BUY,
    });
    const resp = await client.postOrder(order, OrderType.FAK);
    // A BUY fill credits outcome tokens: takingAmount = shares received.
    const filled = Number(resp?.takingAmount);
    const success = Boolean(resp?.success);
    if (success) {
      log(`FILLED id=${resp?.orderID} status=${resp?.status} shares=${filled} spent=${resp?.makingAmount}`);
    } else {
      // The real reason from the CLOB is the whole point of these logs — dump it.
      logErr(`REJECTED token=${tokenId}: ${resp?.errorMsg || "(no errorMsg)"} | resp=${safeJson(resp)}`);
    }
    return {
      ok: success,
      orderId: resp?.orderID ?? null,
      status: resp?.status ?? null,
      filledShares: Number.isFinite(filled) ? filled : null,
      makingAmount: resp?.makingAmount ?? null,
      error: success ? undefined : resp?.errorMsg || "order rejected",
    };
  } catch (err) {
    // Drop the cached client so the next attempt re-derives creds (e.g. after a
    // key rotation or auth expiry).
    cache = null;
    // Surface the underlying HTTP/SDK error body when present (axios-style).
    const detail = err?.response?.data ? ` | body=${safeJson(err.response.data)}` : "";
    logErr(`ERROR token=${tokenId}: ${err?.message ?? err}${detail}`);
    throw err;
  }
}

/** Live collateral balance in USD (pUSD/USDC, 6 decimals). */
export async function balanceUsd() {
  const { client } = await getClient();
  const c = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  const raw = Number(c?.balance ?? 0);
  return Number.isFinite(raw) ? raw / 1e6 : null;
}

/** Currently open orders on the account. */
export async function openOrders() {
  const { client } = await getClient();
  return client.getOpenOrders();
}

/** Cancel a single order by id. */
export async function cancelOrder(orderId) {
  const { client } = await getClient();
  return client.cancelOrder({ orderID: orderId });
}

/** Cancel every open order (panic button / shutdown). */
export async function cancelAll() {
  const { client } = await getClient();
  return client.cancelAll();
}
