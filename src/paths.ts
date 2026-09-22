import fs from "node:fs";
import path from "node:path";

const PREFERRED_DIR = "/data";
const FILE_NAME = "botsupply.sqlite";

function canWriteDirectory(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-probe-${process.pid}`);
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/** SQLite file path. `SQLITE_PATH` wins, then writable `/data`, then `./data`. */
export function resolveSqlitePath(): string {
  const override = process.env.SQLITE_PATH?.trim();
  if (override) return override;
  if (canWriteDirectory(PREFERRED_DIR)) {
    return path.join(PREFERRED_DIR, FILE_NAME);
  }
  const local = path.resolve("data");
  fs.mkdirSync(local, { recursive: true });
  return path.join(local, FILE_NAME);
}
