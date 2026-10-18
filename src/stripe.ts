import Stripe from "stripe";

/** 1 credit = 1 cent = $0.01 USD. */
export const CENTS_PER_CREDIT = 1;
/** Minimum paid top-up: $5. */
export const CHECKOUT_MIN_CREDITS = 500;
export const CHECKOUT_MAX_CREDITS = 100_000;

/** Storage partition. `dev` when no Stripe secret is set; otherwise the key prefix. */
export type StripeMode = "dev" | "test" | "live";

export type StripeConfig = {
  publicBaseUrl: string;
  gateway: StripeGateway;
};

export type ResolvedStripe = {
  /** Free POST /topup. True only when STRIPE_SECRET_KEY is unset. */
  devTopupEnabled: boolean;
  missing: string[];
  ready: StripeConfig | null;
  mode: StripeMode;
};

export type CheckoutSessionInput = {
  walletId: string;
  credits: number;
  successUrl: string;
  cancelUrl: string;
};

export type CheckoutCompletedEvent = {
  type: string;
  /** Stripe sets this on every event. `true` is live mode. */
  livemode?: boolean;
  data: {
    object: {
      id?: string;
      payment_status?: string | null;
      metadata?: Record<string, string> | null;
    };
  };
};

export type StripeGateway = {
  createCheckoutSession(input: CheckoutSessionInput): Promise<{ id: string; url: string | null }>;
  constructEvent(payload: Buffer | string, signature: string): CheckoutCompletedEvent;
};

export function checkoutLineItem(credits: number): Stripe.Checkout.SessionCreateParams.LineItem {
  return {
    quantity: credits,
    price_data: {
      currency: "usd",
      unit_amount: CENTS_PER_CREDIT,
      product_data: {
        name: "BotSupply credit",
        description: "1 credit = $0.01 USD",
      },
    },
  };
}

/** Hosted Checkout params. `ui_mode` must be `hosted_page` or Stripe omits a usable `url`. */
export function checkoutSessionParams(input: CheckoutSessionInput): Stripe.Checkout.SessionCreateParams {
  return {
    mode: "payment",
    ui_mode: "hosted_page",
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    client_reference_id: input.walletId,
    metadata: {
      wallet_id: input.walletId,
      credits: String(input.credits),
    },
    line_items: [checkoutLineItem(input.credits)],
  };
}

/**
 * Hosted Checkout URLs are incomplete without the `#...` fragment.
 * Opening the session id alone shows Stripe's "This link is incomplete" page.
 */
export function hostedCheckoutUrl(url: string | null | undefined): string | null {
  if (!url || !url.startsWith("https://") || !url.includes("#")) return null;
  return url;
}

export function checkoutUrls(publicBaseUrl: string): { successUrl: string; cancelUrl: string } {
  const base = publicBaseUrl.replace(/\/$/, "");
  return {
    successUrl: `${base}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${base}/?checkout=cancel`,
  };
}

export function createStripeGateway(secretKey: string, webhookSecret: string): StripeGateway {
  const stripe = new Stripe(secretKey);
  return {
    async createCheckoutSession(input) {
      const session = await stripe.checkout.sessions.create(checkoutSessionParams(input));
      return { id: session.id, url: session.url };
    },
    constructEvent(payload, signature) {
      const event = stripe.webhooks.constructEvent(payload, signature, webhookSecret);
      return event as CheckoutCompletedEvent;
    },
  };
}

function trimmed(env: NodeJS.ProcessEnv, key: string): string {
  return env[key]?.trim() ?? "";
}

/** `dev` when the secret is unset. Test and live follow the Stripe key prefix. */
export function stripeModeFromSecret(secretKey: string): StripeMode {
  const key = secretKey.trim();
  if (!key) return "dev";
  if (key.startsWith("sk_live_") || key.startsWith("rk_live_")) return "live";
  if (key.startsWith("sk_test_") || key.startsWith("rk_test_")) return "test";
  throw new Error("STRIPE_SECRET_KEY must start with sk_test_, rk_test_, sk_live_, or rk_live_");
}

/**
 * Webhook events carry Stripe's livemode flag. Test keys accept livemode false.
 * Live keys accept livemode true. A missing flag is left for the caller to process.
 */
export function eventMatchesStripeMode(mode: StripeMode, livemode: boolean | undefined): boolean {
  if (typeof livemode !== "boolean") return true;
  if (mode === "live") return livemode;
  return !livemode;
}

/** Reads Stripe settings. An empty string counts as unset. No secrets are logged. */
export function stripeFromEnv(env: NodeJS.ProcessEnv = process.env): ResolvedStripe {
  const secretKey = trimmed(env, "STRIPE_SECRET_KEY");
  const mode = stripeModeFromSecret(secretKey);
  if (!secretKey) {
    return { devTopupEnabled: true, missing: [], ready: null, mode };
  }
  const webhookSecret = trimmed(env, "STRIPE_WEBHOOK_SECRET");
  const publicBaseUrl = trimmed(env, "PUBLIC_BASE_URL").replace(/\/$/, "");
  const missing: string[] = [];
  if (!webhookSecret) missing.push("STRIPE_WEBHOOK_SECRET");
  if (!publicBaseUrl) missing.push("PUBLIC_BASE_URL");
  if (missing.length > 0) {
    return { devTopupEnabled: false, missing, ready: null, mode };
  }
  return {
    devTopupEnabled: false,
    missing: [],
    mode,
    ready: {
      publicBaseUrl,
      gateway: createStripeGateway(secretKey, webhookSecret),
    },
  };
}
