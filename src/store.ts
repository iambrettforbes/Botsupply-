import crypto from "node:crypto";
import type { AttachProofInput, ContactChannel, CreateReceiptInput, ReceiptRecord, RecordPaymentInput } from "./receipts.js";
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

export type JobStatus = "held" | "released" | "refunded";

export type JobRow = {
  id: string;
  payer_wallet_id: string;
  payee_wallet_id: string;
  amount_credits: number;
  description: string;
  status: JobStatus;
  idempotency_key: string;
  /** Basis points applied when the job was released. 0 while held or refunded. */
  fee_bps: number;
  /** Credits withheld from the payee on release. Not credited to any wallet. */
  fee_credits: number;
  created_at: string;
  updated_at: string;
};

export type CreateJobInput = {
  payerWalletId: string;
  payeeWalletId: string;
  amountCredits: number;
  description: string;
  idempotencyKey: string;
};

export type JobBalances = {
  payer_balance_credits: number;
  payee_balance_credits: number;
};

export type CreateJobResult =
  | ({ ok: true; job: JobRow; replay: boolean } & JobBalances)
  | { ok: false; code: "insufficient_credits"; balance_credits: number }
  | { ok: false; code: "wallet_not_found"; which: "payer" | "payee" }
  | { ok: false; code: "same_wallet" }
  | { ok: false; code: "invalid_amount" }
  | { ok: false; code: "idempotency_conflict"; job: JobRow };

export type SettleJobResult =
  | ({ ok: true; job: JobRow } & JobBalances)
  | { ok: false; code: "not_found" }
  | { ok: false; code: "not_held"; status: JobStatus };

export type IssuedConfirmation = {
  token: string;
  expiresAt: string;
  channel: "email";
  contactMasked: string;
};

export type CreateReceiptResult = {
  receipt: ReceiptRecord;
  editToken: string;
  /** Plaintext confirm token, returned once. Null when no email contact was supplied. */
  confirmation: IssuedConfirmation | null;
};

export type AttachReceiptResult =
  | { ok: true; receipt: ReceiptRecord; over_cap: boolean }
  | { ok: false; code: "not_found" | "invalid_edit_token" | "invalid_status" | "tampered" };

export type RecordPaymentResult =
  | { ok: true; receipt: ReceiptRecord; paid_before_confirmation: boolean; over_cap: boolean }
  | { ok: false; code: "not_found" | "invalid_edit_token" | "tampered" };

export type ConfirmationView = {
  state: "open" | "used" | "expired";
  receipt: ReceiptRecord;
  channel: ContactChannel;
  contactMasked: string;
  expiresAt: string;
  decision: "confirmed" | "declined" | null;
  webhookUrl: string | null;
};

export type ReadConfirmationResult =
  | { ok: true; confirmation: ConfirmationView }
  | { ok: false; code: "not_found" };

export type DecideConfirmationResult =
  | { ok: true; receipt: ReceiptRecord; webhookUrl: string | null }
  | { ok: false; code: "not_found" | "expired" | "used" | "tampered" | "already_decided" };

/**
 * Persistence for wallets, purchases, Checkout rows, escrow jobs, and purchase receipts.
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
  /**
   * Debit the payer and insert a held job. Idempotency keys are unique per mode and payer.
   * A repeat with the same parameters returns the existing job and does not debit again.
   */
  createJob(input: CreateJobInput): Promise<CreateJobResult>;
  /** Job in this store's mode, or undefined when the id is missing or belongs to another mode. */
  getJob(id: string): Promise<JobRow | undefined>;
  /** Credit the payee from a held job. `feeBps` is withheld from the payee and recorded on the job. */
  releaseJob(id: string, feeBps: number): Promise<SettleJobResult>;
  /** Return the full held amount to the payer. */
  refundJob(id: string): Promise<SettleJobResult>;
  /** Insert an approved receipt and its first hash-chain event. The edit token is returned once. */
  createReceipt(input: CreateReceiptInput): Promise<CreateReceiptResult>;
  /** Receipt in this store's mode, or undefined when the id is missing or belongs to another mode. */
  getReceipt(id: string): Promise<ReceiptRecord | undefined>;
  /** Append proof and a chain event when the edit token matches and the stored row still verifies. */
  attachReceiptProof(input: AttachProofInput): Promise<AttachReceiptResult>;
  /**
   * Append a payment_recorded event when the edit token matches and the stored row still verifies.
   * Early and over-cap payments are stored and flagged. They are not rejected.
   */
  recordReceiptPayment(input: RecordPaymentInput): Promise<RecordPaymentResult>;
  /** Read a confirm link without changing it. GET must not confirm. */
  readConfirmation(token: string): Promise<ReadConfirmationResult>;
  /** Record Confirm or Decline once. Expired and used tokens are refused. */
  decideConfirmation(token: string, decision: "confirm" | "decline"): Promise<DecideConfirmationResult>;
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

export function mapJob(row: {
  id: string;
  payer_wallet_id: string;
  payee_wallet_id: string;
  amount_credits: number | string;
  description: string;
  status: string;
  idempotency_key: string;
  fee_bps: number | string;
  fee_credits: number | string;
  created_at: string | Date;
  updated_at: string | Date;
}): JobRow {
  const status = row.status;
  if (status !== "held" && status !== "released" && status !== "refunded") {
    throw new Error(`Unexpected job status: ${status}`);
  }
  const created = row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at;
  const updated = row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at;
  return {
    id: row.id,
    payer_wallet_id: row.payer_wallet_id,
    payee_wallet_id: row.payee_wallet_id,
    amount_credits: Number(row.amount_credits),
    description: row.description,
    status,
    idempotency_key: row.idempotency_key,
    fee_bps: Number(row.fee_bps),
    fee_credits: Number(row.fee_credits),
    created_at: created,
    updated_at: updated,
  };
}

export function sameJobRequest(job: JobRow, input: CreateJobInput): boolean {
  return (
    job.payer_wallet_id === input.payerWalletId &&
    job.payee_wallet_id === input.payeeWalletId &&
    job.amount_credits === input.amountCredits &&
    job.description === input.description &&
    job.idempotency_key === input.idempotencyKey
  );
}

/** Lock the lower wallet id first so opposite-direction jobs cannot deadlock. */
export function lockWalletIds(left: string, right: string): [string, string] {
  return left < right ? [left, right] : [right, left];
}

export function isUniqueConstraint(error: unknown): boolean {
  if (typeof error !== "object" || error == null || !("code" in error)) return false;
  const code = String((error as { code: unknown }).code);
  return code === "SQLITE_CONSTRAINT_UNIQUE" || code === "23505";
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
