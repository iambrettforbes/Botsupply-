import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { buildApp } from "../src/app.js";
import { createHttpClient } from "../src/mcp.js";
import type { StripeGateway } from "../src/stripe.js";

const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

type Rpc = {
  result?: {
    isError?: boolean;
    content?: Array<{ type: string; text?: string }>;
    tools?: Array<{ name: string; description?: string }>;
    instructions?: string;
  };
  error?: { message?: string };
};

async function rpc(
  app: Awaited<ReturnType<typeof buildApp>>,
  method: string,
  params: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<Rpc> {
  const response = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { ...MCP_HEADERS, ...extraHeaders },
    payload: { jsonrpc: "2.0", id: 1, method, params },
  });
  assert.equal(response.statusCode, 200, response.body);
  const type = String(response.headers["content-type"] ?? "");
  if (type.includes("text/event-stream")) {
    const line = response.body.split("\n").find((entry) => entry.startsWith("data:"));
    assert.ok(line, response.body);
    return JSON.parse(line.slice(5).trim()) as Rpc;
  }
  return response.json() as Rpc;
}

function toolJson(message: Rpc): { isError: boolean; body: unknown; text: string } {
  assert.equal(message.error, undefined, JSON.stringify(message.error));
  const text = message.result?.content?.find((block) => block.type === "text")?.text;
  assert.equal(typeof text, "string");
  return { isError: message.result?.isError === true, body: JSON.parse(text ?? "null") as unknown, text: text ?? "" };
}

test("MCP tools list the live catalog and do not invent a reservation tool", async () => {
  const app = await buildApp({ sqlitePath: ":memory:" });
  try {
    const listed = await rpc(app, "tools/list", {});
    const names = (listed.result?.tools ?? []).map((tool) => tool.name).sort();
    assert.deepEqual(names, ["create_checkout", "get_balance", "list_catalog", "open_wallet", "purchase"]);
    const purchase = listed.result?.tools?.find((tool) => tool.name === "purchase");
    assert.match(purchase?.description ?? "", /does not place a reservation/i);
    assert.match(purchase?.description ?? "", /sku/);
    assert.equal(listed.result?.tools?.some((tool) => /reserv/i.test(tool.name)), false);

    const catalog = toolJson(await rpc(app, "tools/call", { name: "list_catalog", arguments: {} }));
    assert.equal(catalog.isError, false);
    const doc = catalog.body as {
      purchase_body_field: string;
      products: Array<{ sku: string; price_credits: number; not_included: string; payload?: unknown }>;
    };
    assert.equal(doc.purchase_body_field, "sku");
    assert.deepEqual(
      doc.products.map((product) => [product.sku, product.price_credits]),
      [
        ["pack.competitor-snapshot", 50],
        ["pack.venue-hours", 20],
        ["recipe.book-table", 100],
      ],
    );
    for (const product of doc.products) assert.equal(product.payload, undefined);
    const recipe = doc.products.find((product) => product.sku === "recipe.book-table");
    assert.match(recipe?.not_included ?? "", /does not place a reservation/);
  } finally {
    await app.close();
  }
});

test("MCP open, balance, and purchase wrap the HTTP routes", async () => {
  const app = await buildApp({ sqlitePath: ":memory:" });
  try {
    const opened = toolJson(await rpc(app, "tools/call", { name: "open_wallet", arguments: { label: "mcp-agent" } }));
    assert.equal(opened.isError, false);
    const wallet = opened.body as { wallet_id: string; api_key: string; balance_credits: number };
    assert.match(wallet.wallet_id, /^wal_/);
    assert.match(wallet.api_key, /^bsk_/);
    assert.equal(wallet.balance_credits, 0);

    const bare = toolJson(await rpc(app, "tools/call", { name: "get_balance", arguments: {} }));
    assert.equal(bare.isError, true);

    const balance = toolJson(
      await rpc(app, "tools/call", { name: "get_balance", arguments: {} }, { authorization: `Bearer ${wallet.api_key}` }),
    );
    assert.equal(balance.isError, false);
    assert.deepEqual(
      { wallet_id: (balance.body as { wallet_id: string }).wallet_id, balance_credits: (balance.body as { balance_credits: number }).balance_credits },
      { wallet_id: wallet.wallet_id, balance_credits: 0 },
    );

    const broke = toolJson(
      await rpc(app, "tools/call", {
        name: "purchase",
        arguments: { sku: "pack.venue-hours", api_key: wallet.api_key },
      }),
    );
    assert.equal(broke.isError, true);
    assert.equal((broke.body as { status: number }).status, 402);

    const still = await app.inject({
      method: "GET",
      url: "/v1/balance",
      headers: { authorization: `Bearer ${wallet.api_key}` },
    });
    assert.equal(still.json().balance_credits, 0);

    const rejected = await rpc(app, "tools/call", {
      name: "purchase",
      arguments: { sku_id: "pack.venue-hours", api_key: wallet.api_key },
    });
    assert.equal(rejected.result?.isError, true);
    const rejectedText = rejected.result?.content?.find((block) => block.type === "text")?.text ?? "";
    assert.match(rejectedText, /sku/);
    assert.doesNotMatch(rejectedText, /venue-hours/);

    await app.inject({
      method: "POST",
      url: `/v1/wallets/${wallet.wallet_id}/topup`,
      payload: { credits: 500 },
    });

    const httpBuy = await app.inject({
      method: "POST",
      url: "/v1/purchase",
      headers: { authorization: `Bearer ${wallet.api_key}` },
      payload: { sku: "pack.venue-hours" },
    });
    const mcpBuy = toolJson(
      await rpc(app, "tools/call", {
        name: "purchase",
        arguments: { sku: "recipe.book-table" },
      }, { authorization: `Bearer ${wallet.api_key}` }),
    );
    assert.equal(mcpBuy.isError, false);
    const bought = mcpBuy.body as {
      sku: string;
      credits_charged: number;
      balance_credits: number;
      payload: { recipe?: string };
    };
    assert.equal(bought.sku, "recipe.book-table");
    assert.equal(bought.credits_charged, 100);
    assert.equal(bought.payload.recipe, "book-table");
    assert.equal(bought.balance_credits, httpBuy.json().balance_credits - 100);
    assert.equal(httpBuy.json().payload.pack, "venue-hours");

    const checkout = toolJson(
      await rpc(app, "tools/call", {
        name: "create_checkout",
        arguments: { credits: 100 },
      }, { authorization: `Bearer ${wallet.api_key}` }),
    );
    assert.equal(checkout.isError, true);
    assert.equal((checkout.body as { body: { error: { code: string } } }).body.error.code, "stripe_not_configured");
  } finally {
    await app.close();
  }
});

