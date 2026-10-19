import crypto from "node:crypto";
import type { StripeMode } from "./stripe.js";

/** Approvals accepted per IP per window. `record_approval` is unauthenticated. */
export const RECEIPT_RATE_LIMIT_MAX = 30;

export const RECEIPT_RATE_WINDOW_MS = 60_000;

export const RECEIPT_APPROVER_MAX = 120;
export const RECEIPT_CONTACT_MAX = 320;
export const RECEIPT_AGENT_MAX = 120;
export const RECEIPT_MERCHANT_MAX = 160;
export const RECEIPT_URL_MAX = 500;
export const RECEIPT_SCOPE_MAX = 2_000;
export const RECEIPT_RAIL_MAX = 64;
export const RECEIPT_REF_MAX = 200;
export const RECEIPT_PROOF_TYPE_MAX = 64;
export const RECEIPT_PROOF_VALUE_MAX = 2_000;

export type ReceiptStatus = "approved" | "delivered" | "disputed";

export type ReceiptProof = {
  id: string;
  proof_index: number;
  type: string;
  value: string;
  actual_amount: string | null;
  over_cap: boolean;
  attached_at: string;
};

export type ReceiptEvent = {
  id: string;
  seq: number;
  kind: "approved" | "proof_attached";
  prev_hash: string;
  hash: string;
  payload_json: string;
  created_at: string;
};

/** Full stored receipt, including fields that never leave the server. */
export type ReceiptRecord = {
  id: string;
  mode: StripeMode;
  created_at: string;
  updated_at: string;
  approver_name: string;
  approver_contact_hash: string | null;
  agent_id: string | null;
  agent_name: string | null;
  merchant_name: string;
  merchant_url: string | null;
  scope: string;
  price_cap_amount: string;
  price_cap_currency: string;
  payment_rail: string;
  external_payment_ref: string | null;
  status: ReceiptStatus;
  content_hash: string;
  signature: string;
  edit_token_hash: string;
  proofs: ReceiptProof[];
  events: ReceiptEvent[];
};

export type PublicProof = {
  type: string;
  value: string;
  actual_amount: string | null;
  over_cap: boolean;
  attached_at: string;
};

export type PublicTimelineEntry = {
  seq: number;
  kind: "approved" | "proof_attached";
  at: string;
  prev_hash: string;
  hash: string;
};

/** JSON returned by the public receipt routes. No contact and no edit token. */
export type PublicReceipt = {
  receipt_id: string;
  receipt_url: string;
  mode: StripeMode;
  status: ReceiptStatus;
  created_at: string;
  updated_at: string;
  approver: string;
  agent_id: string | null;
  agent_name: string | null;
  merchant: { name: string; url: string | null };
  scope: string;
  price_cap: { amount: string; currency: string };
  payment_rail: string;
  external_payment_ref: string | null;
  proofs: PublicProof[];
  content_hash: string;
  timeline: PublicTimelineEntry[];
};

export type CreateReceiptInput = {
  approverName: string;
  approverContactHash: string | null;
  agentId: string | null;
  agentName: string | null;
  merchantName: string;
  merchantUrl: string | null;
  scope: string;
  priceCapAmount: string;
  priceCapCurrency: string;
  paymentRail: string;
  externalPaymentRef: string | null;
};

export type AttachProofInput = {
  receiptId: string;
  editToken: string;
  type: string;
  value: string;
  actualAmount: string | null;
  /** Omitted: approved becomes delivered, and a later status stays as it is. */
  status?: "delivered" | "disputed";
};

export type VerifyChecks = {
  chain: boolean;
  content: boolean;
  signature: boolean;
};

export type VerifyResult = {
  valid: boolean;
  receipt_id: string;
  content_hash: string;
  checks: VerifyChecks;
};

type SnapshotProof = {
  proof_id: string;
  proof_index: number;
  type: string;
  value: string;
  actual_amount: string | null;
  over_cap: boolean;
  attached_at: string;
};

/** Canonical receipt body. Excludes the content hash, the signature, and the edit token plaintext. */
export type ReceiptSnapshot = {
  receipt_id: string;
  mode: StripeMode;
  created_at: string;
  updated_at: string;
  approver: string;
  approver_contact_hash: string | null;
  edit_token_hash: string;
  agent_id: string | null;
  agent_name: string | null;
  merchant_name: string;
  merchant_url: string | null;
  scope: string;
  price_cap_amount: string;
  price_cap_currency: string;
  payment_rail: string;
  external_payment_ref: string | null;
  status: ReceiptStatus;
  proofs: SnapshotProof[];
};

