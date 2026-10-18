import { Pool, type PoolClient } from "pg";
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
];

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

export async function openPostgresStore(connectionString: string, mode: StripeMode, pool = createPostgresPool(connectionString)): Promise<Store> {
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
  };

  return store;
}
