---
name: botsupply-receipts
description: Record a BotSupply purchase receipt before an agent pays a merchant, deliver the one-time confirm link to the person, and poll until pay_allowed. Use when a coding or shopping agent buys something for a person and needs a public tamper-evident receipt without BotSupply holding the money.
---

# BotSupply receipts

BotSupply stores a public record of what was reported as approved. It does not hold or move the purchase money, and it does not send email. Verified means the SHA-256 hash chain and server HMAC still match. That check does not prove who approved.

Install this skill with:

```bash
npx skills add iambrettforbes/Botsupply-
```

Hosted MCP endpoint: `https://botsupply.onrender.com/mcp`

REST base: `https://botsupply.onrender.com`

## Before you pay

1. Call `record_approval` (or `POST /v1/receipts`) before paying.
2. Send merchant, scope, price cap, currency, and payment rail (`stripe_link`, `card`, `x402`, `botsupply_wallet`, or another label).
3. Put the person's name in `approver`. That name is what the agent reported. It is not proof of who approved.
4. When a person must confirm, pass their email as `approver_contact`.
5. Keep `edit_token`. It is returned once. Keep `receipt_id` and `receipt_url`.

No wallet and no API key are required for receipts.

## Deliver the confirm link

If the response includes `confirm_url`, you deliver it. BotSupply does not email it. `confirm_delivery` is `caller` unless an email provider is configured, and this service does not ship one.

The link is single-use and expires (default 24 hours). The person opens it, sees the stored scope, price cap, merchant, and agent, and clicks Confirm or Decline. Opening the link does not decide.

Tell them the public page is `receipt_url` (`/r/:id`).

## Wait until pay_allowed

Poll `get_receipt` or `GET /v1/receipts/:id`.

Pay only when `pay_allowed` is true.

- True after `approver_confirmation.status` is `confirmed`.
- Also true when no `approver_contact` was given and the price cap is strictly under `RECEIPT_CONFIRM_THRESHOLD` (default 100, in the price cap's currency).
- At or above that threshold, a receipt with no email contact stays `pay_allowed: false`. Recording a payment does not flip the flag.

`confirmed` means the person who opened that contact's link clicked Confirm. It is not an identity check.

## Pay, then record it

Pay the merchant on your own rail. Then call `record_payment` with the `edit_token`, `external_payment_ref`, and `amount`. `paid_at` is optional and defaults to now.

The call does not reject an early or over-cap payment. It stores the payment and flags it.

On the next read:

- `external_payment_ref` is the latest recorded payment's ref (derived from `receipt_payments`; the stored receipt row is not rewritten).
- Top-level `paid_before_confirmation` is true when any recorded payment was before confirmation.
- Top-level `over_cap` is true when any recorded payment exceeds the price cap.

The public page shows **Paid before confirmation** or **Over approved cap** when those flags are set, and **Confirmed before payment** when the person confirmed first and the amount is within the cap.

## Attach proof and verify

Call `attach_proof` with the `edit_token` after delivery (order id, tracking number, URL, or hash). An amount above the cap is stored and flagged on that proof. It does not move money.

Call `verify_receipt` or `GET /v1/receipts/:id/verify`. `valid: true` means the record has not changed. `valid: false` means it was altered. Do not treat `valid` as proof of who approved.

## Redacted public view

Default `public_view` is `full`. Emails and phones on the public page are masked.

Pass `public_view: "redacted"` on `record_approval`, or change it later with `set_receipt_visibility` (`POST /v1/receipts/:id/visibility`) and the `edit_token`. Optional `public_scope` replaces the scope shown publicly while redacted. The setting is stored outside the hash, so verify still passes and the content hash does not change.

In redacted mode the public JSON and `/r/:id` show:

- Approver initials only, such as `Jane Doe` becoming `J.D.`
- Agent name `Agent`
- No email or phone, not even masked
- Payment refs and proof values as `on file` plus the last 4 remaining characters
- Card phrases such as `ending 1234` removed
- Merchant name and URL kept
- Amounts, cap, timeline, statuses, and the confirmed or paid lines still visible

The page says "Some details hidden by the purchaser." The confirm page still shows the stored text to the person who is confirming. `verify` still uses the full stored row.

## Do not

- Do not pay while `pay_allowed` is false.
- Do not tell the person that BotSupply sent the confirm email.
- Do not describe Verified as proof of who approved.
- Do not expect BotSupply to charge the card or settle the merchant payment. You pay. Then you record it.