type ChainEventBody = {
  seq: number;
  kind: "approved" | "proof_attached";
  prev_hash: string;
  snapshot: ReceiptSnapshot;
};

export type PlannedReceipt = {
  record: ReceiptRecord;
  editToken: string;
  event: ReceiptEvent;
};

export type PlanProofResult =
  | {
      ok: true;
      proof: ReceiptProof;
      event: ReceiptEvent;
      status: ReceiptStatus;
      contentHash: string;
      signature: string;
      updatedAt: string;
      overCap: boolean;
    }
  | { ok: false; code: "invalid_edit_token" | "invalid_status" | "tampered" };

const AMOUNT_RE = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,8})?$/;
const CURRENCY_RE = /^[A-Za-z]{3,10}$/;

let ephemeralKey: Buffer | undefined;

/**
 * HMAC key for the current receipt hash.
 * `RECEIPT_SIGNING_KEY` when set. Otherwise one random key for this process, with a warning.
 */
export function loadReceiptSigningKey(): Buffer {
  const raw = process.env.RECEIPT_SIGNING_KEY?.trim() ?? "";
  if (raw.length > 0) return Buffer.from(raw, "utf8");
  if (!ephemeralKey) {
    ephemeralKey = crypto.randomBytes(32);
    console.warn(
      "RECEIPT_SIGNING_KEY is unset. Using an ephemeral receipt signing key. Signatures will not verify after this process restarts. Set RECEIPT_SIGNING_KEY to a long random secret.",
    );
  }
  return ephemeralKey;
}

export function resolveReceiptSigningKey(override?: string): Buffer {
  if (override === undefined) return loadReceiptSigningKey();
  const text = override.trim();
  if (!text) throw new Error("receiptSigningKey must be a non-empty string");
  return Buffer.from(text, "utf8");
}

export function hashApproverContact(contact: string): string {
  return crypto.createHash("sha256").update(contact.trim().toLowerCase()).digest("hex");
}

export function hashEditToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function editTokenMatches(storedHash: string, token: string): boolean {
  const got = Buffer.from(hashEditToken(token), "hex");
  let expected: Buffer;
  try {
    expected = Buffer.from(storedHash, "hex");
  } catch {
    return false;
  }
  if (got.length !== expected.length || expected.length !== 32) return false;
  return crypto.timingSafeEqual(got, expected);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = sortValue(source[key]);
    return sorted;
  }
  return value;
}

export function sha256Hex(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function signContentHash(contentHash: string, key: Buffer): string {
  return crypto.createHmac("sha256", key).update(contentHash).digest("hex");
}

export function signatureMatches(contentHash: string, signature: string, key: Buffer): boolean {
  const expected = Buffer.from(signContentHash(contentHash, key), "hex");
  let got: Buffer;
  try {
    got = Buffer.from(signature, "hex");
  } catch {
    return false;
  }
  if (got.length !== expected.length || expected.length !== 32) return false;
  return crypto.timingSafeEqual(got, expected);
}

/** Positive for a price cap. Zero is allowed only for an actual amount. */
export function canonicalizeAmount(raw: string, allowZero: boolean): string | undefined {
  const text = raw.trim();
  if (!AMOUNT_RE.test(text)) return undefined;
  const [intPart, fracPart = ""] = text.split(".");
  const frac = fracPart.replace(/0+$/, "");
  if (intPart === "0" && frac === "") return allowZero ? "0" : undefined;
  return frac === "" ? intPart : `${intPart}.${frac}`;
}

export function amountFromUnknown(value: unknown, allowZero: boolean): string | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    if (Object.is(value, -0)) return undefined;
    const fixed = value.toFixed(8);
    const trimmed = fixed.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
    if (Math.abs(Number(trimmed) - value) > 1e-8) return undefined;
    return canonicalizeAmount(trimmed, allowZero);
  }
  if (typeof value === "string") return canonicalizeAmount(value, allowZero);
  return undefined;
}

export function decimalCompare(left: string, right: string): number {
  const [leftInt, leftFrac = ""] = left.split(".");
  const [rightInt, rightFrac = ""] = right.split(".");
  if (leftInt.length !== rightInt.length) return leftInt.length > rightInt.length ? 1 : -1;
  if (leftInt !== rightInt) return leftInt > rightInt ? 1 : -1;
  const width = Math.max(leftFrac.length, rightFrac.length);
  const a = leftFrac.padEnd(width, "0");
  const b = rightFrac.padEnd(width, "0");
  if (a === b) return 0;
  return a > b ? 1 : -1;
}

