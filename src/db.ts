import { openPostgresStore } from "./postgres-store.js";
import { loadReceiptSigningKey, readConfirmTtlMs } from "./receipts.js";
import { openSqliteStore } from "./sqlite-store.js";
import type { StripeMode } from "./stripe.js";
import type { Store } from "./store.js";

export type {
  ApplyStripeCreditResult,
  AttachReceiptResult,
  CheckoutSessionRow,
  CheckoutSessionSave,
  CreateJobInput,
  CreateJobResult,
  CreateReceiptResult,
  JobBalances,
  JobRow,
  JobStatus,
  PurchaseResult,
  PurchaseRow,
  SettleJobResult,
  StorageKind,
  Store,
  StripeCreditInput,
  WalletRow,
} from "./store.js";

export type OpenStoreOptions = {
  /** When set, wallets and purchases are stored in Postgres. */
  databaseUrl?: string;
  /** File path, or `:memory:`. Used when `databaseUrl` is unset. */
  sqlitePath: string;
  mode: StripeMode;
  /** HMAC key for receipt hashes. Defaults to `RECEIPT_SIGNING_KEY` or an ephemeral dev key. */
  receiptSigningKey?: Buffer;
  /** Life of a confirm link in milliseconds. Defaults to `RECEIPT_CONFIRM_TTL_SECONDS` or 24 hours. */
  confirmTtlMs?: number;
};

/** Postgres when `databaseUrl` is non-empty. Otherwise the SQLite file. */
export async function openStore(options: OpenStoreOptions): Promise<Store> {
  const databaseUrl = options.databaseUrl?.trim();
  const receiptSigningKey = options.receiptSigningKey ?? loadReceiptSigningKey();
  const confirmTtlMs = readConfirmTtlMs(process.env.RECEIPT_CONFIRM_TTL_SECONDS, options.confirmTtlMs);
  if (databaseUrl) return openPostgresStore(databaseUrl, options.mode, receiptSigningKey, confirmTtlMs);
  if (!options.sqlitePath) throw new Error("sqlitePath is required when DATABASE_URL is unset");
  return openSqliteStore(options.sqlitePath, options.mode, receiptSigningKey, confirmTtlMs);
}
