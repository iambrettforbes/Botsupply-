import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import {
  CONFIRM_THRESHOLD_NOTICE,
  maskSensitiveText,
  planApproval,
  readConfirmThreshold,
} from "../src/receipts.js";

const SIGNING_KEY = "test-receipt-signing-key";
const CONTACT = "ada.secret@example.com";
const RAW_EMAIL = "ivan@gmail.com";
const RAW_PHONE = "+1 (415) 555-2671";
const MASKED_EMAIL = "i***@gmail.com";
const MASKED_PHONE = "+* (***) ***-**71";
const BYLINE = /class="byline"><a href="https:\/\/botsupply\.onrender\.com">Verified by BotSupply<\/a>/;

type ReceiptBody = {
  receipt_id: string;
  edit_token?: string;
  confirm_url?: string;
  status: string;
  content_hash: string;
  approver: string;
  scope: string;
  pay_allowed: boolean;
  confirm_notice: string | null;
  merchant: { name: string };
  price_cap: { amount: string; currency: string };
  approver_confirmation: { status: string; at: string | null };
  proofs: Array<{ value: string }>;
  payments: Array<{
    external_payment_ref: string;
    amount: string;
    currency: string;
    paid_at: string;
    recorded_at: string;
    paid_before_confirmation: boolean;
    over_cap: boolean;
  }>;
  timeline: Array<{ seq: number; kind: string; hash: string; prev_hash: string }>;
  paid_before_confirmation?: boolean;
  over_cap?: boolean;
};

type VerifyBody = {
  valid: boolean;
  checks: { chain: boolean; content: boolean; signature: boolean };
  content_hash: string;
};

type Rpc = {
  result?: {
    isError?: boolean;
    content?: Array<{ type: string; text?: string }>;
    tools?: Array<{ name: string; description?: string }>;
  };
  error?: { message?: string };
};

function approval(overrides: Record<string, unknown> = {}) {
  return {
    approver: "Ada Lovelace",
    approver_contact: CONTACT,
    agent_id: "agent_demo",
    agent_name: "Desk Agent",
    merchant_name: "North Market",
    merchant_url: "https://north.example/shop",
    scope: "Two bags of coffee, delivery this week",
    price_cap_amount: "25.00",
    price_cap_currency: "usd",
    payment_rail: "stripe_link",
    ...overrides,
  };
}

async function appWith(extra: Parameters<typeof buildApp>[0] = {}) {
  return buildApp({
    sqlitePath: ":memory:",
    mode: "dev",
    receiptSigningKey: SIGNING_KEY,
    ...extra,
  });
}

function postReceipt(app: FastifyInstance, body: Record<string, unknown> = approval()) {
  return app.inject({ method: "POST", url: "/v1/receipts", payload: body });
}

function tokenFrom(url: string): string {
  const token = url.split("/c/")[1] ?? "";
  return decodeURIComponent(token);
}

async function confirm(app: FastifyInstance, confirmUrl: string) {
  const token = tokenFrom(confirmUrl);
  return app.inject({ method: "POST", url: `/c/${encodeURIComponent(token)}/confirm` });
}

async function rpc(app: FastifyInstance, method: string, params: Record<string, unknown>): Promise<Rpc> {
  const response = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    payload: { jsonrpc: "2.0", id: 1, method, params },
  });
  assert.equal(response.statusCode, 200, response.body);
  const type = String(response.headers["content-type"] ?? "");
  if (type.includes("text/event-stream")) {
    const line = response.body.split("\n").find((entry) => entry.startsWith("data:"));
    assert.ok(line, response.body);
    return JSON.parse(line.slice(5).trim()) as Rpc;
  }
  return response.json() as Rpc;
}

function toolJson(message: Rpc): { isError: boolean; body: unknown } {
  assert.equal(message.error, undefined, JSON.stringify(message.error));
  const text = message.result?.content?.find((block) => block.type === "text")?.text;
  assert.equal(typeof text, "string");
  return { isError: message.result?.isError === true, body: JSON.parse(text ?? "null") as unknown };
}

