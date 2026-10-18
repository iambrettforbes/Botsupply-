/** Platform fee withheld from the payee when a job is released. 100 bps = 1%. */
export const ESCROW_FEE_BPS_MAX = 10_000;

/** Largest hold accepted by POST /v1/jobs. */
export const ESCROW_AMOUNT_MAX = 1_000_000_000;

export const ESCROW_DESCRIPTION_MAX = 500;

export const ESCROW_IDEMPOTENCY_MAX = 128;

/**
 * Credits kept by the platform on release.
 * `floor(amount * bps / 10000)`, never more than `amount`. The fee is not credited to a wallet.
 */
export function escrowFeeCredits(amountCredits: number, feeBps: number): number {
  if (!Number.isInteger(amountCredits) || amountCredits <= 0) return 0;
  const bps = clampFeeBps(feeBps);
  if (bps === 0) return 0;
  return Math.min(amountCredits, Math.floor((amountCredits * bps) / 10_000));
}

export function clampFeeBps(feeBps: number): number {
  if (!Number.isInteger(feeBps) || feeBps <= 0) return 0;
  return Math.min(feeBps, ESCROW_FEE_BPS_MAX);
}

/**
 * `ESCROW_FEE_BPS` from the environment. Empty or unset is 0.
 * `override` wins when the caller passes a number (tests and BuildOptions).
 */
export function readEscrowFeeBps(raw: string | undefined, override?: number): number {
  if (override !== undefined) {
    if (!Number.isInteger(override) || override < 0 || override > ESCROW_FEE_BPS_MAX) {
      throw new Error(`escrowFeeBps must be an integer from 0 to ${ESCROW_FEE_BPS_MAX}`);
    }
    return override;
  }
  const text = raw?.trim() ?? "";
  if (text === "") return 0;
  if (!/^\d+$/.test(text)) {
    throw new Error(`ESCROW_FEE_BPS must be an integer from 0 to ${ESCROW_FEE_BPS_MAX}`);
  }
  const value = Number(text);
  if (value > ESCROW_FEE_BPS_MAX) {
    throw new Error(`ESCROW_FEE_BPS must be an integer from 0 to ${ESCROW_FEE_BPS_MAX}`);
  }
  return value;
}
