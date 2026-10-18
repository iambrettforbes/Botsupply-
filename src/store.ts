import crypto from "node:crypto";
import type { StripeMode } from "./stripe.js";

export type StorageKind = "sqlite" | "postgres";

export type WalletRow = {
  id: string;
  api_key_hash: string;
  balance_credits: number;
  label: string | null;
  created_at: string;
};

export type PurchaseRow = {
  id: string;
  wallet_id: string;
  sku: string;
  credits_charged: number;
  payload_json: string;
  created_at: string;
};

export type CheckoutSessionRow = {
  session_id: string;
  wallet_id: string;
  credits: number;
  url: string;
};

export type PurchaseResult =
  | { ok: true; purchase: PurchaseRow; balance_credits: number }
  | { ok: false; balance_credits: number };

export type ApplyStripeCreditResult =
  | {
      ok: true;
      applied: boolean;
      balance_credits: number;
      wallet_id: string;
      credits: number;
      session_id: string;
    }
  | { ok: false; code: "wallet_not_found" | "invalid_credit" };

export type CheckoutSessionSave = {
  sessionId: string;
  walletId: string;
  credits: number;
  url: string;
};

export type StripeCreditInput = {
  sessionId: string;
  walletId: string;
  credits: number;
};

/**
 * Persistence for wallets, purchases, and Checkout rows.
 * Every read and write is limited to `mode` (dev, test, or live).
 */
export type Store = {
  kind: StorageKind;
  mode: StripeMode;
  ping(): Promise<void>;
  close(): Promise<void>;
  createWallet(label: string | null): Promise<{ wallet: WalletRow; apiKey: string }>;
  findWalletById(id: string): Promise<WalletRow | undefined>;
  findWalletByApiKey(apiKey: string): Promise<WalletRow | undefined>;
  topUpWallet(id: string, credits: number): Promise<WalletRow | undefined>;
  purchaseSku(
    walletId: string,
    sku: string,
    priceCredits: number,
    payload: Record<string, unknown>,
  ): Promise<PurchaseResult>;
  findPurchase(id: string): Promise<PurchaseRow | undefined>;
  saveCheckoutSessionUrl(input: CheckoutSessionSave): Promise<void>;
  findCheckoutSessionUrl(sessionId: string): Promise<CheckoutSessionRow | undefined>;
  applyStripeCheckoutCredit(input: StripeCreditInput): Promise<ApplyStripeCreditResult>;
};

export function hashApiKey(apiKey: string): string {
  return crypto.createHash("sha256").update(apiKey).digest("hex");
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}

export function newApiKey(): string {
  return `bsk_${crypto.randomBytes(24).toString("hex")}`;
}

export function mapWallet(row: {
  id: string;
  api_key_hash: string;
  balance_credits: number | string;
  label: string | null;
  created_at: string | Date;
}): WalletRow {
  return {
    id: row.id,
    api_key_hash: row.api_key_hash,
    balance_credits: Number(row.balance_credits),
    label: row.label,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

export function mapPurchase(row: {
  id: string;
  wallet_id: string;
  sku: string;
  credits_charged: number | string;
  payload_json: string;
  created_at: string | Date;
}): PurchaseRow {
  return {
    id: row.id,
    wallet_id: row.wallet_id,
    sku: row.sku,
    credits_charged: Number(row.credits_charged),
    payload_json: row.payload_json,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}