test("confirm threshold parses and defaults to 100", () => {
  assert.equal(readConfirmThreshold(undefined), "100");
  assert.equal(readConfirmThreshold(""), "100");
  assert.equal(readConfirmThreshold("100.00"), "100");
  assert.equal(readConfirmThreshold("0"), "0");
  assert.equal(readConfirmThreshold("40", "15"), "15");
  assert.throws(() => readConfirmThreshold("nope"), /RECEIPT_CONFIRM_THRESHOLD/);
  assert.equal(maskSensitiveText(`Ship to ${RAW_EMAIL} or call ${RAW_PHONE}`), `Ship to ${MASKED_EMAIL} or call ${MASKED_PHONE}`);
  assert.equal(maskSensitiveText("ord_123 and 25.00"), "ord_123 and 25.00");
});

test("approval snapshots stay free of payment fields", () => {
  const planned = planApproval(
    {
      approverName: "Ada Lovelace",
      approverContactHash: null,
      confirmContact: null,
      confirmationWebhookUrl: null,
      agentId: null,
      agentName: null,
      merchantName: "North Market",
      merchantUrl: null,
      scope: "Two bags of coffee",
      priceCapAmount: "25",
      priceCapCurrency: "USD",
      paymentRail: "card",
      externalPaymentRef: null,
    },
    "dev",
    "2026-01-01T00:00:00.000Z",
    Buffer.from(SIGNING_KEY),
  );
  assert.equal(planned.event.payload_json.includes("payments"), false);
  assert.equal(planned.event.payload_json.includes("pay_allowed"), false);
  assert.equal(planned.event.payload_json.includes("email_approver"), false);
  assert.equal(planned.record.payments.length, 0);
});

test("pay_allowed follows confirmation and the threshold", async () => {
  const app = await appWith();
  try {
    const under = await postReceipt(app, approval({ approver_contact: undefined, price_cap_amount: "99.99" }));
    assert.equal(under.statusCode, 201, under.body);
    const underBody = under.json() as ReceiptBody;
    assert.equal(underBody.pay_allowed, true);
    assert.equal(underBody.confirm_notice, null);

    const atCap = await postReceipt(app, approval({ approver_contact: undefined, price_cap_amount: "100" }));
    assert.equal(atCap.statusCode, 201, atCap.body);
    const atBody = atCap.json() as ReceiptBody;
    assert.equal(atBody.pay_allowed, false);
    assert.equal(atBody.confirm_notice, CONFIRM_THRESHOLD_NOTICE);
    const atPage = await app.inject({ method: "GET", url: `/r/${atBody.receipt_id}` });
    assert.match(atPage.body, /No approver contact; confirmation required above threshold/);
    assert.match(atPage.body, /Approved by agent report/);
    assert.match(atPage.body, /<strong>Approver confirmed<\/strong>/);
    assert.match(atPage.body, /<strong>Paid<\/strong>/);
    assert.match(atPage.body, BYLINE);
    assert.doesNotMatch(atPage.body, /Agent Paid/);

    const emailHigh = await postReceipt(app, approval({ price_cap_amount: "150" }));
    const emailBody = emailHigh.json() as ReceiptBody;
    assert.equal(emailBody.pay_allowed, false);
    assert.equal(emailBody.confirm_notice, null);
    assert.equal(emailHigh.body.includes(CONFIRM_THRESHOLD_NOTICE), false);

    const phone = await postReceipt(app, approval({ approver_contact: "+15551212", price_cap_amount: "100" }));
    const phoneBody = phone.json() as ReceiptBody;
    assert.equal(phoneBody.pay_allowed, false);
    assert.equal(phoneBody.confirm_notice, CONFIRM_THRESHOLD_NOTICE);

    const decided = await confirm(app, emailBody.confirm_url ?? "");
    assert.equal(decided.statusCode, 200, decided.body);
    assert.match(decided.body, BYLINE);
    const allowed = await app.inject({ method: "GET", url: `/v1/receipts/${emailBody.receipt_id}` });
    assert.equal((allowed.json() as ReceiptBody).pay_allowed, true);

    const custom = await buildApp({
      sqlitePath: ":memory:",
      mode: "dev",
      receiptSigningKey: SIGNING_KEY,
      confirmThreshold: "50",
    });
    try {
      const below = await postReceipt(custom, approval({ approver_contact: undefined, price_cap_amount: "49.99" }));
      assert.equal((below.json() as ReceiptBody).pay_allowed, true);
      const above = await postReceipt(custom, approval({ approver_contact: undefined, price_cap_amount: "50" }));
      assert.equal((above.json() as ReceiptBody).pay_allowed, false);
      assert.equal((above.json() as ReceiptBody).confirm_notice, CONFIRM_THRESHOLD_NOTICE);
    } finally {
      await custom.close();
    }
  } finally {
    await app.close();
  }
});

