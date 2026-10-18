import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { clampFeeBps, escrowFeeCredits } from "./escrow.js";
import type { StripeMode } from "./stripe.js";
import {
  hashApiKey,
  isUniqueConstraint,
  mapJob,
  mapPurchase,
  mapWallet,
  newApiKey,
  newId,
  sameJobRequest,
  type ApplyStripeCreditResult,
  type CheckoutSessionRow,
  type CheckoutSessionSave,
  type CreateJobInput,
  type CreateJobResult,
  type JobBalances,
  type JobRow,
  type PurchaseResult,
  type PurchaseRow,
  type SettleJobResult,
  type Store,
  type StripeCreditInput,
  type WalletRow,
} from "./store.js";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS wallets (
    id TEXT PRIMARY KEY,
    mode TEXT NOT NULL,
    api_key_hash TEXT NOT NULL,
    balance_credits INTEGER NOT NULL,
    label TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (mode, api_key_hash)
  );
  CREATE TABLE IF NOT EXISTS purchases (
    id TEXT PRIMARY KEY,
    mode TEXT NOT NULL,
    wallet_id TEXT NOT NULL REFERENCES wallets(id),
    sku TEXT NOT NULL,
    credits_charged INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_purchases_mode_wallet ON purchases (mode, wallet_id);
  CREATE TABLE IF NOT EXISTS stripe_checkout_sessions (
    session_id TEXT PRIMARY KEY,
    mode TEXT NOT NULL,
    wallet_id TEXT NOT NULL REFERENCES wallets(id),
    credits INTEGER NOT NULL,
    url TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS stripe_checkout_credits (
    session_id TEXT PRIMARY KEY,
    mode TEXT NOT NULL,
    wallet_id TEXT NOT NULL REFERENCES wallets(id),
    credits INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_wallets_mode_hash ON wallets (mode, api_key_hash);
  CREATE TABLE IF NOT EXISTS escrow_jobs (
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
  );
  CREATE INDEX IF NOT EXISTS idx_escrow_jobs_mode_payer ON escrow_jobs (mode, payer_wallet_id);
`;

const JOB_SELECT = `id, payer_wallet_id, payee_wallet_id, amount_credits, description, status,
  idempotency_key, fee_bps, fee_credits, created_at, updated_at`;

function tableColumns(db: Database.Database, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.map((row) => row.name);
}

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

/** Adds `mode` to databases created before mode-scoped storage. Existing rows are dev. */
function migrateLegacyMode(db: Database.Database): void {
  for (const table of ["wallets", "purchases", "stripe_checkout_sessions", "stripe_checkout_credits"]) {
    if (!tableExists(db, table)) continue;
    if (tableColumns(db, table).includes("mode")) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN mode TEXT NOT NULL DEFAULT 'dev'`);
  }
}

function openSqlite(sqlitePath: string): Database.Database {
  if (sqlitePath !== ":memory:") {
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  }
  const db = new Database(sqlitePath);
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  if (sqlitePath !== ":memory:") {
    db.pragma("journal_mode = WAL");
  }
  migrateLegacyMode(db);
  db.exec(SCHEMA);
  return db;
}

