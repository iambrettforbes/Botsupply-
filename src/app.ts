import { Readable } from "node:stream";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { catalogDocument, findProduct } from "./catalog.js";
import {
  applyStripeCheckoutCredit,
  createWallet,
  findPurchase,
  findWalletByApiKey,
  findWalletById,
  openDatabase,
  purchaseSku,
  topUpWallet,
  type WalletRow,
} from "./db.js";
import { ApiError } from "./errors.js";
import { renderLanding } from "./landing.js";
import {
  CHECKOUT_MAX_CREDITS,
  CHECKOUT_MIN_CREDITS,
  checkoutUrls,
  stripeFromEnv,
  type CheckoutCompletedEvent,
  type ResolvedStripe,
} from "./stripe.js";

export type BuildOptions = {
  sqlitePath: string;
  logger?: boolean;
  /** Omit to read Stripe settings from the environment. */
  stripe?: ResolvedStripe;
};

const MAX_TOPUP = 1_000_000;

function asRecord(body: unknown): Record<string, unknown> {
  if (body == null) return {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(400, "bad_request", "JSON object body required");
  }
  return body as Record<string, unknown>;
}

function rejectUnknown(body: Record<string, unknown>, allowed: string[]): void {
  const extra = Object.keys(body).filter((key) => !allowed.includes(key));
  if (extra.length > 0) {
    throw new ApiError(400, "bad_request", `Unknown field: ${extra[0]}`);
  }
}

function readLabel(body: Record<string, unknown>): string | null {
  if (body.label == null) return null;
  if (typeof body.label !== "string" || body.label.trim().length === 0 || body.label.length > 80) {
    throw new ApiError(400, "bad_request", "label must be a string of 1 to 80 characters");
  }
  return body.label.trim();
}

function readCredits(body: Record<string, unknown>, min: number, max: number): number {
  const credits = body.credits;
  if (typeof credits !== "number" || !Number.isInteger(credits) || credits < min || credits > max) {
    throw new ApiError(400, "bad_request", `credits must be an integer from ${min} to ${max}`);
  }
  return credits;
}

function readSku(body: Record<string, unknown>): string {
  if (typeof body.sku !== "string" || body.sku.trim().length === 0 || body.sku.length > 80) {
    throw new ApiError(400, "bad_request", "sku must be a non-empty string");
  }
  return body.sku;
}

function bearerWallet(db: ReturnType<typeof openDatabase>, request: FastifyRequest): WalletRow {
  const header = request.headers.authorization;
  if (!header) {
    throw new ApiError(401, "unauthorized", "Missing Authorization bearer token");
  }
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match?.[1]) {
    throw new ApiError(401, "unauthorized", "Authorization must be a Bearer token");
  }
  const wallet = findWalletByApiKey(db, match[1]);
  if (!wallet) {
    throw new ApiError(401, "unauthorized", "Invalid API key");
  }
  return wallet;
}

function publicPurchase(
  purchase: { id: string; wallet_id: string; sku: string; credits_charged: number; payload_json: string; created_at: string },
  balanceCredits: number,
) {
  return {
    purchase_id: purchase.id,
    wallet_id: purchase.wallet_id,
    sku: purchase.sku,
    credits_charged: purchase.credits_charged,
    balance_credits: balanceCredits,
    created_at: purchase.created_at,
    payload: JSON.parse(purchase.payload_json) as unknown,
  };
}

const rawBodies = new WeakMap<FastifyRequest, Buffer>();

function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function sessionFromEvent(event: CheckoutCompletedEvent): {
  sessionId: string;
  walletId: string;
  credits: number;
  paymentStatus: string;
} {
  const session = event.data?.object;
  const sessionId = session?.id ?? "";
  const walletId = session?.metadata?.wallet_id ?? "";
  const credits = Number(session?.metadata?.credits);
  if (!sessionId || !walletId || !Number.isInteger(credits)) {
    throw new ApiError(400, "invalid_session", "Checkout session is missing wallet_id or credits metadata");
  }
  if (credits < CHECKOUT_MIN_CREDITS || credits > CHECKOUT_MAX_CREDITS) {
    throw new ApiError(400, "invalid_session", "Checkout session credits are outside the allowed range");
  }
  return {
    sessionId,
    walletId,
    credits,
    paymentStatus: session?.payment_status ?? "",
  };
}