export function exceedsCap(actual: string | null, cap: string): boolean {
  if (actual == null) return false;
  return decimalCompare(actual, cap) > 0;
}

export function canonicalizeCurrency(raw: string): string | undefined {
  const text = raw.trim();
  if (!CURRENCY_RE.test(text)) return undefined;
  return text.toUpperCase();
}

export function canonicalizeHttpUrl(raw: string): string | undefined {
  const text = raw.trim();
  if (text.length === 0 || text.length > RECEIPT_URL_MAX) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.username || url.password) return undefined;
  return url.toString();
}

export function clientIp(forwardedFor: string | string[] | undefined, fallback: string | undefined): string {
  const raw = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  if (typeof raw === "string") {
    const first = raw.split(",")[0]?.trim() ?? "";
    if (first.length > 0 && first.length <= 200 && !/[\u0000-\u0020]/.test(first)) return first;
  }
  const ip = fallback?.trim() || "unknown";
  return ip.slice(0, 200);
}

export type RateLimitDecision = { ok: true } | { ok: false; retryAfterSec: number };

export function createRateLimiter(max: number, windowMs: number): {
  take(key: string, now?: number): RateLimitDecision;
} {
  if (!Number.isInteger(max) || max < 1) throw new Error("receipt rate limit max must be a positive integer");
  if (!Number.isInteger(windowMs) || windowMs < 1) throw new Error("receipt rate limit window must be a positive integer");
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return {
    take(key, now = Date.now()) {
      if (buckets.size > 10_000) {
        for (const [id, bucket] of buckets) {
          if (bucket.resetAt <= now) buckets.delete(id);
        }
      }
      const existing = buckets.get(key);
      if (!existing || existing.resetAt <= now) {
        buckets.set(key, { count: 1, resetAt: now + windowMs });
        return { ok: true };
      }
      if (existing.count >= max) {
        return { ok: false, retryAfterSec: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)) };
      }
      existing.count += 1;
      return { ok: true };
    },
  };
}

function newHexId(prefix: string, bytes: number): string {
  return `${prefix}_${crypto.randomBytes(bytes).toString("hex")}`;
}

export function receiptSnapshot(record: ReceiptRecord): ReceiptSnapshot {
  return {
    receipt_id: record.id,
    mode: record.mode,
    created_at: record.created_at,
    updated_at: record.updated_at,
    approver: record.approver_name,
    approver_contact_hash: record.approver_contact_hash,
    edit_token_hash: record.edit_token_hash,
    agent_id: record.agent_id,
    agent_name: record.agent_name,
    merchant_name: record.merchant_name,
    merchant_url: record.merchant_url,
    scope: record.scope,
    price_cap_amount: record.price_cap_amount,
    price_cap_currency: record.price_cap_currency,
    payment_rail: record.payment_rail,
    external_payment_ref: record.external_payment_ref,
    status: record.status,
    proofs: record.proofs.map((proof) => ({
      proof_id: proof.id,
      proof_index: proof.proof_index,
      type: proof.type,
      value: proof.value,
      actual_amount: proof.actual_amount,
      over_cap: proof.over_cap,
      attached_at: proof.attached_at,
    })),
  };
}

function seal(body: ChainEventBody, key: Buffer, createdAt: string): { event: ReceiptEvent; hash: string; signature: string } {
  const payloadJson = canonicalJson(body);
  const hash = sha256Hex(payloadJson);
  const event: ReceiptEvent = {
    id: newHexId("revt", 12),
    seq: body.seq,
    kind: body.kind,
    prev_hash: body.prev_hash,
    hash,
    payload_json: payloadJson,
    created_at: createdAt,
  };
  return { event, hash, signature: signContentHash(hash, key) };
}

