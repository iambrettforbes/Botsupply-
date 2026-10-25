import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isBlockedWebhookHost } from "./receipts.js";

export type ConfirmationWebhook = {
  post(url: string, body: unknown): Promise<void>;
};

/**
 * Best-effort POST. Failures are logged and swallowed so the approver's click
 * is not rolled back when the caller's endpoint is down. Poll `get_receipt`.
 * Redirects are refused. Hosts that resolve to a private address are skipped.
 */
export function liveConfirmationWebhook(timeoutMs = 3_000): ConfirmationWebhook {
  return {
    async post(url, body) {
      let hostname = "";
      try {
        hostname = new URL(url).hostname;
      } catch {
        console.warn("confirmation webhook skipped: url is not absolute");
        return;
      }
      if (!(await hostResolvesPublic(hostname))) {
        console.warn("confirmation webhook skipped: host is not a public address");
        return;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": "BotSupply-Receipts",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
          redirect: "error",
        });
        if (!response.ok) console.warn(`confirmation webhook returned ${response.status}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "failed";
        console.warn(`confirmation webhook failed: ${message}`);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

async function hostResolvesPublic(hostname: string): Promise<boolean> {
  if (isBlockedWebhookHost(hostname)) return false;
  const bare = hostname.replace(/^\[|\]$/g, "");
  if (isIP(bare)) return true;
  try {
    const records = await lookup(bare, { all: true, verbatim: true });
    if (records.length === 0) return false;
    return records.every((record) => !isBlockedWebhookHost(record.address));
  } catch {
    return false;
  }
}
