import { createMcpHandler, fromJsonSchema, McpServer, type AuthInfo } from "@modelcontextprotocol/server";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const SERVER_NAME = "botsupply";
const SERVER_VERSION = "1.0.0";

const INSTRUCTIONS = [
  "BotSupply is a prepaid catalog. Tools wrap the live HTTP API; they do not add SKUs.",
  "Purchase with the field sku (not sku_id).",
  "recipe.book-table is recipe documentation only. Buying it does not place a reservation.",
  "Auth is a wallet API key: Authorization: Bearer on the MCP connection, or the api_key tool argument returned once by open_wallet.",
  "Credits are prepaid. create_checkout returns a Stripe Checkout URL when that route is configured. This server does not mint credits.",
].join(" ");

export type ApiResult = {
  ok: boolean;
  status: number;
  body: unknown;
};

export type BotSupplyClient = {
  get(path: string, apiKey?: string): Promise<ApiResult>;
  post(path: string, body: Record<string, unknown> | undefined, apiKey?: string): Promise<ApiResult>;
};

type ToolResult = {
  content: [{ type: "text"; text: string }];
  isError?: boolean;
};

type Keyed = { api_key?: string };

const listCatalogSchema = fromJsonSchema<Record<string, never>>({
  type: "object",
  properties: {},
  additionalProperties: false,
});

const openWalletSchema = fromJsonSchema<{ label?: string }>({
  type: "object",
  properties: {
    label: {
      type: "string",
      description: "Optional label, 1 to 80 characters. Same field as POST /v1/wallets.",
    },
  },
  additionalProperties: false,
});

const apiKeySchema = {
  type: "string",
  description:
    "Wallet API key (bsk_…). Optional when the MCP client sends Authorization: Bearer. The local stdio process also reads BOTSUPPLY_API_KEY.",
} as const;

const getBalanceSchema = fromJsonSchema<Keyed>({
  type: "object",
  properties: { api_key: apiKeySchema },
  additionalProperties: false,
});

const purchaseSchema = fromJsonSchema<{ sku: string; api_key?: string }>({
  type: "object",
  properties: {
    sku: {
      type: "string",
      description: "Live catalog SKU. The field name is sku, not sku_id.",
    },
    api_key: apiKeySchema,
  },
  required: ["sku"],
  additionalProperties: false,
});

const checkoutSchema = fromJsonSchema<{ credits: number; wallet_id?: string; api_key?: string }>({
  type: "object",
  properties: {
    credits: {
      type: "integer",
      minimum: 100,
      maximum: 100000,
      description: "Credits to buy. 1 credit = $0.01 USD. Same limits as POST /v1/wallets/:id/checkout.",
    },
    wallet_id: {
      type: "string",
      description: "Wallet to credit. Defaults to the wallet that owns the API key.",
    },
    api_key: apiKeySchema,
  },
  required: ["credits"],
  additionalProperties: false,
});

