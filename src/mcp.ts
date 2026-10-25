import { AsyncLocalStorage } from "node:async_hooks";
import { createMcpHandler, fromJsonSchema, McpServer, type AuthInfo } from "@modelcontextprotocol/server";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ESCROW_AMOUNT_MAX, ESCROW_DESCRIPTION_MAX, ESCROW_IDEMPOTENCY_MAX } from "./escrow.js";
import {
  RECEIPT_AGENT_MAX,
  RECEIPT_APPROVER_MAX,
  RECEIPT_CONTACT_MAX,
  RECEIPT_MERCHANT_MAX,
  RECEIPT_PROOF_TYPE_MAX,
  RECEIPT_PROOF_VALUE_MAX,
  RECEIPT_RAIL_MAX,
  RECEIPT_REF_MAX,
  RECEIPT_SCOPE_MAX,
  clientIp,
} from "./receipts.js";
import { CHECKOUT_MAX_CREDITS, CHECKOUT_MIN_CREDITS } from "./stripe.js";

const SERVER_NAME = "botsupply";
const SERVER_VERSION = "1.0.0";

const INSTRUCTIONS = [
  "BotSupply is a prepaid catalog. Tools wrap the live HTTP API; they do not add SKUs.",
  "Purchase with the field sku (not sku_id).",
  "recipe.book-table is recipe documentation only. Buying it does not place a reservation.",
  "Auth is a wallet API key: Authorization: Bearer on the MCP connection, or the api_key tool argument returned once by open_wallet.",
  "Credits are prepaid. create_checkout returns a Stripe Checkout URL when that route is configured. This server does not mint credits.",
  "create_job holds the caller's credits in escrow for another agent's wallet. release_job pays the payee when the work is delivered. refund_job returns the hold to the payer. The payer authorizes release and refund. The payee can also refund to cancel. A platform fee, ESCROW_FEE_BPS, defaults to 0 and is withheld from the payee only on release.",
  "record_approval writes a public record of what was reported as approved for a payment on any rail. The approver name is supplied by the calling agent and is not confirmation of who approved. BotSupply does not hold or move that money. attach_proof adds delivery proof with the edit_token from record_approval. get_receipt and verify_receipt are public. verify_receipt checks that the record has not changed since it was created. It does not confirm who approved.",
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

const createJobSchema = fromJsonSchema<{
  payee_wallet_id: string;
  amount_credits: number;
  description: string;
  idempotency_key: string;
  api_key?: string;
}>({
  type: "object",
  properties: {
    payee_wallet_id: {
      type: "string",
      description: "Wallet that receives the credits when the payer releases the job.",
    },
    amount_credits: {
      type: "integer",
      minimum: 1,
      maximum: ESCROW_AMOUNT_MAX,
      description: "Credits to debit from the authenticated payer wallet and hold until release or refund.",
    },
    description: {
      type: "string",
      maxLength: ESCROW_DESCRIPTION_MAX,
      description: "What the payee is being paid to do.",
    },
    idempotency_key: {
      type: "string",
      maxLength: ESCROW_IDEMPOTENCY_MAX,
      description:
        "Caller-chosen key scoped to the payer. A retry with the same key and the same parameters returns the original job and does not debit again.",
    },
    api_key: apiKeySchema,
  },
  required: ["payee_wallet_id", "amount_credits", "description", "idempotency_key"],
  additionalProperties: false,
});

const jobIdSchema = fromJsonSchema<{ job_id: string; api_key?: string }>({
  type: "object",
  properties: {
    job_id: { type: "string", description: "Escrow job id returned by create_job (job_…)." },
    api_key: apiKeySchema,
  },
  required: ["job_id"],
  additionalProperties: false,
});

const recordApprovalSchema = fromJsonSchema<{
  approver: string;
  approver_contact?: string;
  agent_id?: string;
  agent_name?: string;
  merchant_name: string;
  merchant_url?: string;
  scope: string;
  price_cap_amount: number | string;
  price_cap_currency: string;
  payment_rail: string;
  external_payment_ref?: string;
}>({
  type: "object",
  properties: {
    approver: {
      type: "string",
      maxLength: RECEIPT_APPROVER_MAX,
      description: "Name the calling agent reports as the approver. Not confirmation that this person approved.",
    },
    approver_contact: {
      type: "string",
      maxLength: RECEIPT_CONTACT_MAX,
      description: "Optional email or phone. Stored only as a hash and never shown on the receipt.",
    },
    agent_id: {
      type: "string",
      maxLength: RECEIPT_AGENT_MAX,
      description: "Optional id of the agent that will pay. Not a BotSupply API key.",
    },
    agent_name: {
      type: "string",
      maxLength: RECEIPT_AGENT_MAX,
      description: "Optional display name of the paying agent.",
    },
    merchant_name: {
      type: "string",
      maxLength: RECEIPT_MERCHANT_MAX,
      description: "Merchant or seller name.",
    },
    merchant_url: {
      type: "string",
      description: "Optional http or https URL for the merchant.",
    },
    scope: {
      type: "string",
      maxLength: RECEIPT_SCOPE_MAX,
      description: "What was reported as approved, in plain text.",
    },
    price_cap_amount: {
      anyOf: [{ type: "number", exclusiveMinimum: 0 }, { type: "string", minLength: 1, maxLength: 40 }],
      description: "Maximum amount reported as approved. A positive decimal, for example 25 or \"19.95\".",
    },
    price_cap_currency: {
      type: "string",
      description: "Currency code, 3 to 10 letters, for example USD or USDC.",
    },
    payment_rail: {
      type: "string",
      maxLength: RECEIPT_RAIL_MAX,
      description: "How the agent will pay. Examples: stripe_link, card, x402, botsupply_wallet.",
    },
    external_payment_ref: {
      type: "string",
      maxLength: RECEIPT_REF_MAX,
      description: "Optional id from the payment rail. BotSupply does not look it up.",
    },
  },
  required: ["approver", "merchant_name", "scope", "price_cap_amount", "price_cap_currency", "payment_rail"],
  additionalProperties: false,
});

const attachProofSchema = fromJsonSchema<{
  receipt_id: string;
  edit_token: string;
  type: string;
  value: string;
  actual_amount?: number | string;
  status?: "delivered" | "disputed";
}>({
  type: "object",
  properties: {
    receipt_id: { type: "string", description: "Receipt id from record_approval (rcpt_…)." },
    edit_token: {
      type: "string",
      description: "Secret returned once by record_approval. Required to attach proof.",
    },
    type: {
      type: "string",
      maxLength: RECEIPT_PROOF_TYPE_MAX,
      description: "Proof kind. Examples: order_confirmation, tracking, url, hash.",
    },
    value: {
      type: "string",
      maxLength: RECEIPT_PROOF_VALUE_MAX,
      description: "The proof itself: confirmation id, tracking number, URL, or hash.",
    },
    actual_amount: {
      anyOf: [{ type: "number", minimum: 0 }, { type: "string", minLength: 1, maxLength: 40 }],
      description: "Amount actually charged. over_cap is true when this is above the price cap.",
    },
    status: {
      type: "string",
      enum: ["delivered", "disputed"],
      description: "Omit to mark an approved receipt delivered. Pass disputed to dispute it.",
    },
  },
  required: ["receipt_id", "edit_token", "type", "value"],
  additionalProperties: false,
});

const receiptIdSchema = fromJsonSchema<{ receipt_id: string }>({
  type: "object",
  properties: {
    receipt_id: { type: "string", description: "Public receipt id (rcpt_…)." },
  },
  required: ["receipt_id"],
  additionalProperties: false,
});

const checkoutSchema = fromJsonSchema<{ credits: number; wallet_id?: string; api_key?: string }>({
  type: "object",
  properties: {
    credits: {
      type: "integer",
      minimum: CHECKOUT_MIN_CREDITS,
      maximum: CHECKOUT_MAX_CREDITS,
      description: `Credits to buy. 1 credit = $0.01 USD. Minimum ${CHECKOUT_MIN_CREDITS} credits ($5). Same limits as POST /v1/wallets/:id/checkout.`,
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
      "The first request after idle can take about a minute on the free Render service. Wallets persist in Postgres when DATABASE_URL is set. Without DATABASE_URL the file store can reset on restart or deploy.",
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
        `Start a Stripe Checkout credit top-up. Same as POST /v1/wallets/:id/checkout. Returns the checkout url (open that URL; it keeps Stripe's hosted-page fragment). credits is an integer from ${CHECKOUT_MIN_CREDITS} to ${CHECKOUT_MAX_CREDITS} ($5 minimum). Credits are applied only after Stripe reports the session paid. Returns the API error when Stripe is not configured.`,
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

  server.registerTool(
    "create_job",
    {
      title: "Create escrow job",
      description:
        "Hold credits in escrow for a job another agent will do; release when the work is delivered, refund if not. Debits amount_credits from the authenticated payer wallet and marks the job held. payee_wallet_id receives the credits on release. Rejects amount_credits below 1, a payer equal to the payee, a missing or other-mode payee wallet, and insufficient balance. idempotency_key makes a retry return the same job without debiting twice. Same as POST /v1/jobs.",
      inputSchema: createJobSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const apiKey = resolveApiKey(args.api_key, defaultApiKey);
      if (!apiKey) return missingKey();
      return fromApi(
        await client.post(
          "/v1/jobs",
          {
            payee_wallet_id: args.payee_wallet_id,
            amount_credits: args.amount_credits,
            description: args.description,
            idempotency_key: args.idempotency_key,
          },
          apiKey,
        ),
      );
    },
  );

  server.registerTool(
    "get_job",
    {
      title: "Get escrow job",
      description:
        "Return an escrow job's status (held, released, or refunded), the held amount, any release fee, and the payer and payee wallets. The caller must be the payer or the payee. A job from another Stripe mode is not visible. Same as GET /v1/jobs/:id.",
      inputSchema: jobIdSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const apiKey = resolveApiKey(args.api_key, defaultApiKey);
      if (!apiKey) return missingKey();
      return fromApi(await client.get(`/v1/jobs/${encodeURIComponent(args.job_id)}`, apiKey));
    },
  );

  server.registerTool(
    "release_job",
    {
      title: "Release escrow job",
      description:
        "Release held escrow credits to the payee when the work is delivered. Only the payer can release, and only while the job is held. ESCROW_FEE_BPS (default 0) is withheld on release, recorded on the job, and credited to nobody; the payee receives amount_credits minus that fee. Releasing twice, or releasing after a refund, is rejected and does not move credits again. Same as POST /v1/jobs/:id/release.",
      inputSchema: jobIdSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const apiKey = resolveApiKey(args.api_key, defaultApiKey);
      if (!apiKey) return missingKey();
      return fromApi(await client.post(`/v1/jobs/${encodeURIComponent(args.job_id)}/release`, {}, apiKey));
    },
  );

  server.registerTool(
    "refund_job",
    {
      title: "Refund escrow job",
      description:
        "Return held escrow credits to the payer when the work is not delivered or the job is cancelled. The payer or the payee can refund, and only while the job is held. The full hold goes back to the payer; no platform fee is taken. Refunding twice, or refunding after release, is rejected and does not move credits again. Same as POST /v1/jobs/:id/refund.",
      inputSchema: jobIdSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const apiKey = resolveApiKey(args.api_key, defaultApiKey);
      if (!apiKey) return missingKey();
      return fromApi(await client.post(`/v1/jobs/${encodeURIComponent(args.job_id)}/refund`, {}, apiKey));
    },
  );

  server.registerTool(
    "record_approval",
    {
      title: "Record reported approval",
      description:
        "Write a record of what was reported as approved for a purchase on any payment rail. The approver is a name supplied by the calling agent; this does not confirm who approved. BotSupply does not hold or move the money. Returns receipt_id, a public receipt_url, and an edit_token shown once. No wallet or API key. Rate limited per IP. Same as POST /v1/receipts.",
      inputSchema: recordApprovalSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const body: Record<string, unknown> = {
        approver: args.approver,
        merchant_name: args.merchant_name,
        scope: args.scope,
        price_cap_amount: args.price_cap_amount,
        price_cap_currency: args.price_cap_currency,
        payment_rail: args.payment_rail,
      };
      if (args.approver_contact !== undefined) body.approver_contact = args.approver_contact;
      if (args.agent_id !== undefined) body.agent_id = args.agent_id;
      if (args.agent_name !== undefined) body.agent_name = args.agent_name;
      if (args.merchant_url !== undefined) body.merchant_url = args.merchant_url;
      if (args.external_payment_ref !== undefined) body.external_payment_ref = args.external_payment_ref;
      return fromApi(await client.post("/v1/receipts", body));
    },
  );

  server.registerTool(
    "attach_proof",
    {
      title: "Attach delivery proof",
      description:
        "Attach proof of delivery to a receipt. Requires the edit_token from record_approval. Moves approved to delivered, or to disputed when status is disputed. over_cap is true when actual_amount exceeds the price cap. Does not move money. Same as POST /v1/receipts/:id/proof.",
      inputSchema: attachProofSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const body: Record<string, unknown> = {
        edit_token: args.edit_token,
        type: args.type,
        value: args.value,
      };
      if (args.actual_amount !== undefined) body.actual_amount = args.actual_amount;
      if (args.status !== undefined) body.status = args.status;
      return fromApi(await client.post(`/v1/receipts/${encodeURIComponent(args.receipt_id)}/proof`, body));
    },
  );

  server.registerTool(
    "get_receipt",
    {
      title: "Get purchase receipt",
      description:
        "Read a public purchase receipt: what was reported as approved, scope, price cap, merchant, proofs, and content hash. The approver is a name the calling agent reported, not confirmation of who approved. No API key. The approver contact and the edit token are not included. Same as GET /v1/receipts/:id.",
      inputSchema: receiptIdSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => fromApi(await client.get(`/v1/receipts/${encodeURIComponent(args.receipt_id)}`)),
  );

  server.registerTool(
    "verify_receipt",
    {
      title: "Verify purchase receipt",
      description:
        "Recompute the receipt hash chain and HMAC signature. valid is true when the stored receipt matches the chain and the server signature, so the record hasn't been changed since it was created. valid does not confirm who approved. valid is false when a row was altered. Same as GET /v1/receipts/:id/verify.",
      inputSchema: receiptIdSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => fromApi(await client.get(`/v1/receipts/${encodeURIComponent(args.receipt_id)}/verify`)),
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
          message: `Could not reach BotSupply at ${baseUrl} (${message}). The free Render service sleeps after idle time; retry after GET /health returns {"status":"ok"}.`,
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

const mcpClientIp = new AsyncLocalStorage<string>();

export function createInjectClient(app: FastifyInstance): BotSupplyClient {
  const call = async (
    method: "GET" | "POST",
    path: string,
    apiKey: string | undefined,
    payload?: Record<string, unknown>,
  ): Promise<ApiResult> => {
    const headers: Record<string, string> = {};
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const ip = mcpClientIp.getStore();
    if (ip) headers["x-forwarded-for"] = ip;
    const response = await app.inject({
      method,
      url: path,
      headers,
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
    const ip = clientIp(request.headers["x-forwarded-for"], request.ip);
    return mcpClientIp.run(ip, async () => {
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
  });
}
