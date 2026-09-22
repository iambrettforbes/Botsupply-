import assert from "node:assert/strict";
import test from "node:test";
import Stripe from "stripe";
import { buildApp } from "../src/app.js";
import { applyStripeCheckoutCredit, createWallet, openDatabase } from "../src/db.js";
import {
  CENTS_PER_CREDIT,
  checkoutLineItem,
  checkoutUrls,
  createStripeGateway,
  stripeFromEnv,
  type CheckoutSessionInput,
  type StripeGateway,
} from "../src/stripe.js";

const WEBHOOK_SECRET = "whsec_test_botsupply";

function paidEvent(walletId: string, credits: number, sessionId = "cs_test_once") {
  return JSON.stringify({
    id: "evt_test",
    object: "event",
    type: "checkout.session.completed",
    data: {
      object: {
        id: sessionId,
        object: "checkout.session",
        payment_status: "paid",
        metadata: { wallet_id: walletId, credits: String(credits) },
      },
    },
  });
}

function signature(payload: string): string {
  return Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
}

function testGateway(): { gateway: StripeGateway; calls: CheckoutSessionInput[] } {
  const calls: CheckoutSessionInput[] = [];
  const real = createStripeGateway("sk_test_botsupply", WEBHOOK_SECRET);
  return {
    calls,
    gateway: {
      async createCheckoutSession(input) {
        calls.push(input);
        return { id: "cs_test_created", url: "https://checkout.stripe.test/c/cs_test_created" };
      },
      constructEvent(payload, header) {
        return real.constructEvent(payload, header);
      },
    },
  };
}

test("checkout line item is one cent per credit", () => {
  const item = checkoutLineItem(500);
  assert.equal(item.quantity, 500);
  assert.equal(item.price_data?.unit_amount, CENTS_PER_CREDIT);
  assert.equal(item.price_data?.currency, "usd");
  assert.deepEqual(checkoutUrls("https://botsupply.onrender.com/"), {
    successUrl: "https://botsupply.onrender.com/?checkout=success&session_id={CHECKOUT_SESSION_ID}",
    cancelUrl: "https://botsupply.onrender.com/?checkout=cancel",
  });
});

test("stripeFromEnv keeps DEV top-up unless the secret key is set", () => {
  assert.equal(stripeFromEnv({}).devTopupEnabled, true);
  assert.equal(stripeFromEnv({ STRIPE_SECRET_KEY: "  " }).devTopupEnabled, true);
  const partial = stripeFromEnv({ STRIPE_SECRET_KEY: "sk_test_botsupply" });
  assert.equal(partial.devTopupEnabled, false);
  assert.equal(partial.ready, null);
  assert.deepEqual(partial.missing, ["STRIPE_WEBHOOK_SECRET", "PUBLIC_BASE_URL"]);
  const ready = stripeFromEnv({
    STRIPE_SECRET_KEY: "sk_test_botsupply",
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    PUBLIC_BASE_URL: "https://botsupply.onrender.com/",
  });
  assert.equal(ready.devTopupEnabled, false);
  assert.equal(ready.ready?.publicBaseUrl, "https://botsupply.onrender.com");
});

