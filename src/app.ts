import { Readable } from "node:stream";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { type ApprovalNotifier, approvalNotifierFromEnv } from "./approval-notifier.js";
import { catalogDocument, findProduct } from "./catalog.js";
import { renderConfirmForm, renderConfirmMessage, renderConfirmResult } from "./confirm-page.js";
import { type ConfirmationWebhook, liveConfirmationWebhook } from "./confirmation-webhook.js";
import { openStore, type JobRow, type SettleJobResult, type Store, type WalletRow } from "./db.js";
import {
  ESCROW_AMOUNT_MAX,
  ESCROW_DESCRIPTION_MAX,
  ESCROW_IDEMPOTENCY_MAX,
  readEscrowFeeBps,
} from "./escrow.js";
import { ApiError } from "./errors.js";
import { renderLanding, type LandingQuery } from "./landing.js";
import { mountMcp } from "./mcp.js";
import { renderReceiptPage } from "./receipt-page.js";
import {
  CONFIRM_RATE_LIMIT_MAX,
  CONFIRM_RATE_WINDOW_MS,
  RECEIPT_RATE_LIMIT_MAX,
  RECEIPT_RATE_WINDOW_MS,
  clientIp,
  createRateLimiter,
  parseApprovalBody,
  parsePaymentBody,
  parseProofBody,
  publicApproverConfirmation,
  readConfirmThreshold,
  readConfirmTtlMs,
  redactConfirmToken,
  resolveReceiptSigningKey,
  toPublicReceipt,
  verifyReceiptRecord,
} from "./receipts.js";
import {
  CHECKOUT_MAX_CREDITS,
  CHECKOUT_MIN_CREDITS,
  checkoutUrls,
  eventMatchesStripeMode,
  hostedCheckoutUrl,
  stripeFromEnv,
  type CheckoutCompletedEvent,
  type ResolvedStripe,
  type StripeConfig,
  type StripeMode,
} from "./stripe.js";

export type BuildOptions = {
  /** SQLite file, or `:memory:`. Ignored when `databaseUrl` is set. */
  sqlitePath?: string;
  /** Postgres connection string. When set, this process does not open SQLite. */
  databaseUrl?: string;
  /** Overrides the mode derived from the Stripe secret. */
  mode?: StripeMode;
  logger?: boolean;
  /** Omit to read Stripe settings from the environment. */
  stripe?: ResolvedStripe;
  /** Overrides `ESCROW_FEE_BPS`. Basis points withheld from the payee on release. Default 0. */
  escrowFeeBps?: number;
  /** Overrides `RECEIPT_SIGNING_KEY` for receipt HMAC signatures. */
  receiptSigningKey?: string;
  /** Overrides the per-IP limit on `POST /v1/receipts`. */
  receiptRateLimit?: { max: number; windowMs: number };
  /** Life of a confirm link. Overrides `RECEIPT_CONFIRM_TTL_SECONDS`. */
  confirmTtlMs?: number;
  /** Price-cap units at or above which a receipt with no email approver contact cannot be paid. Overrides `RECEIPT_CONFIRM_THRESHOLD`. */
  confirmThreshold?: string;
  /** Overrides the per-IP limit on `/c/:token`. */
  confirmRateLimit?: { max: number; windowMs: number };
  /** Overrides the env email notifier. Unconfigured notifiers do not send. */
  approvalNotifier?: ApprovalNotifier;
  /** Overrides the confirmation webhook POST. Failures must not throw. */
  confirmationWebhook?: ConfirmationWebhook;
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

function readBoundedString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") {
    throw new ApiError(400, "bad_request", `${field} must be a string of 1 to ${max} characters`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) {
    throw new ApiError(400, "bad_request", `${field} must be a string of 1 to ${max} characters`);
  }
  return trimmed;
}

function readAmountCredits(body: Record<string, unknown>): number {
  const amount = body.amount_credits;
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 1 || amount > ESCROW_AMOUNT_MAX) {
    throw new ApiError(400, "bad_request", `amount_credits must be an integer from 1 to ${ESCROW_AMOUNT_MAX}`);
  }
  return amount;
}