export function planApproval(input: CreateReceiptInput, mode: StripeMode, now: string, key: Buffer): PlannedReceipt {
  const editToken = newHexId("rctok", 24);
  const draft: ReceiptRecord = {
    id: newHexId("rcpt", 12),
    mode,
    created_at: now,
    updated_at: now,
    approver_name: input.approverName,
    approver_contact_hash: input.approverContactHash,
    agent_id: input.agentId,
    agent_name: input.agentName,
    merchant_name: input.merchantName,
    merchant_url: input.merchantUrl,
    scope: input.scope,
    price_cap_amount: input.priceCapAmount,
    price_cap_currency: input.priceCapCurrency,
    payment_rail: input.paymentRail,
    external_payment_ref: input.externalPaymentRef,
    status: "approved",
    content_hash: "",
    signature: "",
    edit_token_hash: hashEditToken(editToken),
    proofs: [],
    events: [],
  };
  const sealed = seal(
    { seq: 0, kind: "approved", prev_hash: "", snapshot: receiptSnapshot(draft) },
    key,
    now,
  );
  const record: ReceiptRecord = {
    ...draft,
    content_hash: sealed.hash,
    signature: sealed.signature,
    events: [sealed.event],
  };
  return { record, editToken, event: sealed.event };
}

export function nextReceiptStatus(
  current: ReceiptStatus,
  requested: "delivered" | "disputed" | undefined,
): ReceiptStatus | "invalid" {
  if (requested === undefined) return current === "approved" ? "delivered" : current;
  if (current === "disputed" && requested !== "disputed") return "invalid";
  return requested;
}

/**
 * Append a proof and a chain event.
 * Refuses when the stored row no longer matches the chain, so a tampered receipt cannot be re-signed.
 */
export function planProof(record: ReceiptRecord, input: AttachProofInput, now: string, key: Buffer): PlanProofResult {
  if (!editTokenMatches(record.edit_token_hash, input.editToken)) {
    return { ok: false, code: "invalid_edit_token" };
  }
  if (!verifyReceiptRecord(record, key).valid) return { ok: false, code: "tampered" };
  const status = nextReceiptStatus(record.status, input.status);
  if (status === "invalid") return { ok: false, code: "invalid_status" };
  const previous = record.events[record.events.length - 1];
  if (!previous) return { ok: false, code: "tampered" };
  const overCap = exceedsCap(input.actualAmount, record.price_cap_amount);
  const proof: ReceiptProof = {
    id: newHexId("prf", 12),
    proof_index: record.proofs.length,
    type: input.type,
    value: input.value,
    actual_amount: input.actualAmount,
    over_cap: overCap,
    attached_at: now,
  };
  const updated: ReceiptRecord = {
    ...record,
    status,
    updated_at: now,
    proofs: [...record.proofs, proof],
  };
  const sealed = seal(
    {
      seq: record.events.length,
      kind: "proof_attached",
      prev_hash: previous.hash,
      snapshot: receiptSnapshot(updated),
    },
    key,
    now,
  );
  return {
    ok: true,
    proof,
    event: sealed.event,
    status,
    contentHash: sealed.hash,
    signature: sealed.signature,
    updatedAt: now,
    overCap,
  };
}

export function verifyReceiptRecord(record: ReceiptRecord, key: Buffer): VerifyResult {
  const checks: VerifyChecks = { chain: false, content: false, signature: false };
  const failed = (): VerifyResult => ({
    valid: false,
    receipt_id: record.id,
    content_hash: record.content_hash,
    checks,
  });
  if (record.events.length === 0) return failed();
  let previous = "";
  let latest: ChainEventBody | undefined;
  for (let index = 0; index < record.events.length; index += 1) {
    const event = record.events[index];
    if (!event || event.seq !== index || event.prev_hash !== previous) return failed();
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.payload_json) as unknown;
    } catch {
      return failed();
    }
    const canonical = canonicalJson(parsed);
    const hash = sha256Hex(canonical);
    if (canonical !== event.payload_json || hash !== event.hash) return failed();
    if (!isChainBody(parsed, event)) return failed();
    previous = hash;
    latest = parsed;
  }
  checks.chain = latest !== undefined;
  if (!latest) return failed();
  const last = record.events[record.events.length - 1];
  if (!last) return failed();
  checks.content =
    canonicalJson(receiptSnapshot(record)) === canonicalJson(latest.snapshot) && record.content_hash === last.hash;
  checks.signature = signatureMatches(last.hash, record.signature, key);
  return {
    valid: checks.chain && checks.content && checks.signature,
    receipt_id: record.id,
    content_hash: record.content_hash,
    checks,
  };
}

function isChainBody(value: unknown, event: ReceiptEvent): value is ChainEventBody {
  if (value === null || typeof value !== "object") return false;
  const body = value as Partial<ChainEventBody>;
  return body.seq === event.seq && body.kind === event.kind && body.prev_hash === event.prev_hash && body.snapshot != null;
}