test("MCP create_checkout returns the existing checkout URL", async () => {
  const gateway: StripeGateway = {
    async createCheckoutSession() {
      return { id: "cs_test_mcp", url: "https://checkout.stripe.com/c/pay/cs_test_mcp#fid_mcp" };
    },
    constructEvent() {
      throw new Error("not used");
    },
  };
  const app = await buildApp({
    sqlitePath: ":memory:",
    stripe: {
      devTopupEnabled: false,
      missing: [],
      ready: { publicBaseUrl: "https://botsupply.onrender.com", gateway },
    },
  });
  try {
    const opened = toolJson(await rpc(app, "tools/call", { name: "open_wallet", arguments: {} }));
    const wallet = opened.body as { api_key: string; wallet_id: string };
    const checkout = toolJson(
      await rpc(
        app,
        "tools/call",
        { name: "create_checkout", arguments: { credits: 250, api_key: wallet.api_key } },
      ),
    );
    assert.equal(checkout.isError, false);
    const body = checkout.body as { url: string; stripe_url: string; wallet_id: string; credits: number };
    assert.equal(body.wallet_id, wallet.wallet_id);
    assert.equal(body.credits, 250);
    assert.equal(body.url, "https://botsupply.onrender.com/v1/pay/s/cs_test_mcp");
    assert.match(body.stripe_url, /#fid_mcp$/);
  } finally {
    await app.close();
  }
});

test("stdio HTTP client calls the same catalog route", async () => {
  const app = await buildApp({ sqlitePath: ":memory:" });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const child = spawn(process.execPath, ["--import", "tsx", "src/mcp-stdio.ts"], {
    env: { ...process.env, BOTSUPPLY_BASE_URL: `http://127.0.0.1:${port}` },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  try {
    const client = createHttpClient(`http://127.0.0.1:${port}`);
    const direct = await client.get("/v1/catalog");
    assert.equal(direct.status, 200);
    assert.equal((direct.body as { products: unknown[] }).products.length, 3);

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_catalog", arguments: {} },
      })}\n`,
    );
    const message = await waitForRpc(child, () => stdout);
    const text = message.result?.content?.find((block) => block.type === "text")?.text ?? "";
    const doc = JSON.parse(text) as { products: Array<{ sku: string }> };
    assert.deepEqual(
      doc.products.map((product) => product.sku),
      (direct.body as { products: Array<{ sku: string }> }).products.map((product) => product.sku),
    );
  } finally {
    child.kill();
    await app.close();
  }
});

function waitForRpc(
  child: ReturnType<typeof spawn>,
  read: () => string,
): Promise<{ result?: { content?: Array<{ type: string; text?: string }> } }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`stdio MCP produced no result.\nstdout:\n${read()}`));
    }, 10_000);
    const tick = () => {
      if (child.exitCode != null) {
        clearTimeout(timer);
        reject(new Error(`stdio MCP exited ${child.exitCode}.\nstdout:\n${read()}`));
        return;
      }
      const line = read()
        .split("\n")
        .find((entry) => entry.includes('"result"') || entry.includes('"error"'));
      if (!line) return;
      clearTimeout(timer);
      clearInterval(interval);
      resolve(JSON.parse(line) as { result?: { content?: Array<{ type: string; text?: string }> } });
    };
    const interval = setInterval(tick, 50);
  });
}