test("applyStripeCheckoutCredit is idempotent on session id", () => {
  const db = openDatabase(":memory:");
  try {
    const { wallet } = createWallet(db, "payer");
    const first = applyStripeCheckoutCredit(db, {
      sessionId: "cs_once",
      walletId: wallet.id,
      credits: 250,
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.applied, true);
    assert.equal(first.balance_credits, 250);

    const replay = applyStripeCheckoutCredit(db, {
      sessionId: "cs_once",
      walletId: wallet.id,
      credits: 100_000,
    });
    assert.equal(replay.ok, true);
    if (!replay.ok) return;
    assert.equal(replay.applied, false);
    assert.equal(replay.credits, 250);
    assert.equal(replay.balance_credits, 250);

    const second = applyStripeCheckoutCredit(db, {
      sessionId: "cs_again",
      walletId: wallet.id,
      credits: 100,
    });
    assert.equal(second.ok && second.applied && second.balance_credits === 350, true);
    assert.equal(applyStripeCheckoutCredit(db, { sessionId: "cs_missing", walletId: "wal_nope", credits: 100 }).ok, false);
  } finally {
    db.close();
  }
});

test("checkout and webhook credit a wallet once, without calling Stripe", async () => {
  const { gateway, calls } = testGateway();
  const app = await buildApp({
    sqlitePath: ":memory:",
    stripe: {
      devTopupEnabled: false,
      missing: [],
      ready: { publicBaseUrl: "https://botsupply.onrender.com", gateway },
    },
  });
  try {
    const created = await app.inject({
      method: "POST",
      url: "/v1/wallets",
      payload: { label: "stripe-agent" },
    });
    const wallet = created.json() as { wallet_id: string; api_key: string };

    const dev = await app.inject({
      method: "POST",
      url: `/v1/wallets/${wallet.wallet_id}/topup`,
      payload: { credits: 500 },
    });
    assert.equal(dev.statusCode, 403);
    assert.equal(dev.json().error.code, "dev_topup_disabled");

    const low = await app.inject({
      method: "POST",
      url: `/v1/wallets/${wallet.wallet_id}/checkout`,
      headers: { authorization: `Bearer ${wallet.api_key}` },
      payload: { credits: 50 },
    });
    assert.equal(low.statusCode, 400);

    const checkout = await app.inject({
      method: "POST",
      url: `/v1/wallets/${wallet.wallet_id}/checkout`,
      headers: { authorization: `Bearer ${wallet.api_key}` },
      payload: { credits: 500 },
    });
    assert.equal(checkout.statusCode, 201, checkout.body);
    assert.equal(checkout.json().url, "https://checkout.stripe.test/c/cs_test_created");
    assert.equal(checkout.json().amount_cents, 500);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.walletId, wallet.wallet_id);
    assert.equal(calls[0]?.credits, 500);
    assert.equal(calls[0]?.successUrl, "https://botsupply.onrender.com/?checkout=success&session_id={CHECKOUT_SESSION_ID}");

    const other = await app.inject({ method: "POST", url: "/v1/wallets", payload: {} });
    const stranger = other.json() as { api_key: string };
    const mismatch = await app.inject({
      method: "POST",
      url: `/v1/wallets/${wallet.wallet_id}/checkout`,
      headers: { authorization: `Bearer ${stranger.api_key}` },
      payload: { credits: 100 },
    });
    assert.equal(mismatch.statusCode, 403);

    const payload = paidEvent(wallet.wallet_id, 500, "cs_test_created");
    const deliver = () =>
      app.inject({
        method: "POST",
        url: "/v1/stripe/webhook",
        headers: {
          "content-type": "application/json",
          "stripe-signature": signature(payload),
        },
        payload,
      });
    const first = await deliver();
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().credited, true);
    assert.equal(first.json().balance_credits, 500);

    const replay = await deliver();
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().credited, false);
    assert.equal(replay.json().balance_credits, 500);

    const bad = await app.inject({
      method: "POST",
      url: "/v1/stripe/webhook",
      headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=nope" },
      payload,
    });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().error.code, "invalid_signature");

    const unpaidPayload = payload.replace('"payment_status":"paid"', '"payment_status":"unpaid"').replace("cs_test_created", "cs_test_unpaid");
    const unpaid = await app.inject({
      method: "POST",
      url: "/v1/stripe/webhook",
      headers: {
        "content-type": "application/json",
        "stripe-signature": signature(unpaidPayload),
      },
      payload: unpaidPayload,
    });
    assert.equal(unpaid.statusCode, 200);
    assert.equal(unpaid.json().credited, false);
    assert.equal(unpaid.json().balance_credits, undefined);
  } finally {
    await app.close();
  }
});

test("checkout is unavailable and DEV top-up still works when Stripe is unset", async () => {
  const app = await buildApp({ sqlitePath: ":memory:" });
  try {
    const created = await app.inject({ method: "POST", url: "/v1/wallets", payload: {} });
    const wallet = created.json() as { wallet_id: string; api_key: string };
    const checkout = await app.inject({
      method: "POST",
      url: `/v1/wallets/${wallet.wallet_id}/checkout`,
      headers: { authorization: `Bearer ${wallet.api_key}` },
      payload: { credits: 100 },
    });
    assert.equal(checkout.statusCode, 503);
    assert.equal(checkout.json().error.code, "stripe_not_configured");
    const topup = await app.inject({
      method: "POST",
      url: `/v1/wallets/${wallet.wallet_id}/topup`,
      payload: { credits: 100 },
    });
    assert.equal(topup.statusCode, 200);
    assert.equal(topup.json().balance_credits, 100);
    assert.match(topup.json().note, /Development top-up/);
  } finally {
    await app.close();
  }
});