test("record_payment appends a flagged chain event and does not reject early or over-cap payments", async () => {
  const app = await appWith();
  try {
    const created = await postReceipt(app);
    const receipt = created.json() as ReceiptBody;
    assert.equal(receipt.pay_allowed, false);
    const early = await app.inject({
      method: "POST",
      url: `/v1/receipts/${receipt.receipt_id}/payment`,
      payload: { edit_token: receipt.edit_token, external_payment_ref: "pi_early", amount: "30" },
    });
    assert.equal(early.statusCode, 200, early.body);
    const earlyBody = early.json() as ReceiptBody;
    assert.equal(earlyBody.paid_before_confirmation, true);
    assert.equal(earlyBody.over_cap, true);
    assert.equal(earlyBody.payments.length, 1);
    assert.equal(earlyBody.payments[0]?.paid_before_confirmation, true);
    assert.equal(earlyBody.payments[0]?.over_cap, true);
    assert.equal(earlyBody.payments[0]?.amount, "30");
    assert.equal(earlyBody.payments[0]?.currency, "USD");
    assert.equal(earlyBody.payments[0]?.external_payment_ref, "pi_early");
    assert.equal(earlyBody.timeline.at(-1)?.kind, "payment_recorded");
    assert.equal(earlyBody.timeline.at(-1)?.prev_hash, receipt.content_hash);
    assert.equal(early.body.includes(receipt.edit_token ?? "missing"), false);
    assert.equal(earlyBody.status, "approved");
    const earlyVerify = await app.inject({ method: "GET", url: `/v1/receipts/${receipt.receipt_id}/verify` });
    assert.equal((earlyVerify.json() as VerifyBody).valid, true);
    const earlyPage = await app.inject({ method: "GET", url: `/r/${receipt.receipt_id}` });
    assert.match(earlyPage.body, /Paid before confirmation/);
    assert.match(earlyPage.body, /Over approved cap/);
    assert.doesNotMatch(earlyPage.body, /Confirmed before payment/);
    assert.doesNotMatch(earlyPage.body, /Agent Paid/);
    assert.match(earlyPage.body, /pi_early/);

    const decided = await confirm(app, receipt.confirm_url ?? "");
    assert.equal(decided.statusCode, 200, decided.body);
    const afterConfirm = await app.inject({ method: "GET", url: `/v1/receipts/${receipt.receipt_id}` });
    const confirmed = afterConfirm.json() as ReceiptBody;
    assert.equal(confirmed.pay_allowed, true);
    assert.equal(confirmed.payments[0]?.paid_before_confirmation, true);
    assert.equal((await app.inject({ method: "GET", url: `/v1/receipts/${receipt.receipt_id}/verify` })).json().valid, true);

    const clean = await postReceipt(app, approval({ price_cap_amount: "40" }));
    const cleanBody = clean.json() as ReceiptBody;
    await confirm(app, cleanBody.confirm_url ?? "");
    const seen = (await app.inject({ method: "GET", url: `/v1/receipts/${cleanBody.receipt_id}` })).json() as ReceiptBody;
    const confirmAt = seen.approver_confirmation.at ?? "";
    assert.ok(confirmAt);
    const sameTime = await app.inject({
      method: "POST",
      url: `/v1/receipts/${cleanBody.receipt_id}/payment`,
      payload: {
        edit_token: cleanBody.edit_token,
        external_payment_ref: "pi_same",
        amount: "40",
        paid_at: confirmAt,
      },
    });
    assert.equal(sameTime.statusCode, 200, sameTime.body);
    const sameBody = sameTime.json() as ReceiptBody;
    assert.equal(sameBody.paid_before_confirmation, false);
    assert.equal(sameBody.over_cap, false);
    const samePage = await app.inject({ method: "GET", url: `/r/${cleanBody.receipt_id}` });
    assert.match(samePage.body, /Confirmed before payment/);
    assert.doesNotMatch(samePage.body, /Paid before confirmation/);
    assert.doesNotMatch(samePage.body, /Over approved cap/);
    assert.match(samePage.body, new RegExp(confirmAt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(samePage.body, /Approved by agent report/);

    const before = new Date(Date.parse(confirmAt) - 60_000).toISOString();
    const backdated = await app.inject({
      method: "POST",
      url: `/v1/receipts/${cleanBody.receipt_id}/payment`,
      payload: {
        edit_token: cleanBody.edit_token,
        external_payment_ref: "pi_back",
        amount: "10",
        paid_at: before,
      },
    });
    assert.equal(backdated.statusCode, 200, backdated.body);
    const backBody = backdated.json() as ReceiptBody;
    assert.equal(backBody.payments.length, 2);
    assert.equal(backBody.payments[1]?.paid_before_confirmation, true);
    assert.equal(backBody.timeline.length, 4);
    assert.equal(backBody.pay_allowed, true);
    const backPage = await app.inject({ method: "GET", url: `/r/${cleanBody.receipt_id}` });
    assert.match(backPage.body, /Paid before confirmation/);
    assert.doesNotMatch(backPage.body, /Confirmed before payment/);
    const backVerify = await app.inject({ method: "GET", url: `/v1/receipts/${cleanBody.receipt_id}/verify` });
    assert.equal((backVerify.json() as VerifyBody).valid, true);

    const proved = await app.inject({
      method: "POST",
      url: `/v1/receipts/${cleanBody.receipt_id}/proof`,
      payload: { edit_token: cleanBody.edit_token, type: "order_confirmation", value: "ord_123", actual_amount: "40" },
    });
    assert.equal(proved.statusCode, 200, proved.body);
    const provedBody = proved.json() as ReceiptBody;
    assert.equal(provedBody.status, "delivered");
    assert.equal(provedBody.proofs[0]?.value, "ord_123");
    assert.equal(provedBody.payments.length, 2);
    assert.equal((await app.inject({ method: "GET", url: `/v1/receipts/${cleanBody.receipt_id}/verify` })).json().valid, true);

    const open = await postReceipt(app, approval({ approver_contact: undefined, price_cap_amount: "20" }));
    const openBody = open.json() as ReceiptBody;
    assert.equal(openBody.pay_allowed, true);
    const paid = await app.inject({
      method: "POST",
      url: `/v1/receipts/${openBody.receipt_id}/payment`,
      payload: { edit_token: openBody.edit_token, external_payment_ref: "pi_open", amount: "20" },
    });
    const paidBody = paid.json() as ReceiptBody;
    assert.equal(paidBody.paid_before_confirmation, false);
    assert.equal(paidBody.over_cap, false);
    const paidPage = await app.inject({ method: "GET", url: `/r/${openBody.receipt_id}` });
    assert.doesNotMatch(paidPage.body, /Confirmed before payment/);
    assert.doesNotMatch(paidPage.body, /Paid before confirmation/);
    assert.match(paidPage.body, /pi_open/);

    const badToken = await app.inject({
      method: "POST",
      url: `/v1/receipts/${openBody.receipt_id}/payment`,
      payload: { edit_token: "rctok_nope", external_payment_ref: "pi_no", amount: "1" },
    });
    assert.equal(badToken.statusCode, 403, badToken.body);
    assert.equal(badToken.json().error.code, "invalid_edit_token");
    const badAmount = await app.inject({
      method: "POST",
      url: `/v1/receipts/${openBody.receipt_id}/payment`,
      payload: { edit_token: openBody.edit_token, external_payment_ref: "pi_no", amount: "0" },
    });
    assert.equal(badAmount.statusCode, 400, badAmount.body);
    const badTime = await app.inject({
      method: "POST",
      url: `/v1/receipts/${openBody.receipt_id}/payment`,
      payload: { edit_token: openBody.edit_token, external_payment_ref: "pi_no", amount: "1", paid_at: "yesterday" },
    });
    assert.equal(badTime.statusCode, 400, badTime.body);
    const still = await app.inject({ method: "GET", url: `/v1/receipts/${openBody.receipt_id}` });
    assert.equal((still.json() as ReceiptBody).payments.length, 1);
  } finally {
    await app.close();
  }
});

test("public receipt reads mask emails and phones without changing the stored hash", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "botsupply-mask-"));
  const sqlitePath = path.join(dir, "botsupply.sqlite");
  const app = await buildApp({ sqlitePath, mode: "dev", receiptSigningKey: SIGNING_KEY });
  try {
    const created = await postReceipt(
      app,
      approval({
        approver: `Ivan ${RAW_EMAIL}`,
        merchant_name: `Cafe ${RAW_PHONE}`,
        scope: `Deliver to ${RAW_EMAIL}. Call ${RAW_PHONE}.`,
        approver_contact: undefined,
        price_cap_amount: "10",
      }),
    );
    assert.equal(created.statusCode, 201, created.body);
    const receipt = created.json() as ReceiptBody;
    assert.equal(receipt.approver, `Ivan ${MASKED_EMAIL}`);
    assert.equal(receipt.merchant.name, `Cafe ${MASKED_PHONE}`);
    assert.equal(receipt.scope, `Deliver to ${MASKED_EMAIL}. Call ${MASKED_PHONE}.`);
    assert.equal(created.body.includes(RAW_EMAIL), false);
    assert.equal(created.body.includes(RAW_PHONE), false);
    const hash = receipt.content_hash;

    const proof = await app.inject({
      method: "POST",
      url: `/v1/receipts/${receipt.receipt_id}/proof`,
      payload: { edit_token: receipt.edit_token, type: "note", value: `buyer ${RAW_EMAIL}` },
    });
    assert.equal(proof.statusCode, 200, proof.body);
    assert.equal((proof.json() as ReceiptBody).proofs[0]?.value, `buyer ${MASKED_EMAIL}`);
    assert.equal(proof.body.includes(RAW_EMAIL), false);

    const seen = await app.inject({ method: "GET", url: `/v1/receipts/${receipt.receipt_id}` });
    assert.equal(seen.body.includes(RAW_EMAIL), false);
    assert.equal(seen.body.includes(RAW_PHONE), false);
    assert.match(seen.body, /i\*\*\*@gmail\.com/);
    const page = await app.inject({ method: "GET", url: `/r/${receipt.receipt_id}` });
    assert.equal(page.body.includes(RAW_EMAIL), false);
    assert.equal(page.body.includes(RAW_PHONE), false);
    assert.match(page.body, /i\*\*\*@gmail\.com/);
    assert.match(page.body, BYLINE);
    assert.doesNotMatch(page.body, /Agent Paid/);
    const verified = await app.inject({ method: "GET", url: `/v1/receipts/${receipt.receipt_id}/verify` });
    const verdict = verified.json() as VerifyBody;
    assert.equal(verdict.valid, true);
    assert.notEqual(verdict.content_hash, hash);
  } finally {
    await app.close();
  }

  const db = new Database(sqlitePath, { readonly: true });
  const row = db.prepare("SELECT approver_name, merchant_name, scope FROM receipts").get() as {
    approver_name: string;
    merchant_name: string;
    scope: string;
  };
  assert.equal(row.approver_name, `Ivan ${RAW_EMAIL}`);
  assert.equal(row.merchant_name, `Cafe ${RAW_PHONE}`);
  assert.equal(row.scope, `Deliver to ${RAW_EMAIL}. Call ${RAW_PHONE}.`);
  const proof = db.prepare("SELECT proof_value FROM receipt_proofs").get() as { proof_value: string };
  assert.equal(proof.proof_value, `buyer ${RAW_EMAIL}`);
  const payloads = db.prepare("SELECT payload_json FROM receipt_events ORDER BY seq").all() as Array<{ payload_json: string }>;
  assert.equal(payloads[0]?.payload_json.includes(RAW_EMAIL), true);
  assert.equal(payloads[0]?.payload_json.includes("payments"), false);
  assert.equal(payloads[1]?.payload_json.includes(RAW_EMAIL), true);
  db.close();

  const again = await buildApp({ sqlitePath, mode: "dev", receiptSigningKey: SIGNING_KEY });
  try {
    const lookup = new Database(sqlitePath, { readonly: true });
    const rows = lookup.prepare("SELECT id FROM receipts").get() as { id: string };
    lookup.close();
    const verified = await again.inject({ method: "GET", url: `/v1/receipts/${rows.id}/verify` });
    assert.equal((verified.json() as VerifyBody).valid, true);
    const page = await again.inject({ method: "GET", url: `/r/${rows.id}` });
    assert.equal(page.body.includes(RAW_EMAIL), false);
    assert.match(page.body, /class="badge ok">Verified</);
  } finally {
    await again.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a tampered receipt is not re-signed by record_payment", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "botsupply-pay-tamper-"));
  const sqlitePath = path.join(dir, "botsupply.sqlite");
  const app = await buildApp({ sqlitePath, mode: "dev", receiptSigningKey: SIGNING_KEY });
  let id = "";
  let token = "";
  try {
    const created = await postReceipt(app, approval({ approver_contact: undefined, price_cap_amount: "10" }));
    const receipt = created.json() as ReceiptBody;
    id = receipt.receipt_id;
    token = receipt.edit_token ?? "";
  } finally {
    await app.close();
  }
  const db = new Database(sqlitePath);
  db.prepare("UPDATE receipts SET scope = ? WHERE id = ?").run("changed", id);
  db.close();
  const again = await buildApp({ sqlitePath, mode: "dev", receiptSigningKey: SIGNING_KEY });
  try {
    const paid = await again.inject({
      method: "POST",
      url: `/v1/receipts/${id}/payment`,
      payload: { edit_token: token, external_payment_ref: "pi_tamper", amount: "10" },
    });
    assert.equal(paid.statusCode, 409, paid.body);
    assert.equal(paid.json().error.code, "receipt_tampered");
    const verified = await again.inject({ method: "GET", url: `/v1/receipts/${id}/verify` });
    assert.equal((verified.json() as VerifyBody).valid, false);
    const seen = await again.inject({ method: "GET", url: `/v1/receipts/${id}` });
    assert.equal((seen.json() as ReceiptBody).payments.length, 0);
  } finally {
    await again.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP record_payment is the fourteenth tool and follows pay_allowed", async () => {
  const app = await appWith();
  try {
    const listed = await rpc(app, "tools/list", {});
    const tools = listed.result?.tools ?? [];
    assert.equal(tools.length, 14);
    const payment = tools.find((tool) => tool.name === "record_payment");
    const getReceipt = tools.find((tool) => tool.name === "get_receipt");
    assert.match(payment?.description ?? "", /payment_recorded/);
    assert.match(payment?.description ?? "", /paid_before_confirmation/);
    assert.match(payment?.description ?? "", /does not hold or move the money/i);
    assert.match(payment?.description ?? "", /pay only when pay_allowed is true/i);
    assert.match(getReceipt?.description ?? "", /pay_allowed/);
    assert.match(getReceipt?.description ?? "", /poll get_receipt and pay only when pay_allowed is true/i);

    const created = toolJson(
      await rpc(app, "tools/call", {
        name: "record_approval",
        arguments: approval({ approver_contact: undefined, price_cap_amount: "12", payment_rail: "card" }),
      }),
    );
    assert.equal(created.isError, false);
    const receipt = created.body as ReceiptBody;
    assert.equal(receipt.pay_allowed, true);
    const recorded = toolJson(
      await rpc(app, "tools/call", {
        name: "record_payment",
        arguments: {
          receipt_id: receipt.receipt_id,
          edit_token: receipt.edit_token,
          external_payment_ref: "pi_mcp",
          amount: "12",
        },
      }),
    );
    assert.equal(recorded.isError, false);
    const body = recorded.body as ReceiptBody;
    assert.equal(body.payments[0]?.external_payment_ref, "pi_mcp");
    assert.equal(body.paid_before_confirmation, false);
    const verdict = toolJson(
      await rpc(app, "tools/call", { name: "verify_receipt", arguments: { receipt_id: receipt.receipt_id } }),
    );
    assert.equal((verdict.body as VerifyBody).valid, true);
  } finally {
    await app.close();
  }
});