export function toPublicReceipt(record: ReceiptRecord, receiptUrl: string): PublicReceipt {
  return {
    receipt_id: record.id,
    receipt_url: receiptUrl,
    mode: record.mode,
    status: record.status,
    created_at: record.created_at,
    updated_at: record.updated_at,
    approver: record.approver_name,
    agent_id: record.agent_id,
    agent_name: record.agent_name,
    merchant: { name: record.merchant_name, url: record.merchant_url },
    scope: record.scope,
    price_cap: { amount: record.price_cap_amount, currency: record.price_cap_currency },
    payment_rail: record.payment_rail,
    external_payment_ref: record.external_payment_ref,
    proofs: record.proofs.map((proof) => ({
      type: proof.type,
      value: proof.value,
      actual_amount: proof.actual_amount,
      over_cap: proof.over_cap,
      attached_at: proof.attached_at,
    })),
    content_hash: record.content_hash,
    timeline: record.events.map((event) => ({
      seq: event.seq,
      kind: event.kind,
      at: event.created_at,
      prev_hash: event.prev_hash,
      hash: event.hash,
    })),
  };
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

function optionalText(value: unknown, field: string, max: number): Parsed<string | null> {
  if (value == null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, message: `${field} must be a string of 1 to ${max} characters` };
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) {
    return { ok: false, message: `${field} must be a string of 1 to ${max} characters` };
  }
  if (/[\u0000-\u001F\u007F]/.test(trimmed)) {
    return { ok: false, message: `${field} must not contain control characters` };
  }
  return { ok: true, value: trimmed };
}

function requiredText(value: unknown, field: string, max: number): Parsed<string> {
  const parsed = optionalText(value, field, max);
  if (!parsed.ok) return parsed;
  if (parsed.value == null) return { ok: false, message: `${field} must be a string of 1 to ${max} characters` };
  return { ok: true, value: parsed.value };
}

export function parseApprovalBody(body: Record<string, unknown>): Parsed<CreateReceiptInput> {
  const approver = requiredText(body.approver, "approver", RECEIPT_APPROVER_MAX);
  if (!approver.ok) return approver;
  const contact = optionalText(body.approver_contact, "approver_contact", RECEIPT_CONTACT_MAX);
  if (!contact.ok) return contact;
  const agentId = optionalText(body.agent_id, "agent_id", RECEIPT_AGENT_MAX);
  if (!agentId.ok) return agentId;
  const agentName = optionalText(body.agent_name, "agent_name", RECEIPT_AGENT_MAX);
  if (!agentName.ok) return agentName;
  const merchantName = requiredText(body.merchant_name, "merchant_name", RECEIPT_MERCHANT_MAX);
  if (!merchantName.ok) return merchantName;
  let merchantUrl: string | null = null;
  if (body.merchant_url != null) {
    if (typeof body.merchant_url !== "string") {
      return { ok: false, message: "merchant_url must be an http or https URL" };
    }
    const url = canonicalizeHttpUrl(body.merchant_url);
    if (!url) return { ok: false, message: "merchant_url must be an http or https URL" };
    merchantUrl = url;
  }
  const scope = requiredText(body.scope, "scope", RECEIPT_SCOPE_MAX);
  if (!scope.ok) return scope;
  const amount = amountFromUnknown(body.price_cap_amount, false);
  if (!amount) {
    return {
      ok: false,
      message: "price_cap_amount must be a positive decimal with up to 12 digits and 8 decimal places",
    };
  }
  if (typeof body.price_cap_currency !== "string" || !canonicalizeCurrency(body.price_cap_currency)) {
    return { ok: false, message: "price_cap_currency must be 3 to 10 letters" };
  }
  const rail = requiredText(body.payment_rail, "payment_rail", RECEIPT_RAIL_MAX);
  if (!rail.ok) return rail;
  const externalRef = optionalText(body.external_payment_ref, "external_payment_ref", RECEIPT_REF_MAX);
  if (!externalRef.ok) return externalRef;
  return {
    ok: true,
    value: {
      approverName: approver.value,
      approverContactHash: contact.value == null ? null : hashApproverContact(contact.value),
      agentId: agentId.value,
      agentName: agentName.value,
      merchantName: merchantName.value,
      merchantUrl,
      scope: scope.value,
      priceCapAmount: amount,
      priceCapCurrency: canonicalizeCurrency(body.price_cap_currency) ?? "",
      paymentRail: rail.value,
      externalPaymentRef: externalRef.value,
    },
  };
}