function textResult(body: unknown, isError = false): ToolResult {
  const result: ToolResult = { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
  if (isError) result.isError = true;
  return result;
}

function fromApi(result: ApiResult, map?: (body: unknown) => unknown): ToolResult {
  if (!result.ok) return textResult({ status: result.status, body: result.body }, true);
  return textResult(map ? map(result.body) : result.body);
}

function missingKey(): ToolResult {
  return textResult(
    {
      status: 401,
      body: {
        error: {
          code: "unauthorized",
          message:
            "Missing API key. Send Authorization: Bearer <api_key> on the MCP connection, or pass api_key. open_wallet returns a key once.",
        },
      },
    },
    true,
  );
}

function resolveApiKey(explicit: string | undefined, fallback: string | undefined): string | undefined {
  const fromArgs = explicit?.trim();
  if (fromArgs) return fromArgs;
  const fromFallback = fallback?.trim();
  return fromFallback || undefined;
}

function annotateCatalog(body: unknown): unknown {
  if (body == null || typeof body !== "object" || !("products" in body)) return body;
  const products = (body as { products?: unknown }).products;
  if (!Array.isArray(products)) return body;
  return {
    ...body,
    purchase_body_field: "sku",
    products: products.map((product) => {
      if (product == null || typeof product !== "object") return product;
      const sku = "sku" in product ? product.sku : undefined;
      const notIncluded =
        sku === "recipe.book-table"
          ? "Recipe documentation only. Buying this SKU does not place a reservation."
          : "The JSON payload is not in the catalog. It is delivered only after purchase.";
      return { ...product, not_included: notIncluded };
    }),
    limits: [
      "Credits are prepaid. These tools do not mint credits or add SKUs.",
      "BotSupply does not place reservations or scrape venues.",
      "The hosted service is on Render's free tier. The first request after idle can take about a minute, and the ephemeral disk can reset wallets on restart or deploy.",
    ],
  };
}

function registerTools(server: McpServer, client: BotSupplyClient, defaultApiKey: string | undefined): void {
  server.registerTool(
    "list_catalog",
    {
      title: "List catalog",
      description:
        "List live BotSupply SKUs, credit prices, short descriptions, and what a purchase does not include. Payloads stay behind purchase. recipe.book-table, when listed, is recipe documentation only and does not place a reservation.",
      inputSchema: listCatalogSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const result = await client.get("/v1/catalog");
      return fromApi(result, annotateCatalog);
    },
  );

  server.registerTool(
    "open_wallet",
    {
      title: "Open wallet",
      description:
        "Create a wallet and return wallet_id plus api_key once, with balance_credits 0. Same as POST /v1/wallets. This does not look up an existing wallet. Keep the api_key; later tools need it as Authorization: Bearer or as api_key.",
      inputSchema: openWalletSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ label }) => {
      const body = label === undefined ? {} : { label };
      return fromApi(await client.post("/v1/wallets", body));
    },
  );

  server.registerTool(
    "get_balance",
    {
      title: "Get balance",
      description: "Return the authenticated wallet id and prepaid credit balance. Same as GET /v1/balance. Does not return the API key.",
      inputSchema: getBalanceSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const apiKey = resolveApiKey(args.api_key, defaultApiKey);
      if (!apiKey) return missingKey();
      return fromApi(await client.get("/v1/balance", apiKey));
    },
  );

  server.registerTool(
    "purchase",
    {
      title: "Purchase",
      description:
        "Buy one live catalog SKU with prepaid credits. Sends { sku } to POST /v1/purchase and returns that JSON, including the pack or recipe payload. Does not place a reservation. recipe.book-table is documentation the buying agent runs itself. An unknown SKU is rejected. Insufficient balance returns an error and does not deduct credits.",
      inputSchema: purchaseSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const apiKey = resolveApiKey(args.api_key, defaultApiKey);
      if (!apiKey) return missingKey();
      return fromApi(await client.post("/v1/purchase", { sku: args.sku }, apiKey));
    },
  );

  server.registerTool(
    "create_checkout",
    {
      title: "Create checkout",
      description:
        "Start a Stripe Checkout credit top-up. Same as POST /v1/wallets/:id/checkout. Returns the checkout url (open that URL; it keeps Stripe's hosted-page fragment). credits is an integer from 100 to 100000. Credits are applied only after Stripe reports the session paid. Returns the API error when Stripe is not configured.",
      inputSchema: checkoutSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const apiKey = resolveApiKey(args.api_key, defaultApiKey);
      if (!apiKey) return missingKey();
      let walletId = args.wallet_id?.trim();
      if (!walletId) {
        const balance = await client.get("/v1/balance", apiKey);
        if (!balance.ok) return fromApi(balance);
        const id = walletIdFromBalance(balance.body);
        if (!id) {
          return textResult(
            {
              status: 502,
              body: { error: { code: "bad_balance", message: "Balance response did not include wallet_id." } },
            },
            true,
          );
        }
        walletId = id;
      }
      return fromApi(
        await client.post(`/v1/wallets/${encodeURIComponent(walletId)}/checkout`, { credits: args.credits }, apiKey),
      );
    },
  );
}

