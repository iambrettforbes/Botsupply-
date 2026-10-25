/**
 * Delivery of an approver confirm link.
 *
 * Email is the only channel implemented as a slot today. SMS can use the same
 * `ApprovalNotice` later (`channel: "sms"`) without changing the confirm page.
 *
 * No provider is bundled. When nothing is configured, `configured` is false and
 * `send` is not called. The HTTP handler returns `confirm_url` so the caller
 * can deliver the link itself.
 */

export type ApprovalNotice = {
  channel: "email" | "sms";
  to: string;
  confirmUrl: string;
  receiptId: string;
  merchantName: string;
  scope: string;
  priceCapAmount: string;
  priceCapCurrency: string;
  agentLabel: string | null;
  expiresAt: string;
};

export type ApprovalNotifier = {
  /** False when this process will not deliver the link. */
  readonly configured: boolean;
  /** Provider id from the environment, or `none`. */
  readonly provider: string;
  send(notice: ApprovalNotice): Promise<void>;
};

export function unconfiguredApprovalNotifier(provider = "none"): ApprovalNotifier {
  return {
    configured: false,
    provider,
    async send() {
      throw new Error("No approval notifier is configured");
    },
  };
}

/**
 * Env vars a future provider would read. None of them send mail in this build.
 *
 * - `RECEIPT_EMAIL_PROVIDER` — unset or `none` (default). Any other value is
 *   recognized and ignored until a provider is wired up.
 * - `RECEIPT_EMAIL_FROM` — from address that provider would use.
 * - `RECEIPT_EMAIL_API_KEY` — secret that provider would use. Do not commit it.
 */
export function approvalNotifierFromEnv(env: NodeJS.ProcessEnv = process.env): ApprovalNotifier {
  const provider = env.RECEIPT_EMAIL_PROVIDER?.trim().toLowerCase() ?? "";
  if (provider.length === 0 || provider === "none") return unconfiguredApprovalNotifier();
  console.warn(
    `RECEIPT_EMAIL_PROVIDER=${provider} is not implemented. No email will be sent. record_approval will return confirm_url for the caller to deliver. A future provider would also read RECEIPT_EMAIL_FROM and RECEIPT_EMAIL_API_KEY.`,
  );
  return unconfiguredApprovalNotifier(provider);
}
