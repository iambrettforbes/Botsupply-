/**
 * Child process used by the concurrent-release test.
 * Started with `node --import tsx` so it can open the same SQLite file as the parent.
 * Usage: escrow-release-worker.ts <sqlitePath> <jobId>
 */
import { openStore } from "../src/db.js";

const sqlitePath = process.argv[2];
const jobId = process.argv[3];
if (!sqlitePath || !jobId) {
  console.error("usage: escrow-release-worker.ts <sqlitePath> <jobId>");
  process.exit(1);
}

const store = await openStore({ sqlitePath, mode: "dev" });
try {
  const result = await store.releaseJob(jobId, 0);
  if (!process.send) throw new Error("expected to be forked");
  await new Promise<void>((resolve, reject) => {
    process.send?.(result, (error) => (error ? reject(error) : resolve()));
  });
} finally {
  await store.close();
}
