import { buildApp } from "./app.js";
import { resolveSqlitePath } from "./paths.js";

function readPort(): number {
  const raw = process.env.PORT ?? "4317";
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${raw}`);
  }
  return port;
}

const port = readPort();
const sqlitePath = resolveSqlitePath();
const app = await buildApp({ sqlitePath, logger: true });

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
app.log.info({ sqlitePath, port }, "botsupply listening");
