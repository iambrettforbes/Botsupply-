import { openPostgresStore } from "./postgres-store.js";
import { openSqliteStore } from "./sqlite-store.js";
import type { StripeMode } from "./stripe.js";
import type { Store } from "./store.js";

export type {
  ApplyStripeCreditResult,
  CheckoutSessionRow,
  CheckoutSessionSave,
  CreateJobInput,
  CreateJobResult,
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
};

/** Postgres when `databaseUrl` is non-empty. Otherwise the SQLite file. */
export async function openStore(options: OpenStoreOptions): Promise<Store> {
  const databaseUrl = options.databaseUrl?.trim();
  if (databaseUrl) return openPostgresStore(databaseUrl, options.mode);
  if (!options.sqlitePath) throw new Error("sqlitePath is required when DATABASE_URL is unset");
  return openSqliteStore(options.sqlitePath, options.mode);
}
