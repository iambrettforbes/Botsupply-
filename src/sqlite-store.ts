import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { StripeMode } from "./stripe.js";
import {
  hashApiKey,
  mapPurchase,
  mapWallet,
  newApiKey,
  newId,
  type ApplyStripeCreditResult,
  type CheckoutSessionRow,
  type CheckoutSessionSave,
  type PurchaseResult,
  type PurchaseRow,
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
`;

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
  };

  return store;
}