function readSku(body: Record<string, unknown>): string {
  if (typeof body.sku !== "string" || body.sku.trim().length === 0 || body.sku.length > 80) {
    throw new ApiError(400, "bad_request", "sku must be a non-empty string");
  }
  return body.sku;
}

async function bearerWallet(store: Store, request: FastifyRequest): Promise<WalletRow> {
  const header = request.headers.authorization;
  if (!header) {
    throw new ApiError(401, "unauthorized", "Missing Authorization bearer token");
  }
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match?.[1]) {
    throw new ApiError(401, "unauthorized", "Authorization must be a Bearer token");
  }
  const wallet = await store.findWalletByApiKey(match[1]);
  if (!wallet) {
    throw new ApiError(401, "unauthorized", "Invalid API key");
  }
  return wallet;
}

function publicJob(
  job: JobRow,
  balances: { payer_balance_credits: number; payee_balance_credits: number },
  replay: boolean,
) {
  return {
    job_id: job.id,
    status: job.status,
    payer_wallet_id: job.payer_wallet_id,
    payee_wallet_id: job.payee_wallet_id,
    amount_credits: job.amount_credits,
    fee_bps: job.fee_bps,
    fee_credits: job.fee_credits,
    payee_credits: job.status === "released" ? job.amount_credits - job.fee_credits : 0,
    description: job.description,
    idempotency_key: job.idempotency_key,
    created_at: job.created_at,
    updated_at: job.updated_at,
    payer_balance_credits: balances.payer_balance_credits,
    payee_balance_credits: balances.payee_balance_credits,
    ...(replay ? { idempotent_replay: true } : {}),
  };
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

function readPayCredits(raw: string | undefined): number {
  if (raw == null || raw === "") return CHECKOUT_MIN_CREDITS;
  if (!/^\d+$/.test(raw)) {
    throw new ApiError(
      400,
      "bad_request",
      `credits must be an integer from ${CHECKOUT_MIN_CREDITS} to ${CHECKOUT_MAX_CREDITS}`,
    );
  }
  return readCredits({ credits: Number(raw) }, CHECKOUT_MIN_CREDITS, CHECKOUT_MAX_CREDITS);
}

function redirectToCheckout(reply: FastifyReply, url: string) {
  return reply.header("location", url).code(302).send();
}

async function openHostedCheckout(
  request: FastifyRequest,
  ready: StripeConfig,
  store: Store,
  input: { walletId: string; credits: number; successUrl: string; cancelUrl: string },
) {
  let session: { id: string; url: string | null };
  try {
    session = await ready.gateway.createCheckoutSession(input);
  } catch (error) {
    request.log.error(error);
    throw new ApiError(502, "stripe_error", "Stripe could not create a Checkout Session");
  }
  const stripeUrl = hostedCheckoutUrl(session.url);
  if (!stripeUrl) {
    throw new ApiError(
      502,
      "incomplete_checkout_url",
      "Stripe returned a Checkout URL without the hosted-page fragment",
    );
  }
  await store.saveCheckoutSessionUrl({
    sessionId: session.id,
    walletId: input.walletId,
    credits: input.credits,
    url: stripeUrl,
  });
  return {
    sessionId: session.id,
    stripeUrl,
    payUrl: `${ready.publicBaseUrl}/v1/pay/s/${encodeURIComponent(session.id)}`,
  };
}

export async function buildApp(options: BuildOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger
      ? {
          serializers: {
            req(request) {
              return {
                method: request.method,
                url: redactConfirmToken(request.url),
                hostname: request.hostname,
                remoteAddress: request.ip,
              };
            },
          },
        }
      : false,
  });
  const stripe = options.stripe ?? stripeFromEnv();
  const mode = options.mode ?? stripe.mode;
  const escrowFeeBps = readEscrowFeeBps(process.env.ESCROW_FEE_BPS, options.escrowFeeBps);
  const receiptKey = resolveReceiptSigningKey(options.receiptSigningKey);
  const receiptLimiter = createRateLimiter(
    options.receiptRateLimit?.max ?? RECEIPT_RATE_LIMIT_MAX,
    options.receiptRateLimit?.windowMs ?? RECEIPT_RATE_WINDOW_MS,
  );
  const confirmLimiter = createRateLimiter(
    options.confirmRateLimit?.max ?? CONFIRM_RATE_LIMIT_MAX,
    options.confirmRateLimit?.windowMs ?? CONFIRM_RATE_WINDOW_MS,
  );
  const notifier = options.approvalNotifier ?? approvalNotifierFromEnv();
  const confirmationWebhook = options.confirmationWebhook ?? liveConfirmationWebhook();
  readConfirmTtlMs(process.env.RECEIPT_CONFIRM_TTL_SECONDS, options.confirmTtlMs);
  const confirmThreshold = readConfirmThreshold(process.env.RECEIPT_CONFIRM_THRESHOLD, options.confirmThreshold);
  const store = await openStore({
    databaseUrl: options.databaseUrl,
    sqlitePath: options.sqlitePath ?? ":memory:",
    mode,
    receiptSigningKey: receiptKey,
    confirmTtlMs: options.confirmTtlMs,
  });

  app.addHook("onClose", async () => {
    await store.close();
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

  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => {
      done(null, body);
    },
  );

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

  app.get("/health", async (request, reply) => {
    const report = {
      status: "ok" as "ok" | "error",
      service: "botsupply",
      storage: store.kind,
      mode: store.mode,
      database: "ok" as "ok" | "error",
    };
    try {
      await store.ping();
      return report;
    } catch (error) {
      request.log.error(error);
      report.status = "error";
      report.database = "error";
      return reply.status(503).send(report);
    }
  });

  app.get("/", async (request, reply) => {
    const query = request.query as LandingQuery;
    return reply.type("text/html; charset=utf-8").send(renderLanding(query));
  });

  app.post("/v1/wallets", async (request, reply) => {
    const body = asRecord(request.body);
    rejectUnknown(body, ["label"]);
    const { wallet, apiKey } = await store.createWallet(readLabel(body));
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
    const wallet = await store.topUpWallet(id, credits);
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
    const wallet = await bearerWallet(store, request);
    const { id } = request.params as { id: string };
    if (wallet.id !== id) {
      throw new ApiError(403, "forbidden", "API key does not match this wallet");
    }
    const body = asRecord(request.body);
    rejectUnknown(body, ["credits"]);
    const credits = readCredits(body, CHECKOUT_MIN_CREDITS, CHECKOUT_MAX_CREDITS);
    const urls = checkoutUrls(stripe.ready.publicBaseUrl);
    const opened = await openHostedCheckout(request, stripe.ready, store, {
      walletId: wallet.id,
      credits,
      successUrl: urls.successUrl,
      cancelUrl: urls.cancelUrl,
    });
    return reply.status(201).send({
      checkout_session_id: opened.sessionId,
      url: opened.payUrl,
      stripe_url: opened.stripeUrl,
      wallet_id: wallet.id,
      credits,
      amount_cents: credits,
      currency: "usd",
    });
  });

  app.get("/v1/pay/s/:sessionId", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const saved = await store.findCheckoutSessionUrl(sessionId);
    if (!saved) throw new ApiError(404, "not_found", "Checkout session not found");
    return redirectToCheckout(reply, saved.url);
  });

  app.get("/v1/pay", async (request, reply) => {
    if (!stripe.ready) {
      const missing = stripe.devTopupEnabled
        ? ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "PUBLIC_BASE_URL"]
        : stripe.missing;
      throw new ApiError(503, "stripe_not_configured", `Stripe checkout is not configured. Set ${missing.join(", ")}.`);
    }
    const query = request.query as { credits?: string; wallet_id?: string };
    const credits = readPayCredits(query.credits);
    const urls = checkoutUrls(stripe.ready.publicBaseUrl);
    let walletId = query.wallet_id?.trim() ?? "";
    let successUrl = urls.successUrl;
    if (!walletId) {
      const created = await store.createWallet("pay-link");
      walletId = created.wallet.id;
      const base = stripe.ready.publicBaseUrl;
      successUrl = `${base}/?checkout=success&wallet_id=${encodeURIComponent(created.wallet.id)}&api_key=${encodeURIComponent(created.apiKey)}&session_id={CHECKOUT_SESSION_ID}`;
    } else if (!(await store.findWalletById(walletId))) {
      throw new ApiError(404, "not_found", "Wallet not found");
    }
    const opened = await openHostedCheckout(request, stripe.ready, store, {
      walletId,
      credits,
      successUrl,
      cancelUrl: urls.cancelUrl,
    });
    return redirectToCheckout(reply, opened.stripeUrl);
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
    if (!eventMatchesStripeMode(store.mode, event.livemode)) {
      return reply.send({ received: true, credited: false });
    }
    if (event.type !== "checkout.session.completed") {
      return reply.send({ received: true, credited: false });
    }
    const session = sessionFromEvent(event);
    if (session.paymentStatus !== "paid") {
      return reply.send({ received: true, credited: false });
    }
    const result = await store.applyStripeCheckoutCredit({
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

  app.get("/v1/balance", async (request) => {
    const wallet = await bearerWallet(store, request);
    return {
      wallet_id: wallet.id,
      balance_credits: wallet.balance_credits,
      label: wallet.label,
      created_at: wallet.created_at,
    };
  });

  app.post("/v1/purchase", async (request, reply) => {
    const wallet = await bearerWallet(store, request);
    const body = asRecord(request.body);
    rejectUnknown(body, ["sku"]);
    const sku = readSku(body);
    const product = findProduct(sku);
    if (!product) {
      throw new ApiError(404, "unknown_sku", `Unknown sku: ${sku}`);
    }
    const result = await store.purchaseSku(wallet.id, product.sku, product.price_credits, product.payload);
    if (!result.ok) {
      throw new ApiError(
        402,
        "insufficient_credits",
        `Need ${product.price_credits} credits, wallet has ${result.balance_credits}.`,
      );
    }
    return reply.status(201).send(publicPurchase(result.purchase, result.balance_credits));
  });

  async function partyJob(request: FastifyRequest, id: string): Promise<{ wallet: WalletRow; job: JobRow }> {
    const wallet = await bearerWallet(store, request);
    const job = await store.getJob(id);
    if (!job || (job.payer_wallet_id !== wallet.id && job.payee_wallet_id !== wallet.id)) {
      throw new ApiError(404, "not_found", "Job not found");
    }
    return { wallet, job };
  }

  function settled(result: SettleJobResult, verb: "released" | "refunded"): Extract<SettleJobResult, { ok: true }> {
    if (result.ok) return result;
    if (result.code === "not_found") throw new ApiError(404, "not_found", "Job not found");
    throw new ApiError(409, "job_not_held", `Job is ${result.status}. Only a held job can be ${verb}.`);
  }

  app.post("/v1/jobs", async (request, reply) => {
    const payer = await bearerWallet(store, request);
    const body = asRecord(request.body);
    rejectUnknown(body, ["payee_wallet_id", "amount_credits", "description", "idempotency_key"]);
    const payeeWalletId = readBoundedString(body.payee_wallet_id, "payee_wallet_id", 80);
    const amountCredits = readAmountCredits(body);
    const description = readBoundedString(body.description, "description", ESCROW_DESCRIPTION_MAX);
    const idempotencyKey = readBoundedString(body.idempotency_key, "idempotency_key", ESCROW_IDEMPOTENCY_MAX);
    if (payeeWalletId === payer.id) {
      throw new ApiError(400, "bad_request", "Payer and payee must be different wallets");
    }
    const result = await store.createJob({
      payerWalletId: payer.id,
      payeeWalletId,
      amountCredits,
      description,
      idempotencyKey,
    });
    if (!result.ok) {
      if (result.code === "insufficient_credits") {
        throw new ApiError(402, "insufficient_credits", `Need ${amountCredits} credits, wallet has ${result.balance_credits}.`);
      }
      if (result.code === "wallet_not_found") {
        throw new ApiError(404, "not_found", result.which === "payer" ? "Payer wallet not found" : "Payee wallet not found");
      }
      if (result.code === "same_wallet") {
        throw new ApiError(400, "bad_request", "Payer and payee must be different wallets");
      }
      if (result.code === "invalid_amount") {
        throw new ApiError(400, "bad_request", `amount_credits must be an integer from 1 to ${ESCROW_AMOUNT_MAX}`);
      }
      throw new ApiError(
        409,
        "idempotency_conflict",
        `Idempotency key already used for job ${result.job.id} with different parameters.`,
      );
    }
    return reply.status(result.replay ? 200 : 201).send(publicJob(result.job, result, result.replay));
  });

  app.get("/v1/jobs/:id", async (request) => {
    const { id } = request.params as { id: string };
    const { job } = await partyJob(request, id);
    const payer = await store.findWalletById(job.payer_wallet_id);
    const payee = await store.findWalletById(job.payee_wallet_id);
    return publicJob(
      job,
      {
        payer_balance_credits: payer?.balance_credits ?? 0,
        payee_balance_credits: payee?.balance_credits ?? 0,
      },
      false,
    );
  });

  app.post("/v1/jobs/:id/release", async (request) => {
    const { id } = request.params as { id: string };
    const body = asRecord(request.body);
    rejectUnknown(body, []);
    const { wallet, job } = await partyJob(request, id);
    if (wallet.id !== job.payer_wallet_id) {
      throw new ApiError(403, "forbidden", "Only the payer can release a held job.");
    }
    const result = settled(await store.releaseJob(id, escrowFeeBps), "released");
    return publicJob(result.job, result, false);
  });

  app.post("/v1/jobs/:id/refund", async (request) => {
    const { id } = request.params as { id: string };
    const body = asRecord(request.body);
    rejectUnknown(body, []);
    await partyJob(request, id);
    const result = settled(await store.refundJob(id), "refunded");
    return publicJob(result.job, result, false);
  });

  function publicOrigin(request: FastifyRequest): string {
    const configured = process.env.PUBLIC_BASE_URL?.trim().replace(/\/$/, "") ?? "";
    if (configured) return configured;
    const forwardedHost = headerValue(request.headers["x-forwarded-host"]);
    const host = forwardedHost || headerValue(request.headers.host) || request.hostname;
    const forwardedProto = headerValue(request.headers["x-forwarded-proto"]);
    const proto = forwardedProto || request.protocol || "http";
    return `${proto}://${host}`;
  }

  function receiptUrlFor(request: FastifyRequest, id: string): string {
    return `${publicOrigin(request)}/r/${encodeURIComponent(id)}`;
  }

  function publicReceipt(request: FastifyRequest, receipt: Parameters<typeof toPublicReceipt>[0]) {
    return toPublicReceipt(receipt, receiptUrlFor(request, receipt.id), confirmThreshold);
  }

  function confirmUrlFor(request: FastifyRequest, token: string): string {
    return `${publicOrigin(request)}/c/${encodeURIComponent(token)}`;
  }

  function sendConfirmHtml(reply: FastifyReply, status: number, html: string) {
    return reply
      .status(status)
      .header("cache-control", "no-store")
      .header("referrer-policy", "no-referrer")
      .header("x-robots-tag", "noindex")
      .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'")
      .type("text/html; charset=utf-8")
      .send(html);
  }

  app.post("/v1/receipts", async (request, reply) => {
    const decision = receiptLimiter.take(clientIp(request.headers["x-forwarded-for"], request.ip));
    if (!decision.ok) {
      return reply.status(429).header("retry-after", String(decision.retryAfterSec)).send({
        error: {
          code: "rate_limited",
          message: "Too many receipt approvals from this address. Try again shortly.",
        },
      });
    }
    const body = asRecord(request.body);
    rejectUnknown(body, [
      "approver",
      "approver_contact",
      "agent_id",
      "agent_name",
      "merchant_name",
      "merchant_url",
      "scope",
      "price_cap_amount",
      "price_cap_currency",
      "payment_rail",
      "external_payment_ref",
      "confirmation_webhook_url",
    ]);
    const parsed = parseApprovalBody(body);
    if (!parsed.ok) throw new ApiError(400, "bad_request", parsed.message);
    const created = await store.createReceipt(parsed.value);
    const payload: Record<string, unknown> = {
      ...publicReceipt(request, created.receipt),
      edit_token: created.editToken,
    };
    if (created.confirmation) {
      const confirmUrl = confirmUrlFor(request, created.confirmation.token);
      let delivered = false;
      if (notifier.configured && created.confirmation.channel === "email" && parsed.value.confirmContact) {
        try {
          await notifier.send({
            channel: "email",
            to: parsed.value.confirmContact.address,
            confirmUrl,
            receiptId: created.receipt.id,
            merchantName: created.receipt.merchant_name,
            scope: created.receipt.scope,
            priceCapAmount: created.receipt.price_cap_amount,
            priceCapCurrency: created.receipt.price_cap_currency,
            agentLabel: created.receipt.agent_name ?? created.receipt.agent_id,
            expiresAt: created.confirmation.expiresAt,
          });
          delivered = true;
        } catch (error) {
          request.log.error({ err: error instanceof Error ? error.message : "send failed" }, "approver email failed");
          delivered = false;
        }
      }
      payload.confirm_expires_at = created.confirmation.expiresAt;
      payload.confirm_channel = created.confirmation.channel;
      payload.confirm_contact_masked = created.confirmation.contactMasked;
      payload.confirm_delivery = delivered ? "email" : "caller";
      if (!delivered) payload.confirm_url = confirmUrl;
    }
    return reply.status(201).send(payload);
  });

  app.post("/v1/receipts/:id/proof", async (request) => {
    const { id } = request.params as { id: string };
    const body = asRecord(request.body);
    rejectUnknown(body, ["edit_token", "type", "value", "actual_amount", "status"]);
    const parsed = parseProofBody(body);
    if (!parsed.ok) throw new ApiError(400, "bad_request", parsed.message);
    const result = await store.attachReceiptProof({ ...parsed.value, receiptId: id });
    if (!result.ok) {
      if (result.code === "not_found") throw new ApiError(404, "not_found", "Receipt not found");
      if (result.code === "invalid_edit_token") throw new ApiError(403, "invalid_edit_token", "Edit token is invalid");
      if (result.code === "tampered") {
        throw new ApiError(409, "receipt_tampered", "Receipt no longer matches its hash chain");
      }
      throw new ApiError(409, "invalid_status", "Receipt status cannot move back from disputed");
    }
    return {
      ...publicReceipt(request, result.receipt),
      over_cap: result.over_cap,
    };
  });

  app.post("/v1/receipts/:id/payment", async (request) => {
    const { id } = request.params as { id: string };
    const body = asRecord(request.body);
    rejectUnknown(body, ["edit_token", "external_payment_ref", "amount", "paid_at"]);
    const parsed = parsePaymentBody(body);
    if (!parsed.ok) throw new ApiError(400, "bad_request", parsed.message);
    const result = await store.recordReceiptPayment({ ...parsed.value, receiptId: id });
    if (!result.ok) {
      if (result.code === "not_found") throw new ApiError(404, "not_found", "Receipt not found");
      if (result.code === "invalid_edit_token") throw new ApiError(403, "invalid_edit_token", "Edit token is invalid");
      throw new ApiError(409, "receipt_tampered", "Receipt no longer matches its hash chain");
    }
    return {
      ...publicReceipt(request, result.receipt),
      paid_before_confirmation: result.paid_before_confirmation,
      over_cap: result.over_cap,
    };
  });

  app.get("/v1/receipts/:id/verify", async (request, reply) => {
    const { id } = request.params as { id: string };
    const receipt = await store.getReceipt(id);
    if (!receipt) throw new ApiError(404, "not_found", "Receipt not found");
    reply.header("cache-control", "no-store");
    return verifyReceiptRecord(receipt, receiptKey);
  });

  app.get("/v1/receipts/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const receipt = await store.getReceipt(id);
    if (!receipt) throw new ApiError(404, "not_found", "Receipt not found");
    reply.header("cache-control", "no-store");
    return publicReceipt(request, receipt);
  });

  function confirmLimited(request: FastifyRequest, reply: FastifyReply): boolean {
    const decision = confirmLimiter.take(clientIp(request.headers["x-forwarded-for"], request.ip));
    if (decision.ok) return false;
    reply.header("retry-after", String(decision.retryAfterSec));
    void sendConfirmHtml(
      reply,
      429,
      renderConfirmMessage("Too many attempts", "Too many confirmation attempts from this address. Try again shortly."),
    );
    return true;
  }

  function agentLabel(receipt: { agent_name: string | null; agent_id: string | null }): string {
    const parts = [receipt.agent_name, receipt.agent_id].filter((part) => part && part.length > 0);
    return parts.length > 0 ? parts.join(" · ") : "Not recorded";
  }

  app.get("/c/:token", async (request, reply) => {
    if (confirmLimited(request, reply)) return;
    const { token } = request.params as { token: string };
    const found = await store.readConfirmation(token);
    if (!found.ok) {
      return sendConfirmHtml(reply, 404, renderConfirmMessage("Link not valid", "This confirmation link is not valid."));
    }
    const view = found.confirmation;
    if (view.state === "expired") {
      return sendConfirmHtml(reply, 410, renderConfirmMessage("Link expired", "This confirmation link has expired."));
    }
    if (view.state === "used") {
      const how = view.decision === "declined" ? "decline" : "confirm";
      return sendConfirmHtml(
        reply,
        409,
        renderConfirmMessage("Link already used", `This confirmation link was already used to ${how} this receipt.`),
      );
    }
    return sendConfirmHtml(
      reply,
      200,
      renderConfirmForm({
        token,
        scope: view.receipt.scope,
        priceCapAmount: view.receipt.price_cap_amount,
        priceCapCurrency: view.receipt.price_cap_currency,
        merchantName: view.receipt.merchant_name,
        agentLabel: agentLabel(view.receipt),
        expiresAt: view.expiresAt,
      }),
    );
  });

  async function postDecision(request: FastifyRequest, reply: FastifyReply, decision: "confirm" | "decline") {
    if (confirmLimited(request, reply)) return;
    const { token } = request.params as { token: string };
    const result = await store.decideConfirmation(token, decision);
    if (!result.ok) {
      if (result.code === "expired") {
        return sendConfirmHtml(reply, 410, renderConfirmMessage("Link expired", "This confirmation link has expired."));
      }
      if (result.code === "used" || result.code === "already_decided") {
        const again = await store.readConfirmation(token);
        const prior = again.ok ? again.confirmation.decision : null;
        const how = prior === "declined" ? "decline" : prior === "confirmed" ? "confirm" : "record a decision on";
        const message =
          result.code === "already_decided" && !prior
            ? "This receipt already has a confirmation decision."
            : `This confirmation link was already used to ${how} this receipt.`;
        return sendConfirmHtml(reply, 409, renderConfirmMessage("Link already used", message));
      }
      if (result.code === "tampered") {
        return sendConfirmHtml(
          reply,
          409,
          renderConfirmMessage(
            "Receipt cannot be confirmed",
            "This receipt no longer matches its record, so it cannot be confirmed or declined.",
          ),
        );
      }
      return sendConfirmHtml(reply, 404, renderConfirmMessage("Link not valid", "This confirmation link is not valid."));
    }
    if (result.webhookUrl) {
      try {
        await confirmationWebhook.post(result.webhookUrl, {
          receipt_id: result.receipt.id,
          approver_confirmation: publicApproverConfirmation(result.receipt),
        });
      } catch (error) {
        request.log.error({ err: error instanceof Error ? error.message : "webhook failed" }, "confirmation webhook failed");
      }
    }
    return sendConfirmHtml(
      reply,
      200,
      renderConfirmResult(decision === "confirm" ? "confirmed" : "declined", `/r/${encodeURIComponent(result.receipt.id)}`),
    );
  }

  app.post("/c/:token/confirm", async (request, reply) => postDecision(request, reply, "confirm"));
  app.post("/c/:token/decline", async (request, reply) => postDecision(request, reply, "decline"));

  app.get("/r/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const receipt = await store.getReceipt(id);
    if (!receipt) throw new ApiError(404, "not_found", "Receipt not found");
    const verification = verifyReceiptRecord(receipt, receiptKey);
    reply.header("cache-control", "no-store");
    return reply
      .type("text/html; charset=utf-8")
      .send(renderReceiptPage(publicReceipt(request, receipt), verification));
  });

  app.get("/v1/purchases/:id", async (request) => {
    const wallet = await bearerWallet(store, request);
    const { id } = request.params as { id: string };
    const purchase = await store.findPurchase(id);
    if (!purchase || purchase.wallet_id !== wallet.id) {
      throw new ApiError(404, "not_found", "Purchase not found");
    }
    const current = await store.findWalletById(wallet.id);
    return publicPurchase(purchase, current?.balance_credits ?? wallet.balance_credits);
  });

  mountMcp(app);

  return app;
}
