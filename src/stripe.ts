import Stripe from "stripe";

/** 1 credit = 1 cent = $0.01 USD. */
export const CENTS_PER_CREDIT = 1;
export const CHECKOUT_MIN_CREDITS = 100;
export const CHECKOUT_MAX_CREDITS = 100_000;

export type StripeConfig = {
  publicBaseUrl: string;
  gateway: StripeGateway;
};

export type ResolvedStripe = {
  /** Free POST /topup. True only when STRIPE_SECRET_KEY is unset. */
  devTopupEnabled: boolean;
  missing: string[];
  ready: StripeConfig | null;
};

export type CheckoutSessionInput = {
  walletId: string;
  credits: number;
  successUrl: string;
  cancelUrl: string;
};

export type CheckoutCompletedEvent = {
  type: string;
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
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        client_reference_id: input.walletId,
        metadata: {
          wallet_id: input.walletId,
          credits: String(input.credits),
        },
        line_items: [checkoutLineItem(input.credits)],
      });
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

/** Reads Stripe settings. An empty string counts as unset. No secrets are logged. */
export function stripeFromEnv(env: NodeJS.ProcessEnv = process.env): ResolvedStripe {
  const secretKey = trimmed(env, "STRIPE_SECRET_KEY");
  if (!secretKey) {
    return { devTopupEnabled: true, missing: [], ready: null };
  }
  const webhookSecret = trimmed(env, "STRIPE_WEBHOOK_SECRET");
  const publicBaseUrl = trimmed(env, "PUBLIC_BASE_URL").replace(/\/$/, "");
  const missing: string[] = [];
  if (!webhookSecret) missing.push("STRIPE_WEBHOOK_SECRET");
  if (!publicBaseUrl) missing.push("PUBLIC_BASE_URL");
  if (missing.length > 0) {
    return { devTopupEnabled: false, missing, ready: null };
  }
  return {
    devTopupEnabled: false,
    missing: [],
    ready: {
      publicBaseUrl,
      gateway: createStripeGateway(secretKey, webhookSecret),
    },
  };
}