export async function buildApp(options: BuildOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  const db = openDatabase(options.sqlitePath);
  const stripe = options.stripe ?? stripeFromEnv();

  app.addHook("onClose", async () => {
    db.close();
  });

  app.addHook("preParsing", async (request, _reply, payload) => {
    const path = request.url.split("?")[0];
    if (request.method !== "POST" || path !== "/v1/stripe/webhook") return payload;
    const chunks: Buffer[] = [];
    for await (const chunk of payload) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    const raw = Buffer.concat(chunks);
    rawBodies.set(request, raw);
    return Readable.from(raw);
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      return reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message },
      });
    }
    const statusCode = typeof error === "object" && error && "statusCode" in error ? error.statusCode : undefined;
    const status = typeof statusCode === "number" ? statusCode : 500;
    const message = error instanceof Error ? error.message : "Internal error";
    if (status >= 500) request.log.error(error);
    return reply.status(status).send({
      error: {
        code: status === 400 ? "bad_request" : "internal_error",
        message: status >= 500 ? "Internal error" : message,
      },
    });
  });

  app.get("/health", async () => ({ status: "ok", service: "botsupply" }));

  app.get("/", async (_request, reply) => {
    return reply.type("text/html; charset=utf-8").send(renderLanding());
  });

  app.post("/v1/wallets", async (request, reply) => {
    const body = asRecord(request.body);
    rejectUnknown(body, ["label"]);
    const { wallet, apiKey } = createWallet(db, readLabel(body));
    return reply.status(201).send({
      wallet_id: wallet.id,
      api_key: apiKey,
      balance_credits: wallet.balance_credits,
      label: wallet.label,
      created_at: wallet.created_at,
    });
  });

  app.post("/v1/wallets/:id/topup", async (request, reply) => {
    if (!stripe.devTopupEnabled) {
      throw new ApiError(
        403,
        "dev_topup_disabled",
        "Development top-up is available only when STRIPE_SECRET_KEY is unset. Use POST /v1/wallets/:id/checkout.",
      );
    }
    const { id } = request.params as { id: string };
    const body = asRecord(request.body);
    rejectUnknown(body, ["credits"]);
    const credits = readCredits(body, 1, MAX_TOPUP);
    const wallet = topUpWallet(db, id, credits);
    if (!wallet) {
      throw new ApiError(404, "not_found", "Wallet not found");
    }
    return reply.send({
      wallet_id: wallet.id,
      credited: credits,
      balance_credits: wallet.balance_credits,
      note: "Development top-up. No payment was collected. This route is disabled once STRIPE_SECRET_KEY is set.",
    });
  });

  app.post("/v1/wallets/:id/checkout", async (request, reply) => {
    if (!stripe.ready) {
      const missing = stripe.devTopupEnabled
        ? ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "PUBLIC_BASE_URL"]
        : stripe.missing;
      throw new ApiError(
        503,
        "stripe_not_configured",
        `Stripe checkout is not configured. Set ${missing.join(", ")}.`,
      );
    }
    const wallet = bearerWallet(db, request);
    const { id } = request.params as { id: string };
    if (wallet.id !== id) {
      throw new ApiError(403, "forbidden", "API key does not match this wallet");
    }
    const body = asRecord(request.body);
    rejectUnknown(body, ["credits"]);
    const credits = readCredits(body, CHECKOUT_MIN_CREDITS, CHECKOUT_MAX_CREDITS);
    const urls = checkoutUrls(stripe.ready.publicBaseUrl);
    let session: { id: string; url: string | null };
    try {
      session = await stripe.ready.gateway.createCheckoutSession({
        walletId: wallet.id,
        credits,
        successUrl: urls.successUrl,
        cancelUrl: urls.cancelUrl,
      });
    } catch (error) {
      request.log.error(error);
      throw new ApiError(502, "stripe_error", "Stripe could not create a Checkout Session");
    }
    if (!session.url) {
      throw new ApiError(502, "stripe_error", "Stripe did not return a Checkout URL");
    }
    return reply.status(201).send({
      checkout_session_id: session.id,
      url: session.url,
      wallet_id: wallet.id,
      credits,
      amount_cents: credits,
      currency: "usd",
    });
  });

  app.post("/v1/stripe/webhook", async (request, reply) => {
    if (!stripe.ready) {
      throw new ApiError(503, "stripe_not_configured", "Stripe webhook is not configured");
    }
    const signature = headerValue(request.headers["stripe-signature"]);
    const raw = rawBodies.get(request);
    if (!signature || !raw) {
      throw new ApiError(400, "invalid_signature", "Missing Stripe signature or body");
    }
    let event: CheckoutCompletedEvent;
    try {
      event = stripe.ready.gateway.constructEvent(raw, signature);
    } catch (error) {
      request.log.error(error);
      throw new ApiError(400, "invalid_signature", "Invalid Stripe signature");
    }
    if (event.type !== "checkout.session.completed") {
      return reply.send({ received: true, credited: false });
    }
    const session = sessionFromEvent(event);
    if (session.paymentStatus !== "paid") {
      return reply.send({ received: true, credited: false });
    }
    const result = applyStripeCheckoutCredit(db, {
      sessionId: session.sessionId,
      walletId: session.walletId,
      credits: session.credits,
    });
    if (!result.ok) {
      throw new ApiError(404, "not_found", "Wallet not found");
    }
    return reply.send({
      received: true,
      credited: result.applied,
      wallet_id: result.wallet_id,
      credits: result.credits,
      balance_credits: result.balance_credits,
      checkout_session_id: result.session_id,
    });
  });

  app.get("/v1/catalog", async () => catalogDocument());

  app.post("/v1/purchase", async (request, reply) => {
    const wallet = bearerWallet(db, request);
    const body = asRecord(request.body);
    rejectUnknown(body, ["sku"]);
    const sku = readSku(body);
    const product = findProduct(sku);
    if (!product) {
      throw new ApiError(404, "unknown_sku", `Unknown sku: ${sku}`);
    }
    const result = purchaseSku(db, wallet.id, product.sku, product.price_credits, product.payload);
    if (!result.ok) {
      throw new ApiError(
        402,
        "insufficient_credits",
        `Need ${product.price_credits} credits, wallet has ${result.balance_credits}.`,
      );
    }
    return reply.status(201).send(publicPurchase(result.purchase, result.balance_credits));
  });

  app.get("/v1/purchases/:id", async (request) => {
    const wallet = bearerWallet(db, request);
    const { id } = request.params as { id: string };
    const purchase = findPurchase(db, id);
    if (!purchase || purchase.wallet_id !== wallet.id) {
      throw new ApiError(404, "not_found", "Purchase not found");
    }
    const current = findWalletById(db, wallet.id);
    return publicPurchase(purchase, current?.balance_credits ?? wallet.balance_credits);
  });

  return app;
}
