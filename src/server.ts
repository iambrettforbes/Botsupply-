import { buildApp } from "./app.js";
import { resolveSqlitePath } from "./paths.js";
import { stripeModeFromSecret } from "./stripe.js";

function readPort(): number {
  const raw = process.env.PORT ?? "4317";
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${raw}`);
  }
  return port;
}

const port = readPort();
const databaseUrl = process.env.DATABASE_URL?.trim() || undefined;
const sqlitePath = databaseUrl ? ":memory:" : resolveSqlitePath();
const app = await buildApp({ sqlitePath, databaseUrl, logger: true });
const mode = stripeModeFromSecret(process.env.STRIPE_SECRET_KEY ?? "");

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "shutting down");
  await app.close();
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM").then(() => process.exit(0));
});
process.on("SIGINT", () => {
  void shutdown("SIGINT").then(() => process.exit(0));
});

await app.listen({ host: "0.0.0.0", port });
app.log.info(
  { storage: databaseUrl ? "postgres" : "sqlite", sqlitePath: databaseUrl ? undefined : sqlitePath, mode, port },
  "botsupply listening",
);