function walletIdFromBalance(body: unknown): string | undefined {
  if (body == null || typeof body !== "object" || !("wallet_id" in body)) return undefined;
  const id = body.wallet_id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

export function buildMcpServer(client: BotSupplyClient, defaultApiKey?: string): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  registerTools(server, client, defaultApiKey);
  return server;
}

function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function callHttp(
  baseUrl: string,
  method: "GET" | "POST",
  path: string,
  apiKey: string | undefined,
  payload?: Record<string, unknown>,
): Promise<ApiResult> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (payload !== undefined) headers["content-type"] = "application/json";
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(90_000),
    });
    const body = parseBody(await response.text());
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    return {
      ok: false,
      status: 0,
      body: {
        error: {
          code: "upstream_unreachable",
          message: `Could not reach BotSupply at ${baseUrl} (${message}). The free Render service sleeps after idle time; retry after GET /health returns {"status":"ok","service":"botsupply"}.`,
        },
      },
    };
  }
}

/** HTTP client for the stdio process. Talks to the public API; it does not open a local database. */
export function createHttpClient(baseUrl: string): BotSupplyClient {
  const base = baseUrl.replace(/\/+$/, "");
  return {
    get: (path, apiKey) => callHttp(base, "GET", path, apiKey),
    post: (path, body, apiKey) => callHttp(base, "POST", path, apiKey, body ?? {}),
  };
}

export function createInjectClient(app: FastifyInstance): BotSupplyClient {
  const call = async (
    method: "GET" | "POST",
    path: string,
    apiKey: string | undefined,
    payload?: Record<string, unknown>,
  ): Promise<ApiResult> => {
    const response = await app.inject({
      method,
      url: path,
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined,
      payload,
    });
    return { ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, body: parseBody(response.body) };
  };
  return {
    get: (path, apiKey) => call("GET", path, apiKey),
    post: (path, body, apiKey) => call("POST", path, apiKey, body),
  };
}

function bearerToken(value: string | string[] | undefined): string | undefined {
  const header = Array.isArray(value) ? value[0] : value;
  if (!header) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1];
}

function authInfo(token: string | undefined): AuthInfo | undefined {
  if (!token) return undefined;
  return { token, clientId: "botsupply-wallet", scopes: ["wallet"] };
}

/**
 * Stateless Streamable HTTP MCP on the same process as the HTTP API.
 * Tools call the existing routes through Fastify inject, so purchase and checkout stay on one implementation.
 */
export function mountMcp(app: FastifyInstance): void {
  const client = createInjectClient(app);
  const handler = createMcpHandler((ctx) => buildMcpServer(client, ctx.authInfo?.token));

  app.addHook("onClose", async () => {
    await handler.close();
  });

  app.all("/mcp", async (request: FastifyRequest, reply: FastifyReply) => {
    const url = `${request.protocol}://${request.hostname}${request.url}`;
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (value == null) continue;
      if (Array.isArray(value)) {
        for (const item of value) headers.append(key, item);
      } else {
        headers.set(key, value);
      }
    }
    const token = bearerToken(request.headers.authorization);
    const hasBody = request.method !== "GET" && request.method !== "HEAD" && request.body != null;
    const webRequest = new Request(url, {
      method: request.method,
      headers,
      body: hasBody ? JSON.stringify(request.body) : undefined,
    });
    const response = await handler.fetch(webRequest, {
      authInfo: authInfo(token),
      parsedBody: request.body,
    });
    const contentType = response.headers.get("content-type") ?? "application/json";
    reply.status(response.status);
    response.headers.forEach((value, key) => {
      if (key === "content-type" || key === "content-length" || key === "transfer-encoding") return;
      reply.header(key, value);
    });
    const text = await response.text();
    if (contentType.includes("application/json")) {
      if (!text) return reply.code(response.status).type(contentType).send();
      return reply.type(contentType).send(JSON.parse(text) as unknown);
    }
    return reply.type(contentType).send(text);
  });
}
