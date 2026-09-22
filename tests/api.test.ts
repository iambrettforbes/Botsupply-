import assert from "node:assert/strict";
import test from "node:test";
import { CREDIT_VALUE_USD, PRODUCTS } from "../src/catalog.js";
import { buildApp } from "../src/app.js";
import { resolveSqlitePath } from "../src/paths.js";

const PRICES: Record<string, number> = {
  "pack.competitor-snapshot": 50,
  "pack.venue-hours": 20,
  "recipe.book-table": 100,
};

async function createWallet(app: Awaited<ReturnType<typeof buildApp>>, label = "test-agent") {
  const response = await app.inject({
    method: "POST",
    url: "/v1/wallets",
    payload: { label },
  });
  assert.equal(response.statusCode, 201);
  const body = response.json() as {
    wallet_id: string;
    api_key: string;
    balance_credits: number;
  };
  assert.match(body.wallet_id, /^wal_[0-9a-f]+$/);
  assert.match(body.api_key, /^bsk_[0-9a-f]+$/);
  assert.equal(body.balance_credits, 0);
  return body;
}

test("health, landing page, and catalog", async () => {
  const app = await buildApp({ sqlitePath: ":memory:" });
  try {
    const health = await app.inject({ method: "GET", url: "/health" });
    assert.equal(health.statusCode, 200);
    assert.deepEqual(health.json(), { status: "ok", service: "botsupply" });

    const home = await app.inject({ method: "GET", url: "/" });
    assert.equal(home.statusCode, 200);
    assert.match(home.headers["content-type"] ?? "", /text\/html/);
    assert.match(home.body, /BotSupply/);
    assert.match(home.body, /Wholesale for/);
    assert.match(home.body, /AI agents/);
    for (const product of PRODUCTS) {
      assert.match(home.body, new RegExp(product.sku.replace(".", "\\.")));
    }

    const catalog = await app.inject({ method: "GET", url: "/v1/catalog" });
    assert.equal(catalog.statusCode, 200);
    const doc = catalog.json() as {
      credit_value_usd: number;
      products: Array<{ sku: string; price_credits: number; payload?: unknown }>;
    };
    assert.equal(doc.credit_value_usd, CREDIT_VALUE_USD);
    assert.equal(doc.products.length, 3);
    for (const product of doc.products) {
      assert.equal(product.price_credits, PRICES[product.sku]);
      assert.equal(product.payload, undefined);
    }
  } finally {
    await app.close();
  }
});

test("wallet, topup, buy each SKU, and credit deduction", async () => {
  const app = await buildApp({ sqlitePath: ":memory:" });
  try {
    const wallet = await createWallet(app);
    const topup = await app.inject({
      method: "POST",
      url: `/v1/wallets/${wallet.wallet_id}/topup`,
      payload: { credits: 500 },
    });
    assert.equal(topup.statusCode, 200);
    assert.deepEqual(
      {
        wallet_id: topup.json().wallet_id,
        credited: topup.json().credited,
        balance_credits: topup.json().balance_credits,
      },
      { wallet_id: wallet.wallet_id, credited: 500, balance_credits: 500 },
    );

    let expected = 500;
    const purchaseIds: string[] = [];
    for (const sku of Object.keys(PRICES)) {
      const bought = await app.inject({
        method: "POST",
        url: "/v1/purchase",
        headers: { authorization: `Bearer ${wallet.api_key}` },
        payload: { sku },
      });
      assert.equal(bought.statusCode, 201, bought.body);
      const body = bought.json() as {
        purchase_id: string;
        sku: string;
        credits_charged: number;
        balance_credits: number;
        payload: Record<string, unknown>;
      };
      expected -= PRICES[sku]!;
      assert.equal(body.sku, sku);
      assert.equal(body.credits_charged, PRICES[sku]);
      assert.equal(body.balance_credits, expected);
      assert.equal(typeof body.payload, "object");
      if (sku === "pack.competitor-snapshot") {
        assert.equal(body.payload.pack, "competitor-snapshot");
      }
      if (sku === "pack.venue-hours") {
        assert.equal(body.payload.pack, "venue-hours");
      }
      if (sku === "recipe.book-table") {
        assert.equal(body.payload.recipe, "book-table");
      }
      purchaseIds.push(body.purchase_id);
    }
    assert.equal(expected, 500 - 50 - 20 - 100);

    const replay = await app.inject({
      method: "GET",
      url: `/v1/purchases/${purchaseIds[0]}`,
      headers: { authorization: `Bearer ${wallet.api_key}` },
    });
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json().purchase_id, purchaseIds[0]);
    assert.equal(replay.json().sku, "pack.competitor-snapshot");
    assert.equal(replay.json().balance_credits, expected);

    const broke = await createWallet(app, "thin-wallet");
    const small = await app.inject({
      method: "POST",
      url: `/v1/wallets/${broke.wallet_id}/topup`,
      payload: { credits: 10 },
    });
    assert.equal(small.json().balance_credits, 10);
    const denied = await app.inject({
      method: "POST",
      url: "/v1/purchase",
      headers: { authorization: `Bearer ${broke.api_key}` },
      payload: { sku: "pack.venue-hours" },
    });
    assert.equal(denied.statusCode, 402);
    assert.equal(denied.json().error.code, "insufficient_credits");

    const still = await app.inject({
      method: "POST",
      url: `/v1/wallets/${broke.wallet_id}/topup`,
      payload: { credits: 10 },
    });
    assert.equal(still.json().balance_credits, 20);
  } finally {
    await app.close();
  }
});

test("auth and unknown resources", async () => {
  const app = await buildApp({ sqlitePath: ":memory:" });
  try {
    const wallet = await createWallet(app);
    await app.inject({
      method: "POST",
      url: `/v1/wallets/${wallet.wallet_id}/topup`,
      payload: { credits: 200 },
    });

    const missing = await app.inject({
      method: "POST",
      url: "/v1/purchase",
      payload: { sku: "pack.venue-hours" },
    });
    assert.equal(missing.statusCode, 401);

    const badKey = await app.inject({
      method: "POST",
      url: "/v1/purchase",
      headers: { authorization: "Bearer bsk_not-a-real-key" },
      payload: { sku: "pack.venue-hours" },
    });
    assert.equal(badKey.statusCode, 401);

    const unknown = await app.inject({
      method: "POST",
      url: "/v1/purchase",
      headers: { authorization: `Bearer ${wallet.api_key}` },
      payload: { sku: "pack.does-not-exist" },
    });
    assert.equal(unknown.statusCode, 404);
    assert.equal(unknown.json().error.code, "unknown_sku");

    const ghost = await app.inject({
      method: "POST",
      url: "/v1/wallets/wal_missing/topup",
      payload: { credits: 5 },
    });
    assert.equal(ghost.statusCode, 404);

    const badCredits = await app.inject({
      method: "POST",
      url: `/v1/wallets/${wallet.wallet_id}/topup`,
      payload: { credits: 0 },
    });
    assert.equal(badCredits.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("resolveSqlitePath honors SQLITE_PATH", () => {
  const previous = process.env.SQLITE_PATH;
  process.env.SQLITE_PATH = "/tmp/botsupply-custom.sqlite";
  try {
    assert.equal(resolveSqlitePath(), "/tmp/botsupply-custom.sqlite");
  } finally {
    if (previous === undefined) delete process.env.SQLITE_PATH;
    else process.env.SQLITE_PATH = previous;
  }
});