export function openSqliteStore(sqlitePath: string, mode: StripeMode): Store {
  const db = openSqlite(sqlitePath);

  function findWalletById(id: string): WalletRow | undefined {
    const row = db
      .prepare(
        `SELECT id, api_key_hash, balance_credits, label, created_at
         FROM wallets WHERE id = ? AND mode = ?`,
      )
      .get(id, mode) as WalletRow | undefined;
    return row ? mapWallet(row) : undefined;
  }

  function topUpWallet(id: string, credits: number): WalletRow | undefined {
    const updated = db
      .prepare("UPDATE wallets SET balance_credits = balance_credits + ? WHERE id = ? AND mode = ?")
      .run(credits, id, mode);
    if (updated.changes === 0) return undefined;
    return findWalletById(id);
  }

  const store: Store = {
    kind: "sqlite",
    mode,
    async ping() {
      db.prepare("SELECT 1").get();
    },
    async close() {
      db.close();
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
      db.prepare(
        `INSERT INTO wallets (id, mode, api_key_hash, balance_credits, label, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(wallet.id, mode, wallet.api_key_hash, wallet.balance_credits, wallet.label, wallet.created_at);
      return { wallet, apiKey };
    },
    async findWalletById(id) {
      return findWalletById(id);
    },
    async findWalletByApiKey(apiKey) {
      const row = db
        .prepare(
          `SELECT id, api_key_hash, balance_credits, label, created_at
           FROM wallets WHERE api_key_hash = ? AND mode = ?`,
        )
        .get(hashApiKey(apiKey), mode) as WalletRow | undefined;
      return row ? mapWallet(row) : undefined;
    },
    async topUpWallet(id, credits) {
      return topUpWallet(id, credits);
    },
    async purchaseSku(walletId, sku, priceCredits, payload) {
      const run = db.transaction((): PurchaseResult => {
        const wallet = findWalletById(walletId);
        if (!wallet) throw new Error(`Wallet disappeared: ${walletId}`);
        if (wallet.balance_credits < priceCredits) {
          return { ok: false, balance_credits: wallet.balance_credits };
        }
        const balance = wallet.balance_credits - priceCredits;
        const purchase: PurchaseRow = {
          id: newId("pur"),
          wallet_id: walletId,
          sku,
          credits_charged: priceCredits,
          payload_json: JSON.stringify(payload),
          created_at: new Date().toISOString(),
        };
        db.prepare("UPDATE wallets SET balance_credits = ? WHERE id = ? AND mode = ?").run(balance, walletId, mode);
        db.prepare(
          `INSERT INTO purchases (id, mode, wallet_id, sku, credits_charged, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          purchase.id,
          mode,
          purchase.wallet_id,
          purchase.sku,
          purchase.credits_charged,
          purchase.payload_json,
          purchase.created_at,
        );
        return { ok: true, purchase, balance_credits: balance };
      });
      return run();
    },
    async findPurchase(id) {
      const row = db
        .prepare(
          `SELECT id, wallet_id, sku, credits_charged, payload_json, created_at
           FROM purchases WHERE id = ? AND mode = ?`,
        )
        .get(id, mode) as PurchaseRow | undefined;
      return row ? mapPurchase(row) : undefined;
    },
    async saveCheckoutSessionUrl(input: CheckoutSessionSave) {
      db.prepare(
        `INSERT INTO stripe_checkout_sessions (session_id, mode, wallet_id, credits, url, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET url = excluded.url`,
      ).run(input.sessionId, mode, input.walletId, input.credits, input.url, new Date().toISOString());
    },
    async findCheckoutSessionUrl(sessionId) {
      return db
        .prepare(
          `SELECT session_id, wallet_id, credits, url
           FROM stripe_checkout_sessions WHERE session_id = ? AND mode = ?`,
        )
        .get(sessionId, mode) as CheckoutSessionRow | undefined;
    },
    async applyStripeCheckoutCredit(input: StripeCreditInput): Promise<ApplyStripeCreditResult> {
      if (!input.sessionId || !Number.isInteger(input.credits) || input.credits < 1) {
        return { ok: false, code: "invalid_credit" };
      }
      const run = db.transaction((): ApplyStripeCreditResult => {
        const existing = db
          .prepare(
            `SELECT session_id, wallet_id, credits
             FROM stripe_checkout_credits WHERE session_id = ? AND mode = ?`,
          )
          .get(input.sessionId, mode) as { session_id: string; wallet_id: string; credits: number } | undefined;
        if (existing) {
          const wallet = findWalletById(existing.wallet_id);
          return {
            ok: true,
            applied: false,
            balance_credits: wallet?.balance_credits ?? 0,
            wallet_id: existing.wallet_id,
            credits: existing.credits,
            session_id: existing.session_id,
          };
        }
        const wallet = findWalletById(input.walletId);
        if (!wallet) return { ok: false, code: "wallet_not_found" };
        db.prepare(
          `INSERT INTO stripe_checkout_credits (session_id, mode, wallet_id, credits, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(input.sessionId, mode, input.walletId, input.credits, new Date().toISOString());
        const updated = topUpWallet(input.walletId, input.credits);
        if (!updated) return { ok: false, code: "wallet_not_found" };
        return {
          ok: true,
          applied: true,
          balance_credits: updated.balance_credits,
          wallet_id: updated.id,
          credits: input.credits,
          session_id: input.sessionId,
        };
      });
      return run();
    },
    async createJob(input) {
      if (!Number.isInteger(input.amountCredits) || input.amountCredits < 1) {
        return { ok: false, code: "invalid_amount" };
      }
      if (input.payerWalletId === input.payeeWalletId) return { ok: false, code: "same_wallet" };
      const run = db.transaction((): CreateJobResult => {
        const existing = selectJob(
          "mode = ? AND payer_wallet_id = ? AND idempotency_key = ?",
          mode,
          input.payerWalletId,
          input.idempotencyKey,
        );
        if (existing) return replayCreate(input, existing);
        return insertHeldJob(input);
      });
      try {
        return run.immediate();
      } catch (error) {
        if (!isUniqueConstraint(error)) throw error;
        const existing = selectJob(
          "mode = ? AND payer_wallet_id = ? AND idempotency_key = ?",
          mode,
          input.payerWalletId,
          input.idempotencyKey,
        );
        if (!existing) throw error;
        return replayCreate(input, existing);
      }
    },
    async getJob(id) {
      return selectJob("id = ? AND mode = ?", id, mode);
    },
    async releaseJob(id, feeBps) {
      const run = db.transaction((): SettleJobResult =>
        settle(id, "released", (job) => {
          const feeCredits = escrowFeeCredits(job.amount_credits, feeBps);
          return {
            feeBps: clampFeeBps(feeBps),
            feeCredits,
            creditWalletId: job.payee_wallet_id,
            credit: job.amount_credits - feeCredits,
          };
        }),
      );
      return run.immediate();
    },
    async refundJob(id) {
      const run = db.transaction((): SettleJobResult =>
        settle(id, "refunded", (job) => ({
          feeBps: 0,
          feeCredits: 0,
          creditWalletId: job.payer_wallet_id,
          credit: job.amount_credits,
        })),
      );
      return run.immediate();
    },
  };

  function selectJob(where: string, ...params: string[]): JobRow | undefined {
    const row = db.prepare(`SELECT ${JOB_SELECT} FROM escrow_jobs WHERE ${where}`).get(...params) as
      | Parameters<typeof mapJob>[0]
      | undefined;
    return row ? mapJob(row) : undefined;
  }

  function walletBalances(payerId: string, payeeId: string): JobBalances {
    return {
      payer_balance_credits: findWalletById(payerId)?.balance_credits ?? 0,
      payee_balance_credits: findWalletById(payeeId)?.balance_credits ?? 0,
    };
  }

  function replayCreate(input: CreateJobInput, job: JobRow): CreateJobResult {
    if (!sameJobRequest(job, input)) return { ok: false, code: "idempotency_conflict", job };
    return { ok: true, job, replay: true, ...walletBalances(job.payer_wallet_id, job.payee_wallet_id) };
  }

  function insertHeldJob(input: CreateJobInput): CreateJobResult {
    const payer = findWalletById(input.payerWalletId);
    const payee = findWalletById(input.payeeWalletId);
    if (!payer) return { ok: false, code: "wallet_not_found", which: "payer" };
    if (!payee) return { ok: false, code: "wallet_not_found", which: "payee" };
    const debited = db
      .prepare(
        `UPDATE wallets SET balance_credits = balance_credits - ?
         WHERE id = ? AND mode = ? AND balance_credits >= ?`,
      )
      .run(input.amountCredits, input.payerWalletId, mode, input.amountCredits);
    if (debited.changes !== 1) {
      return { ok: false, code: "insufficient_credits", balance_credits: findWalletById(input.payerWalletId)?.balance_credits ?? 0 };
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
    db.prepare(
      `INSERT INTO escrow_jobs (
         id, mode, payer_wallet_id, payee_wallet_id, amount_credits, description, status,
         idempotency_key, fee_bps, fee_credits, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
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
    );
    return {
      ok: true,
      job,
      replay: false,
      payer_balance_credits: payer.balance_credits - input.amountCredits,
      payee_balance_credits: payee.balance_credits,
    };
  }

  function settle(
    id: string,
    next: "released" | "refunded",
    apply: (job: JobRow) => { feeBps: number; feeCredits: number; creditWalletId: string; credit: number },
  ): SettleJobResult {
    const job = selectJob("id = ? AND mode = ?", id, mode);
    if (!job) return { ok: false, code: "not_found" };
    if (job.status !== "held") return { ok: false, code: "not_held", status: job.status };
    const payer = findWalletById(job.payer_wallet_id);
    const payee = findWalletById(job.payee_wallet_id);
    if (!payer || !payee) return { ok: false, code: "not_found" };
    const effect = apply(job);
    const now = new Date().toISOString();
    const updated = db
      .prepare(
        `UPDATE escrow_jobs
         SET status = ?, fee_bps = ?, fee_credits = ?, updated_at = ?
         WHERE id = ? AND mode = ? AND status = 'held'`,
      )
      .run(next, effect.feeBps, effect.feeCredits, now, id, mode);
    if (updated.changes !== 1) {
      const again = selectJob("id = ? AND mode = ?", id, mode);
      return { ok: false, code: "not_held", status: again?.status ?? job.status };
    }
    const credited = db
      .prepare("UPDATE wallets SET balance_credits = balance_credits + ? WHERE id = ? AND mode = ?")
      .run(effect.credit, effect.creditWalletId, mode);
    if (credited.changes !== 1) throw new Error(`Escrow credit missed wallet ${effect.creditWalletId}`);
    const saved = selectJob("id = ? AND mode = ?", id, mode);
    if (!saved) throw new Error(`Escrow job disappeared: ${id}`);
    return { ok: true, job: saved, ...walletBalances(saved.payer_wallet_id, saved.payee_wallet_id) };
  }

  return store;
}
