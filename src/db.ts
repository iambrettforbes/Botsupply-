import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

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

export function openDatabase(sqlitePath: string): Database.Database {
  if (sqlitePath !== ":memory:") {
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  }
  const db = new Database(sqlitePath);
  db.pragma("foreign_keys = ON");
  if (sqlitePath !== ":memory:") {
    db.pragma("journal_mode = WAL");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS wallets (
      id TEXT PRIMARY KEY,
      api_key_hash TEXT NOT NULL UNIQUE,
      balance_credits INTEGER NOT NULL,
      label TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS purchases (
      id TEXT PRIMARY KEY,
      wallet_id TEXT NOT NULL REFERENCES wallets(id),
      sku TEXT NOT NULL,
      credits_charged INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_purchases_wallet ON purchases(wallet_id);
    CREATE TABLE IF NOT EXISTS stripe_checkout_credits (
      session_id TEXT PRIMARY KEY,
      wallet_id TEXT NOT NULL REFERENCES wallets(id),
      credits INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

export function hashApiKey(apiKey: string): string {
  return crypto.createHash("sha256").update(apiKey).digest("hex");
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}

export function createWallet(db: Database.Database, label: string | null): { wallet: WalletRow; apiKey: string } {
  const apiKey = `bsk_${crypto.randomBytes(24).toString("hex")}`;
  const wallet: WalletRow = {
    id: newId("wal"),
    api_key_hash: hashApiKey(apiKey),
    balance_credits: 0,
    label,
    created_at: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO wallets (id, api_key_hash, balance_credits, label, created_at)
     VALUES (@id, @api_key_hash, @balance_credits, @label, @created_at)`,
  ).run(wallet);
  return { wallet, apiKey };
}

export function findWalletById(db: Database.Database, id: string): WalletRow | undefined {
  return db.prepare("SELECT * FROM wallets WHERE id = ?").get(id) as WalletRow | undefined;
}

export function findWalletByApiKey(db: Database.Database, apiKey: string): WalletRow | undefined {
  return db.prepare("SELECT * FROM wallets WHERE api_key_hash = ?").get(hashApiKey(apiKey)) as WalletRow | undefined;
}

export function topUpWallet(db: Database.Database, id: string, credits: number): WalletRow | undefined {
  const updated = db
    .prepare("UPDATE wallets SET balance_credits = balance_credits + ? WHERE id = ?")
    .run(credits, id);
  if (updated.changes === 0) return undefined;
  return findWalletById(db, id);
}

export type PurchaseResult =
  | { ok: true; purchase: PurchaseRow; balance_credits: number }
  | { ok: false; balance_credits: number };

export function purchaseSku(
  db: Database.Database,
  walletId: string,
  sku: string,
  priceCredits: number,
  payload: Record<string, unknown>,
): PurchaseResult {
  const run = db.transaction((): PurchaseResult => {
    const wallet = findWalletById(db, walletId);
    if (!wallet) {
      throw new Error(`Wallet disappeared: ${walletId}`);
    }
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
    db.prepare("UPDATE wallets SET balance_credits = ? WHERE id = ?").run(balance, walletId);
    db.prepare(
      `INSERT INTO purchases (id, wallet_id, sku, credits_charged, payload_json, created_at)
       VALUES (@id, @wallet_id, @sku, @credits_charged, @payload_json, @created_at)`,
    ).run(purchase);
    return { ok: true, purchase, balance_credits: balance };
  });
  return run();
}

export function findPurchase(db: Database.Database, id: string): PurchaseRow | undefined {
  return db.prepare("SELECT * FROM purchases WHERE id = ?").get(id) as PurchaseRow | undefined;
}

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

/**
 * Credits a wallet for a paid Checkout Session. The session id is the idempotency key:
 * a second call with the same id does not add credits again.
 */
export function applyStripeCheckoutCredit(
  db: Database.Database,
  input: { sessionId: string; walletId: string; credits: number },
): ApplyStripeCreditResult {
  if (!input.sessionId || !Number.isInteger(input.credits) || input.credits < 1) {
    return { ok: false, code: "invalid_credit" };
  }
  const run = db.transaction((): ApplyStripeCreditResult => {
    const existing = db
      .prepare("SELECT session_id, wallet_id, credits FROM stripe_checkout_credits WHERE session_id = ?")
      .get(input.sessionId) as { session_id: string; wallet_id: string; credits: number } | undefined;
    if (existing) {
      const wallet = findWalletById(db, existing.wallet_id);
      return {
        ok: true,
        applied: false,
        balance_credits: wallet?.balance_credits ?? 0,
        wallet_id: existing.wallet_id,
        credits: existing.credits,
        session_id: existing.session_id,
      };
    }
    const wallet = findWalletById(db, input.walletId);
    if (!wallet) return { ok: false, code: "wallet_not_found" };
    db.prepare(
      `INSERT INTO stripe_checkout_credits (session_id, wallet_id, credits, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(input.sessionId, input.walletId, input.credits, new Date().toISOString());
    const updated = topUpWallet(db, input.walletId, input.credits);
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
}
