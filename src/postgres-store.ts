import { Pool, type PoolClient } from "pg";
import { clampFeeBps, escrowFeeCredits } from "./escrow.js";
import {
  asContactChannel,
  assembleReceipt,
  confirmExpiresAt,
  confirmTokenState,
  hashApproverContact,
  editTokenMatches,
  hashConfirmToken,
  isConfirmToken,
  newConfirmToken,
  planApproval,
  planApproverDecision,
  planPayment,
  planProof,
  type CreateReceiptInput,
  type ReceiptEvent,
  type ReceiptEventRow,
  type ReceiptHeaderRow,
  type ReceiptPaymentRow,
  type ReceiptProofRow,
  type ReceiptRecord,
} from "./receipts.js";
import type { StripeMode } from "./stripe.js";
import {
  hashApiKey,
  isUniqueConstraint,
  lockWalletIds,
  mapJob,
  mapPurchase,
  mapWallet,
  newApiKey,
  newId,
  sameJobRequest,
  type ApplyStripeCreditResult,
  type AttachReceiptResult,
  type CheckoutSessionRow,
  type CheckoutSessionSave,
  type CreateJobInput,
  type CreateJobResult,
  type CreateReceiptResult,
  type DecideConfirmationResult,
  type JobBalances,
  type ReadConfirmationResult,
  type RecordPaymentResult,
  type SetReceiptVisibilityResult,
  type JobRow,
  type PurchaseResult,
  type SettleJobResult,
  type Store,
  type StripeCreditInput,
  type WalletRow,
} from "./store.js";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS wallets (
    id TEXT PRIMARY KEY,
    mode TEXT NOT NULL,
    api_key_hash TEXT NOT NULL,
    balance_credits INTEGER NOT NULL,
    label TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (mode, api_key_hash)
  )`,
  `CREATE TABLE IF NOT EXISTS purchases (
    id TEXT PRIMARY KEY,
    mode TEXT NOT NULL,
    wallet_id TEXT NOT NULL REFERENCES wallets(id),
    sku TEXT NOT NULL,
    credits_charged INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_purchases_mode_wallet ON purchases (mode, wallet_id)`,
  `CREATE TABLE IF NOT EXISTS stripe_checkout_sessions (
    session_id TEXT PRIMARY KEY,
    mode TEXT NOT NULL,
    wallet_id TEXT NOT NULL REFERENCES wallets(id),
    credits INTEGER NOT NULL,
    url TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS stripe_checkout_credits (
    session_id TEXT PRIMARY KEY,
    mode TEXT NOT NULL,
    wallet_id TEXT NOT NULL REFERENCES wallets(id),
    credits INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_wallets_mode_hash ON wallets (mode, api_key_hash)`,
  `CREATE TABLE IF NOT EXISTS escrow_jobs (
    id TEXT PRIMARY KEY,
    mode TEXT NOT NULL,
    payer_wallet_id TEXT NOT NULL REFERENCES wallets(id),
    payee_wallet_id TEXT NOT NULL REFERENCES wallets(id),
    amount_credits INTEGER NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('held', 'released', 'refunded')),
    idempotency_key TEXT NOT NULL,
    fee_bps INTEGER NOT NULL DEFAULT 0,
    fee_credits INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (mode, payer_wallet_id, idempotency_key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_escrow_jobs_mode_payer ON escrow_jobs (mode, payer_wallet_id)`,
  `CREATE TABLE IF NOT EXISTS receipts (
    id TEXT PRIMARY KEY,
    mode TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    approver_name TEXT NOT NULL,
    approver_contact_hash TEXT,
    agent_id TEXT,
    agent_name TEXT,
    merchant_name TEXT NOT NULL,
    merchant_url TEXT,
    scope TEXT NOT NULL,
    price_cap_amount TEXT NOT NULL,
    price_cap_currency TEXT NOT NULL,
    payment_rail TEXT NOT NULL,
    external_payment_ref TEXT,
    status TEXT NOT NULL CHECK (status IN ('approved', 'delivered', 'disputed')),
    content_hash TEXT NOT NULL,
    signature TEXT NOT NULL,
    edit_token_hash TEXT NOT NULL,
    approver_decision TEXT,
    approver_decision_at TEXT,
    approver_decision_channel TEXT,
    approver_contact_masked TEXT,
    public_view TEXT NOT NULL DEFAULT 'full',
    public_scope TEXT
  )`,
  `ALTER TABLE receipts ADD COLUMN IF NOT EXISTS approver_decision TEXT`,
  `ALTER TABLE receipts ADD COLUMN IF NOT EXISTS approver_decision_at TEXT`,
  `ALTER TABLE receipts ADD COLUMN IF NOT EXISTS approver_decision_channel TEXT`,
  `ALTER TABLE receipts ADD COLUMN IF NOT EXISTS approver_contact_masked TEXT`,
  `ALTER TABLE receipts ADD COLUMN IF NOT EXISTS public_view TEXT NOT NULL DEFAULT 'full'`,
  `ALTER TABLE receipts ADD COLUMN IF NOT EXISTS public_scope TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_receipts_mode_id ON receipts (mode, id)`,
  `CREATE TABLE IF NOT EXISTS receipt_proofs (
    id TEXT PRIMARY KEY,
    receipt_id TEXT NOT NULL REFERENCES receipts(id),
    mode TEXT NOT NULL,
    proof_index INTEGER NOT NULL,
    proof_type TEXT NOT NULL,
    proof_value TEXT NOT NULL,
    actual_amount TEXT,
    over_cap INTEGER NOT NULL,
    attached_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_receipt_proofs_receipt ON receipt_proofs (mode, receipt_id, proof_index)`,
  `CREATE TABLE IF NOT EXISTS receipt_events (
    id TEXT PRIMARY KEY,
    receipt_id TEXT NOT NULL REFERENCES receipts(id),
    mode TEXT NOT NULL,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    prev_hash TEXT NOT NULL,
    hash TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (receipt_id, seq)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_receipt_events_receipt ON receipt_events (mode, receipt_id, seq)`,
  `CREATE TABLE IF NOT EXISTS receipt_confirm_tokens (
    id TEXT PRIMARY KEY,
    receipt_id TEXT NOT NULL REFERENCES receipts(id),
    mode TEXT NOT NULL,
    channel TEXT NOT NULL,
    contact_hash TEXT NOT NULL,
    contact_masked TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    decision TEXT,
    webhook_url TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_receipt_confirm_tokens_receipt ON receipt_confirm_tokens (mode, receipt_id)`,
  `CREATE TABLE IF NOT EXISTS receipt_payments (
    id TEXT PRIMARY KEY,
    receipt_id TEXT NOT NULL REFERENCES receipts(id),
    mode TEXT NOT NULL,
    payment_index INTEGER NOT NULL,
    external_payment_ref TEXT NOT NULL,
    amount TEXT NOT NULL,
    currency TEXT NOT NULL,
    paid_at TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    paid_before_confirmation INTEGER NOT NULL,
    over_cap INTEGER NOT NULL,
    UNIQUE (receipt_id, payment_index)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_receipt_payments_receipt ON receipt_payments (mode, receipt_id, payment_index)`,
];

const JOB_COLUMNS =
  "id, payer_wallet_id, payee_wallet_id, amount_credits, description, status, idempotency_key, fee_bps, fee_credits, created_at, updated_at";

const WALLET_COLUMNS = "id, api_key_hash, balance_credits, label, created_at";

function needsSsl(connectionString: string): boolean {
  return /[?&]sslmode=require(?:&|$)/.test(connectionString) || /\.render\.com\b/.test(connectionString);
}

export function createPostgresPool(connectionString: string): Pool {
  const pool = new Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    ssl: needsSsl(connectionString) ? { rejectUnauthorized: false } : undefined,
  });
  pool.on("error", (error) => {
    console.error("postgres pool error", error.message);
  });
  return pool;
}

function postgresCode(error: unknown): string | undefined {
  if (typeof error === "object" && error && "code" in error && typeof error.code === "string") return error.code;
  return undefined;
}

async function withTransaction<T>(pool: Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const RECEIPT_HEADER = `id, mode, created_at, updated_at, approver_name, approver_contact_hash, agent_id, agent_name,
  merchant_name, merchant_url, scope, price_cap_amount, price_cap_currency, payment_rail,
  external_payment_ref, status, content_hash, signature, edit_token_hash,
  approver_decision, approver_decision_at, approver_decision_channel, approver_contact_masked,
  public_view, public_scope`;

type ConfirmTokenRow = {
  receipt_id: string;
  channel: string;
  contact_masked: string;
  expires_at: string | Date;
  used_at: string | Date | null;
  decision: string | null;
  webhook_url: string | null;
};

export async function openPostgresStore(
  connectionString: string,
  mode: StripeMode,
  receiptKey: Buffer,
  confirmTtlMs = 86_400_000,
  pool = createPostgresPool(connectionString),
): Promise<Store> {
  try {
    for (const statement of SCHEMA) {
      await pool.query(statement);
    }
    await pool.query("SELECT 1");
  } catch (error) {
    await pool.end().catch(() => undefined);
    const message = error instanceof Error ? error.message : "connection failed";
    throw new Error(`Postgres connection failed: ${message}`);
  }

  async function findWalletById(id: string, client: Pool | PoolClient = pool): Promise<WalletRow | undefined> {
    const result = await client.query(
      `SELECT ${WALLET_COLUMNS} FROM wallets WHERE id = $1 AND mode = $2`,
      [id, mode],
    );
    const row = result.rows[0] as WalletRow | undefined;
    return row ? mapWallet(row) : undefined;
  }

  async function creditReplay(sessionId: string, client: Pool | PoolClient = pool): Promise<ApplyStripeCreditResult | undefined> {
    const existing = await client.query(
      `SELECT session_id, wallet_id, credits FROM stripe_checkout_credits WHERE session_id = $1 AND mode = $2`,
      [sessionId, mode],
    );
    const row = existing.rows[0] as { session_id: string; wallet_id: string; credits: number } | undefined;
    if (!row) return undefined;
    const wallet = await findWalletById(row.wallet_id, client);
    return {
      ok: true,
      applied: false,
      balance_credits: wallet?.balance_credits ?? 0,
      wallet_id: row.wallet_id,
      credits: Number(row.credits),
      session_id: row.session_id,
    };
  }

  async function selectJob(client: Pool | PoolClient, whereSql: string, params: unknown[]): Promise<JobRow | undefined> {
    const result = await client.query(`SELECT ${JOB_COLUMNS} FROM escrow_jobs WHERE ${whereSql}`, params);
    const row = result.rows[0] as Parameters<typeof mapJob>[0] | undefined;
    return row ? mapJob(row) : undefined;
  }

  async function lockWallet(client: PoolClient, id: string): Promise<WalletRow | undefined> {
    const result = await client.query(
      `SELECT ${WALLET_COLUMNS} FROM wallets WHERE id = $1 AND mode = $2 FOR UPDATE`,
      [id, mode],
    );
    const row = result.rows[0] as WalletRow | undefined;
    return row ? mapWallet(row) : undefined;
  }

  async function jobBalances(client: Pool | PoolClient, payerId: string, payeeId: string): Promise<JobBalances> {
    const payer = await findWalletById(payerId, client);
    const payee = await findWalletById(payeeId, client);
    return {
      payer_balance_credits: payer?.balance_credits ?? 0,
      payee_balance_credits: payee?.balance_credits ?? 0,
    };
  }

  function replayCreate(input: CreateJobInput, job: JobRow, balances: JobBalances): CreateJobResult {
    if (!sameJobRequest(job, input)) return { ok: false, code: "idempotency_conflict", job };
    return { ok: true, job, replay: true, ...balances };
  }

  async function settleJob(
    client: PoolClient,
    id: string,
    next: "released" | "refunded",
    apply: (job: JobRow) => { feeBps: number; feeCredits: number; creditWalletId: string; credit: number },
  ): Promise<SettleJobResult> {
    const locked = await client.query(
      `SELECT ${JOB_COLUMNS} FROM escrow_jobs WHERE id = $1 AND mode = $2 FOR UPDATE`,
      [id, mode],
    );
    const row = locked.rows[0] as Parameters<typeof mapJob>[0] | undefined;
    if (!row) return { ok: false, code: "not_found" };
    const job = mapJob(row);
    if (job.status !== "held") return { ok: false, code: "not_held", status: job.status };
    const [firstId, secondId] = lockWalletIds(job.payer_wallet_id, job.payee_wallet_id);
    const first = await lockWallet(client, firstId);
    const second = await lockWallet(client, secondId);
    if (!first || !second) return { ok: false, code: "not_found" };
    const effect = apply(job);
    const now = new Date().toISOString();
    const updated = await client.query(
      `UPDATE escrow_jobs
       SET status = $1, fee_bps = $2, fee_credits = $3, updated_at = $4
       WHERE id = $5 AND mode = $6 AND status = 'held'
       RETURNING ${JOB_COLUMNS}`,
      [next, effect.feeBps, effect.feeCredits, now, id, mode],
    );
    const savedRow = updated.rows[0] as Parameters<typeof mapJob>[0] | undefined;
    if (!savedRow) return { ok: false, code: "not_held", status: job.status };
    const credited = await client.query(
      `UPDATE wallets SET balance_credits = balance_credits + $1 WHERE id = $2 AND mode = $3`,
      [effect.credit, effect.creditWalletId, mode],
    );
    if ((credited.rowCount ?? 0) !== 1) throw new Error(`Escrow credit missed wallet ${effect.creditWalletId}`);
    const saved = mapJob(savedRow);
    return { ok: true, job: saved, ...(await jobBalances(client, saved.payer_wallet_id, saved.payee_wallet_id)) };
  }

  const store: Store = {
    kind: "postgres",
    mode,
    async ping() {
      await pool.query("SELECT 1");
    },
    async close() {
      await pool.end();
    },
    async createWallet(label) {
      const apiKey = newApiKey();
      const wallet: WalletRow = {
        id: newId("wal"),
        api_key_hash: hashApiKey(apiKey),
        balance_credits: 0,
        label,
        created_at: new Date().toISOString(),
      };
      await pool.query(
        `INSERT INTO wallets (id, mode, api_key_hash, balance_credits, label, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [wallet.id, mode, wallet.api_key_hash, wallet.balance_credits, wallet.label, wallet.created_at],
      );
      return { wallet, apiKey };
    },
    async findWalletById(id) {
      return findWalletById(id);
    },
    async findWalletByApiKey(apiKey) {
      const result = await pool.query(
        `SELECT ${WALLET_COLUMNS} FROM wallets WHERE api_key_hash = $1 AND mode = $2`,
        [hashApiKey(apiKey), mode],
      );
      const row = result.rows[0] as WalletRow | undefined;
      return row ? mapWallet(row) : undefined;
    },
    async topUpWallet(id, credits) {
      const result = await pool.query(
        `UPDATE wallets SET balance_credits = balance_credits + $1
         WHERE id = $2 AND mode = $3
         RETURNING ${WALLET_COLUMNS}`,
        [credits, id, mode],
      );
      const row = result.rows[0] as WalletRow | undefined;
      return row ? mapWallet(row) : undefined;
    },
    async purchaseSku(walletId, sku, priceCredits, payload) {
      return withTransaction(pool, async (client): Promise<PurchaseResult> => {
        const locked = await client.query(
          `SELECT ${WALLET_COLUMNS} FROM wallets WHERE id = $1 AND mode = $2 FOR UPDATE`,
          [walletId, mode],
        );
        const wallet = locked.rows[0] as WalletRow | undefined;
        if (!wallet) throw new Error(`Wallet disappeared: ${walletId}`);
        const current = mapWallet(wallet);
        if (current.balance_credits < priceCredits) {
          return { ok: false, balance_credits: current.balance_credits };
        }
        const balance = current.balance_credits - priceCredits;
        const purchase = {
          id: newId("pur"),
          wallet_id: walletId,
          sku,
          credits_charged: priceCredits,
          payload_json: JSON.stringify(payload),
          created_at: new Date().toISOString(),
        };
        await client.query(`UPDATE wallets SET balance_credits = $1 WHERE id = $2 AND mode = $3`, [balance, walletId, mode]);
        await client.query(
          `INSERT INTO purchases (id, mode, wallet_id, sku, credits_charged, payload_json, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [purchase.id, mode, purchase.wallet_id, purchase.sku, purchase.credits_charged, purchase.payload_json, purchase.created_at],
        );
        return { ok: true, purchase, balance_credits: balance };
      });
    },
    async findPurchase(id) {
      const result = await pool.query(
        `SELECT id, wallet_id, sku, credits_charged, payload_json, created_at
         FROM purchases WHERE id = $1 AND mode = $2`,
        [id, mode],
      );
      const row = result.rows[0] as Parameters<typeof mapPurchase>[0] | undefined;
      return row ? mapPurchase(row) : undefined;
    },
    async saveCheckoutSessionUrl(input: CheckoutSessionSave) {
      await pool.query(
        `INSERT INTO stripe_checkout_sessions (session_id, mode, wallet_id, credits, url, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (session_id) DO UPDATE SET url = EXCLUDED.url`,
      [
        input.sessionId,
        mode,
        input.walletId,
        input.credits,
        input.url,
        new Date().toISOString(),
      ]);
    },
    async findCheckoutSessionUrl(sessionId) {
      const result = await pool.query(
        `SELECT session_id, wallet_id, credits, url
         FROM stripe_checkout_sessions WHERE session_id = $1 AND mode = $2`,
        [sessionId, mode],
      );
      const row = result.rows[0] as CheckoutSessionRow | undefined;
      if (!row) return undefined;
      return { ...row, credits: Number(row.credits) };
    },
    async applyStripeCheckoutCredit(input: StripeCreditInput): Promise<ApplyStripeCreditResult> {
      if (!input.sessionId || !Number.isInteger(input.credits) || input.credits < 1) {
        return { ok: false, code: "invalid_credit" };
      }
      try {
        return await withTransaction(pool, async (client) => {
          const replay = await creditReplay(input.sessionId, client);
          if (replay) return replay;
          const locked = await client.query(
            `SELECT id FROM wallets WHERE id = $1 AND mode = $2 FOR UPDATE`,
            [input.walletId, mode],
          );
          if (!locked.rows[0]) return { ok: false, code: "wallet_not_found" };
          await client.query(
            `INSERT INTO stripe_checkout_credits (session_id, mode, wallet_id, credits, created_at)
             VALUES ($1, $2, $3, $4, $5)`,
            [input.sessionId, mode, input.walletId, input.credits, new Date().toISOString()],
          );
          const updated = await client.query(
            `UPDATE wallets SET balance_credits = balance_credits + $1
             WHERE id = $2 AND mode = $3
             RETURNING ${WALLET_COLUMNS}`,
            [input.credits, input.walletId, mode],
          );
          const wallet = updated.rows[0] as WalletRow | undefined;
          if (!wallet) return { ok: false, code: "wallet_not_found" };
          const mapped = mapWallet(wallet);
          return {
            ok: true,
            applied: true,
            balance_credits: mapped.balance_credits,
            wallet_id: mapped.id,
            credits: input.credits,
            session_id: input.sessionId,
          };
        });
      } catch (error) {
        if (postgresCode(error) !== "23505") throw error;
        const replay = await creditReplay(input.sessionId);
        if (replay) return replay;
        throw error;
      }
    },
    async createJob(input) {
      if (!Number.isInteger(input.amountCredits) || input.amountCredits < 1) {
        return { ok: false, code: "invalid_amount" };
      }
      if (input.payerWalletId === input.payeeWalletId) return { ok: false, code: "same_wallet" };
      try {
        return await withTransaction(pool, async (client) => {
          const existing = await selectJob(client, "mode = $1 AND payer_wallet_id = $2 AND idempotency_key = $3", [
            mode,
            input.payerWalletId,
            input.idempotencyKey,
          ]);
          if (existing) return replayCreate(input, existing, await jobBalances(client, existing.payer_wallet_id, existing.payee_wallet_id));
          const [firstId, secondId] = lockWalletIds(input.payerWalletId, input.payeeWalletId);
          const first = await lockWallet(client, firstId);
          const second = await lockWallet(client, secondId);
          const payer = first?.id === input.payerWalletId ? first : second?.id === input.payerWalletId ? second : undefined;
          const payee = first?.id === input.payeeWalletId ? first : second?.id === input.payeeWalletId ? second : undefined;
          if (!payer) return { ok: false, code: "wallet_not_found", which: "payer" };
          if (!payee) return { ok: false, code: "wallet_not_found", which: "payee" };
          const debited = await client.query(
            `UPDATE wallets SET balance_credits = balance_credits - $1
             WHERE id = $2 AND mode = $3 AND balance_credits >= $1`,
            [input.amountCredits, input.payerWalletId, mode],
          );
          if ((debited.rowCount ?? 0) !== 1) {
            return { ok: false, code: "insufficient_credits", balance_credits: payer.balance_credits };
          }
          const now = new Date().toISOString();
          const job: JobRow = {
            id: newId("job"),
            payer_wallet_id: input.payerWalletId,
            payee_wallet_id: input.payeeWalletId,
            amount_credits: input.amountCredits,
            description: input.description,
            status: "held",
            idempotency_key: input.idempotencyKey,
            fee_bps: 0,
            fee_credits: 0,
            created_at: now,
            updated_at: now,
          };
          await client.query(
            `INSERT INTO escrow_jobs (
               id, mode, payer_wallet_id, payee_wallet_id, amount_credits, description, status,
               idempotency_key, fee_bps, fee_credits, created_at, updated_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [
              job.id,
              mode,
              job.payer_wallet_id,
              job.payee_wallet_id,
              job.amount_credits,
              job.description,
              job.status,
              job.idempotency_key,
              job.fee_bps,
              job.fee_credits,
              job.created_at,
              job.updated_at,
            ],
          );
          return {
            ok: true,
            job,
            replay: false,
            payer_balance_credits: payer.balance_credits - input.amountCredits,
            payee_balance_credits: payee.balance_credits,
          };
        });
      } catch (error) {
        if (!isUniqueConstraint(error)) throw error;
        const existing = await selectJob(pool, "mode = $1 AND payer_wallet_id = $2 AND idempotency_key = $3", [
          mode,
          input.payerWalletId,
          input.idempotencyKey,
        ]);
        if (!existing) throw error;
        return replayCreate(input, existing, await jobBalances(pool, existing.payer_wallet_id, existing.payee_wallet_id));
      }
    },
    async getJob(id) {
      return selectJob(pool, "id = $1 AND mode = $2", [id, mode]);
    },
    async releaseJob(id, feeBps) {
      return withTransaction(pool, (client) =>
        settleJob(client, id, "released", (job) => {
          const feeCredits = escrowFeeCredits(job.amount_credits, feeBps);
          return {
            feeBps: clampFeeBps(feeBps),
            feeCredits,
            creditWalletId: job.payee_wallet_id,
            credit: job.amount_credits - feeCredits,
          };
        }),
      );
    },
    async refundJob(id) {
      return withTransaction(pool, (client) =>
        settleJob(client, id, "refunded", (job) => ({
          feeBps: 0,
          feeCredits: 0,
          creditWalletId: job.payer_wallet_id,
          credit: job.amount_credits,
        })),
      );
    },
    async createReceipt(input) {
      const planned = planApproval(input, mode, new Date().toISOString(), receiptKey);
      return withTransaction(pool, async (client) => {
        await insertReceipt(client, planned.record);
        await insertReceiptEvent(client, planned.record.id, planned.event);
        const confirmation = await insertConfirmation(client, planned.record.id, input, planned.record.created_at);
        const saved = await loadReceipt(client, planned.record.id);
        if (!saved) throw new Error(`Receipt disappeared: ${planned.record.id}`);
        return { receipt: saved, editToken: planned.editToken, confirmation };
      });
    },
    async getReceipt(id) {
      return loadReceipt(pool, id);
    },
    async recordReceiptPayment(input) {
      return withTransaction(pool, async (client): Promise<RecordPaymentResult> => {
        const locked = await client.query(`SELECT id FROM receipts WHERE id = $1 AND mode = $2 FOR UPDATE`, [
          input.receiptId,
          mode,
        ]);
        if (!locked.rows[0]) return { ok: false, code: "not_found" };
        const current = await loadReceipt(client, input.receiptId);
        if (!current) return { ok: false, code: "not_found" };
        const now = new Date().toISOString();
        const planned = planPayment(
          current,
          {
            editToken: input.editToken,
            externalPaymentRef: input.externalPaymentRef,
            amount: input.amount,
            paidAt: input.paidAt ?? now,
          },
          now,
          receiptKey,
        );
        if (!planned.ok) return planned;
        await client.query(
          `INSERT INTO receipt_payments (
             id, receipt_id, mode, payment_index, external_payment_ref, amount, currency,
             paid_at, recorded_at, paid_before_confirmation, over_cap
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            planned.payment.id,
            input.receiptId,
            mode,
            planned.payment.payment_index,
            planned.payment.external_payment_ref,
            planned.payment.amount,
            planned.payment.currency,
            planned.payment.paid_at,
            planned.payment.recorded_at,
            planned.payment.paid_before_confirmation ? 1 : 0,
            planned.payment.over_cap ? 1 : 0,
          ],
        );
        await insertReceiptEvent(client, input.receiptId, planned.event);
        const updated = await client.query(
          `UPDATE receipts
           SET content_hash = $1, signature = $2, updated_at = $3
           WHERE id = $4 AND mode = $5`,
          [planned.contentHash, planned.signature, planned.updatedAt, input.receiptId, mode],
        );
        if ((updated.rowCount ?? 0) !== 1) throw new Error(`Receipt payment update missed ${input.receiptId}`);
        const saved = await loadReceipt(client, input.receiptId);
        if (!saved) throw new Error(`Receipt disappeared: ${input.receiptId}`);
        return {
          ok: true,
          receipt: saved,
          paid_before_confirmation: planned.paidBeforeConfirmation,
          over_cap: planned.overCap,
        };
      });
    },
    async setReceiptVisibility(input) {
      return withTransaction(pool, async (client): Promise<SetReceiptVisibilityResult> => {
        const locked = await client.query(`SELECT id FROM receipts WHERE id = $1 AND mode = $2 FOR UPDATE`, [
          input.receiptId,
          mode,
        ]);
        if (!locked.rows[0]) return { ok: false, code: "not_found" };
        const current = await loadReceipt(client, input.receiptId);
        if (!current) return { ok: false, code: "not_found" };
        if (!editTokenMatches(current.edit_token_hash, input.editToken)) {
          return { ok: false, code: "invalid_edit_token" };
        }
        if (input.publicScope === undefined) {
          await client.query(`UPDATE receipts SET public_view = $1 WHERE id = $2 AND mode = $3`, [
            input.publicView,
            input.receiptId,
            mode,
          ]);
        } else {
          await client.query(`UPDATE receipts SET public_view = $1, public_scope = $2 WHERE id = $3 AND mode = $4`, [
            input.publicView,
            input.publicScope,
            input.receiptId,
            mode,
          ]);
        }
        const saved = await loadReceipt(client, input.receiptId);
        if (!saved) throw new Error(`Receipt disappeared: ${input.receiptId}`);
        return { ok: true, receipt: saved };
      });
    },
    async attachReceiptProof(input) {
      return withTransaction(pool, async (client): Promise<AttachReceiptResult> => {
        const locked = await client.query(`SELECT id FROM receipts WHERE id = $1 AND mode = $2 FOR UPDATE`, [
          input.receiptId,
          mode,
        ]);
        if (!locked.rows[0]) return { ok: false, code: "not_found" };
        const current = await loadReceipt(client, input.receiptId);
        if (!current) return { ok: false, code: "not_found" };
        const planned = planProof(current, input, new Date().toISOString(), receiptKey);
        if (!planned.ok) return planned;
        await client.query(
          `INSERT INTO receipt_proofs (
             id, receipt_id, mode, proof_index, proof_type, proof_value, actual_amount, over_cap, attached_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            planned.proof.id,
            input.receiptId,
            mode,
            planned.proof.proof_index,
            planned.proof.type,
            planned.proof.value,
            planned.proof.actual_amount,
            planned.proof.over_cap ? 1 : 0,
            planned.proof.attached_at,
          ],
        );
        await insertReceiptEvent(client, input.receiptId, planned.event);
        const updated = await client.query(
          `UPDATE receipts
           SET status = $1, content_hash = $2, signature = $3, updated_at = $4
           WHERE id = $5 AND mode = $6`,
          [planned.status, planned.contentHash, planned.signature, planned.updatedAt, input.receiptId, mode],
        );
        if ((updated.rowCount ?? 0) !== 1) throw new Error(`Receipt update missed ${input.receiptId}`);
        const saved = await loadReceipt(client, input.receiptId);
        if (!saved) throw new Error(`Receipt disappeared: ${input.receiptId}`);
        return { ok: true, receipt: saved, over_cap: planned.overCap };
      });
    },
    async readConfirmation(token) {
      return readConfirmation(pool, token);
    },
    async decideConfirmation(token, decision) {
      return withTransaction(pool, (client) => decideConfirmation(client, token, decision));
    },
  };

  async function insertConfirmation(
    client: PoolClient,
    receiptId: string,
    input: CreateReceiptInput,
    createdAt: string,
  ): Promise<CreateReceiptResult["confirmation"]> {
    if (!input.confirmContact) return null;
    const token = newConfirmToken();
    const expiresAt = confirmExpiresAt(createdAt, confirmTtlMs);
    await client.query(
      `INSERT INTO receipt_confirm_tokens (
         id, receipt_id, mode, channel, contact_hash, contact_masked, token_hash,
         expires_at, webhook_url, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        newId("cfm"),
        receiptId,
        mode,
        input.confirmContact.channel,
        hashApproverContact(input.confirmContact.address),
        input.confirmContact.masked,
        hashConfirmToken(token),
        expiresAt,
        input.confirmationWebhookUrl,
        createdAt,
      ],
    );
    return {
      token,
      expiresAt,
      channel: input.confirmContact.channel,
      contactMasked: input.confirmContact.masked,
    };
  }

  function tokenTime(value: string | Date | null): string | null {
    if (value == null) return null;
    return value instanceof Date ? value.toISOString() : value;
  }

  async function selectConfirmToken(client: Pool | PoolClient, token: string, lock: boolean): Promise<ConfirmTokenRow | undefined> {
    if (!isConfirmToken(token)) return undefined;
    const result = await client.query(
      `SELECT receipt_id, channel, contact_masked, expires_at, used_at, decision, webhook_url
       FROM receipt_confirm_tokens WHERE token_hash = $1 AND mode = $2${lock ? " FOR UPDATE" : ""}`,
      [hashConfirmToken(token), mode],
    );
    return result.rows[0] as ConfirmTokenRow | undefined;
  }

  async function readConfirmation(client: Pool | PoolClient, token: string): Promise<ReadConfirmationResult> {
    const row = await selectConfirmToken(client, token, false);
    if (!row) return { ok: false, code: "not_found" };
    const receipt = await loadReceipt(client, row.receipt_id);
    if (!receipt) return { ok: false, code: "not_found" };
    const expiresAt = tokenTime(row.expires_at) ?? "";
    const usedAt = tokenTime(row.used_at);
    const decision = row.decision === "confirmed" || row.decision === "declined" ? row.decision : null;
    return {
      ok: true,
      confirmation: {
        state: confirmTokenState(expiresAt, usedAt, new Date().toISOString()),
        receipt,
        channel: asContactChannel(row.channel),
        contactMasked: row.contact_masked,
        expiresAt,
        decision,
        webhookUrl: row.webhook_url,
      },
    };
  }

  async function decideConfirmation(
    client: PoolClient,
    token: string,
    decision: "confirm" | "decline",
  ): Promise<DecideConfirmationResult> {
    const row = await selectConfirmToken(client, token, true);
    if (!row) return { ok: false, code: "not_found" };
    const now = new Date().toISOString();
    const expiresAt = tokenTime(row.expires_at) ?? "";
    const usedAt = tokenTime(row.used_at);
    const state = confirmTokenState(expiresAt, usedAt, now);
    if (state === "used") return { ok: false, code: "used" };
    if (state === "expired") return { ok: false, code: "expired" };
    const current = await loadReceipt(client, row.receipt_id);
    if (!current) return { ok: false, code: "not_found" };
    const planned = planApproverDecision(
      current,
      { decision, channel: asContactChannel(row.channel), contactMasked: row.contact_masked },
      now,
      receiptKey,
    );
    if (!planned.ok) return planned;
    const marked = await client.query(
      `UPDATE receipt_confirm_tokens
       SET used_at = $1, decision = $2
       WHERE token_hash = $3 AND mode = $4 AND used_at IS NULL`,
      [now, planned.decision, hashConfirmToken(token), mode],
    );
    if ((marked.rowCount ?? 0) !== 1) return { ok: false, code: "used" };
    await insertReceiptEvent(client, row.receipt_id, planned.event);
    const updated = await client.query(
      `UPDATE receipts
       SET approver_decision = $1, approver_decision_at = $2, approver_decision_channel = $3,
           approver_contact_masked = $4, content_hash = $5, signature = $6, updated_at = $7
       WHERE id = $8 AND mode = $9`,
      [
        planned.decision,
        planned.updatedAt,
        planned.channel,
        planned.contactMasked,
        planned.contentHash,
        planned.signature,
        planned.updatedAt,
        row.receipt_id,
        mode,
      ],
    );
    if ((updated.rowCount ?? 0) !== 1) throw new Error(`Receipt confirmation update missed ${row.receipt_id}`);
    const saved = await loadReceipt(client, row.receipt_id);
    if (!saved) throw new Error(`Receipt disappeared: ${row.receipt_id}`);
    return { ok: true, receipt: saved, webhookUrl: row.webhook_url };
  }

  async function loadReceipt(client: Pool | PoolClient, id: string) {
    const headerResult = await client.query(`SELECT ${RECEIPT_HEADER} FROM receipts WHERE id = $1 AND mode = $2`, [
      id,
      mode,
    ]);
    const header = headerResult.rows[0] as ReceiptHeaderRow | undefined;
    if (!header) return undefined;
    const proofResult = await client.query(
      `SELECT id, proof_index, proof_type, proof_value, actual_amount, over_cap, attached_at
       FROM receipt_proofs WHERE receipt_id = $1 AND mode = $2 ORDER BY proof_index ASC`,
      [id, mode],
    );
    const eventResult = await client.query(
      `SELECT id, seq, kind, prev_hash, hash, payload_json, created_at
       FROM receipt_events WHERE receipt_id = $1 AND mode = $2 ORDER BY seq ASC`,
      [id, mode],
    );
    const paymentResult = await client.query(
      `SELECT id, payment_index, external_payment_ref, amount, currency, paid_at, recorded_at,
              paid_before_confirmation, over_cap
       FROM receipt_payments WHERE receipt_id = $1 AND mode = $2 ORDER BY payment_index ASC`,
      [id, mode],
    );
    const emailResult = await client.query(
      `SELECT 1 AS present FROM receipt_confirm_tokens WHERE receipt_id = $1 AND mode = $2 LIMIT 1`,
      [id, mode],
    );
    return assembleReceipt(
      header,
      proofResult.rows as ReceiptProofRow[],
      eventResult.rows as ReceiptEventRow[],
      paymentResult.rows as ReceiptPaymentRow[],
      Boolean(emailResult.rows[0]),
    );
  }

  async function insertReceipt(client: PoolClient, record: ReceiptRecord): Promise<void> {
    await client.query(
      `INSERT INTO receipts (
         id, mode, created_at, updated_at, approver_name, approver_contact_hash, agent_id, agent_name,
         merchant_name, merchant_url, scope, price_cap_amount, price_cap_currency, payment_rail,
         external_payment_ref, status, content_hash, signature, edit_token_hash,
         public_view, public_scope
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
      [
        record.id,
        mode,
        record.created_at,
        record.updated_at,
        record.approver_name,
        record.approver_contact_hash,
        record.agent_id,
        record.agent_name,
        record.merchant_name,
        record.merchant_url,
        record.scope,
        record.price_cap_amount,
        record.price_cap_currency,
        record.payment_rail,
        record.external_payment_ref,
        record.status,
        record.content_hash,
        record.signature,
        record.edit_token_hash,
        record.public_view,
        record.public_scope,
      ],
    );
  }

  async function insertReceiptEvent(
    client: PoolClient,
    receiptId: string,
    event: ReceiptEvent,
  ): Promise<void> {
    await client.query(
      `INSERT INTO receipt_events (
         id, receipt_id, mode, seq, kind, prev_hash, hash, payload_json, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [event.id, receiptId, mode, event.seq, event.kind, event.prev_hash, event.hash, event.payload_json, event.created_at],
    );
  }

  return store;
}