export function parseProofBody(body: Record<string, unknown>): Parsed<Omit<AttachProofInput, "receiptId">> {
  const token = requiredText(body.edit_token, "edit_token", 200);
  if (!token.ok) return token;
  const type = requiredText(body.type, "type", RECEIPT_PROOF_TYPE_MAX);
  if (!type.ok) return type;
  const value = requiredText(body.value, "value", RECEIPT_PROOF_VALUE_MAX);
  if (!value.ok) return value;
  let actualAmount: string | null = null;
  if (body.actual_amount != null) {
    actualAmount = amountFromUnknown(body.actual_amount, true) ?? null;
    if (actualAmount == null) {
      return {
        ok: false,
        message: "actual_amount must be a decimal from 0 with up to 12 digits and 8 decimal places",
      };
    }
  }
  let status: "delivered" | "disputed" | undefined;
  if (body.status != null) {
    if (body.status !== "delivered" && body.status !== "disputed") {
      return { ok: false, message: "status must be delivered or disputed" };
    }
    status = body.status;
  }
  return {
    ok: true,
    value: {
      editToken: token.value,
      type: type.value,
      value: value.value,
      actualAmount,
      status,
    },
  };
}

export function asReceiptStatus(value: string): ReceiptStatus {
  if (value === "approved" || value === "delivered" || value === "disputed") return value;
  throw new Error(`Unexpected receipt status: ${value}`);
}

export function asEventKind(value: string): "approved" | "proof_attached" {
  if (value === "approved" || value === "proof_attached") return value;
  throw new Error(`Unexpected receipt event kind: ${value}`);
}

export function asStripeMode(value: string): StripeMode {
  if (value === "dev" || value === "test" || value === "live") return value;
  throw new Error(`Unexpected receipt mode: ${value}`);
}

export type ReceiptHeaderRow = {
  id: string;
  mode: string;
  created_at: string | Date;
  updated_at: string | Date;
  approver_name: string;
  approver_contact_hash: string | null;
  agent_id: string | null;
  agent_name: string | null;
  merchant_name: string;
  merchant_url: string | null;
  scope: string;
  price_cap_amount: string;
  price_cap_currency: string;
  payment_rail: string;
  external_payment_ref: string | null;
  status: string;
  content_hash: string;
  signature: string;
  edit_token_hash: string;
};

export type ReceiptProofRow = {
  id: string;
  proof_index: number | string;
  proof_type: string;
  proof_value: string;
  actual_amount: string | null;
  over_cap: number | string | boolean;
  attached_at: string | Date;
};

export type ReceiptEventRow = {
  id: string;
  seq: number | string;
  kind: string;
  prev_hash: string;
  hash: string;
  payload_json: string;
  created_at: string | Date;
};

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function flag(value: number | string | boolean): boolean {
  if (typeof value === "boolean") return value;
  return Number(value) === 1;
}

export function assembleReceipt(header: ReceiptHeaderRow, proofs: ReceiptProofRow[], events: ReceiptEventRow[]): ReceiptRecord {
  return {
    id: header.id,
    mode: asStripeMode(header.mode),
    created_at: iso(header.created_at),
    updated_at: iso(header.updated_at),
    approver_name: header.approver_name,
    approver_contact_hash: header.approver_contact_hash,
    agent_id: header.agent_id,
    agent_name: header.agent_name,
    merchant_name: header.merchant_name,
    merchant_url: header.merchant_url,
    scope: header.scope,
    price_cap_amount: header.price_cap_amount,
    price_cap_currency: header.price_cap_currency,
    payment_rail: header.payment_rail,
    external_payment_ref: header.external_payment_ref,
    status: asReceiptStatus(header.status),
    content_hash: header.content_hash,
    signature: header.signature,
    edit_token_hash: header.edit_token_hash,
    proofs: proofs.map((proof) => ({
      id: proof.id,
      proof_index: Number(proof.proof_index),
      type: proof.proof_type,
      value: proof.proof_value,
      actual_amount: proof.actual_amount,
      over_cap: flag(proof.over_cap),
      attached_at: iso(proof.attached_at),
    })),
    events: events.map((event) => ({
      id: event.id,
      seq: Number(event.seq),
      kind: asEventKind(event.kind),
      prev_hash: event.prev_hash,
      hash: event.hash,
      payload_json: event.payload_json,
      created_at: iso(event.created_at),
    })),
  };
}
