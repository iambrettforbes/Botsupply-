import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { approverInitials, onFileTail, stripPrivateDetails } from "../src/receipts.js";

const SIGNING_KEY = "test-receipt-signing-key";
const CONTACT = "ada.secret@example.com";
const RAW_EMAIL = "ivan@gmail.com";
const RAW_PHONE = "+1 (415) 555-2671";

type ReceiptBody = {
  receipt_id: string;
  edit_token?: string;
  confirm_url?: string;
  status: string;
  content_hash: string;
  updated_at: string;
  approver: string;
  agent_id: string | null;
  agent_name: string | null;
  scope: string;
  pay_allowed: boolean;
  public_view: string;
  external_payment_ref: string | null;
  paid_before_confirmation: boolean;
  over_cap: boolean;
  merchant: { name: string; url: string | null };
  price_cap: { amount: string; currency: string };
  approver_confirmation: { status: string; at: string | null; contact_masked: string | null };
  proofs: Array<{ type: string; value: string; actual_amount: string | null }>;
  payments: Array<{ external_payment_ref: string; amount: string; paid_before_confirmation: boolean; over_cap: boolean }>;
  timeline: Array<{ kind: string }>;
};

type VerifyBody = {
  valid: boolean;
  content_hash: string;
  approver_confirmation: { status: string; contact_masked: string | null };
};

type Rpc = {
  result?: {
    isError?: boolean;
    content?: Array<{ type: string; text?: string }>;
    tools?: Array<{ name: string }>;
  };
  error?: { message?: string };
};

function approval(overrides: Record<string, unknown> = {}) {
  return {
    approver: "Brett Forbes",
    approver_contact: CONTACT,
    agent_id: "agent_demo",
    agent_name: "Desk Agent",
    merchant_name: `North Market ${RAW_PHONE}`,
    merchant_url: "https://north.example/shop",
    scope: `Two bags of coffee for ${RAW_EMAIL}, card ending 4242`,
    price_cap_amount: "25.00",
    price_cap_currency: "usd",
    payment_rail: "stripe_link",
    ...overrides,
  };
}

async function appWith(sqlitePath = ":memory:") {
  return buildApp({ sqlitePath, mode: "dev", receiptSigningKey: SIGNING_KEY });
}

function postReceipt(app: FastifyInstance, body: Record<string, unknown> = approval()) {
  return app.inject({ method: "POST", url: "/v1/receipts", payload: body });
}

function tokenFrom(url: string): string {
  const token = url.split("/c/")[1] ?? "";
  return decodeURIComponent(token);
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

test("private-detail helpers drop contacts and keep a short on-file tail", () => {
  assert.equal(approverInitials("Brett Forbes"), "B.F.");
  assert.equal(approverInitials(`Ada ${RAW_EMAIL}`), "A.");
  assert.equal(stripPrivateDetails(`Ship to ${RAW_EMAIL}. Call ${RAW_PHONE}. Card ending 4242.`), "Ship to. Call.");
  assert.equal(onFileTail("order ending 4242 ref ABCD9999"), "on file 9999");
  assert.equal(onFileTail("paid with ****4242 order ZZ99"), "on file ZZ99");
  assert.equal(onFileTail("pi_3Nabc9876"), "on file 9876");
});

test("reads derive the latest payment ref and flags without rewriting the stored receipt", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "botsupply-pay-read-"));
  const sqlitePath = path.join(dir, "botsupply.sqlite");
  const app = await appWith(sqlitePath);
  try {
    const created = await postReceipt(app, approval({ public_view: undefined }));
    assert.equal(created.statusCode, 201, created.body);
    const receipt = created.json() as ReceiptBody;
    assert.equal(receipt.public_view, "full");
    assert.equal(receipt.external_payment_ref, null);
    assert.equal(receipt.paid_before_confirmation, false);
    assert.equal(receipt.over_cap, false);
    const hash = receipt.content_hash;

    const early = await app.inject({
      method: "POST",
      url: `/v1/receipts/${receipt.receipt_id}/payment`,
      payload: { edit_token: receipt.edit_token, external_payment_ref: "pi_early", amount: "30" },
    });
    assert.equal(early.statusCode, 200, early.body);
    const seen = (await app.inject({ method: "GET", url: `/v1/receipts/${receipt.receipt_id}` })).json() as ReceiptBody;
    assert.equal(seen.external_payment_ref, "pi_early");
    assert.equal(seen.paid_before_confirmation, true);
    assert.equal(seen.over_cap, true);
    assert.equal(seen.payments[0]?.external_payment_ref, "pi_early");
    const page = await app.inject({ method: "GET", url: `/r/${receipt.receipt_id}` });
    assert.match(page.body, /<dt>Payment ref<\/dt><dd>pi_early<\/dd>/);
    assert.doesNotMatch(page.body, /<dt>Payment ref<\/dt><dd>None<\/dd>/);
    assert.match(page.body, /Paid before confirmation/);
    assert.match(page.body, /Over approved cap/);
    assert.doesNotMatch(page.body, /Some details hidden by the purchaser/);

    const confirmed = await app.inject({
      method: "POST",
      url: `/c/${encodeURIComponent(tokenFrom(receipt.confirm_url ?? ""))}/confirm`,
    });
    assert.equal(confirmed.statusCode, 200, confirmed.body);
    const later = await app.inject({
      method: "POST",
      url: `/v1/receipts/${receipt.receipt_id}/payment`,
      payload: { edit_token: receipt.edit_token, external_payment_ref: "pi_later_9876", amount: "20" },
    });
    assert.equal(later.statusCode, 200, later.body);
    const after = (await app.inject({ method: "GET", url: `/v1/receipts/${receipt.receipt_id}` })).json() as ReceiptBody;
    assert.equal(after.external_payment_ref, "pi_later_9876");
    assert.equal(after.payments[0]?.external_payment_ref, "pi_early");
    assert.equal(after.payments[1]?.paid_before_confirmation, false);
    assert.equal(after.payments[1]?.over_cap, false);
    assert.equal(after.paid_before_confirmation, true);
    assert.equal(after.over_cap, true);
    assert.notEqual(after.content_hash, hash);
    const verified = (await app.inject({ method: "GET", url: `/v1/receipts/${receipt.receipt_id}/verify` })).json() as VerifyBody;
    assert.equal(verified.valid, true);
    assert.equal(verified.content_hash, after.content_hash);
  } finally {
    await app.close();
  }

  const db = new Database(sqlitePath, { readonly: true });
  const row = db.prepare("SELECT external_payment_ref, approver_name, public_view FROM receipts").get() as {
    external_payment_ref: string | null;
    approver_name: string;
    public_view: string;
  };
  assert.equal(row.external_payment_ref, null);
  assert.equal(row.approver_name, "Brett Forbes");
  assert.equal(row.public_view, "full");
  const payloads = db.prepare("SELECT kind, payload_json FROM receipt_events ORDER BY seq").all() as Array<{
    kind: string;
    payload_json: string;
  }>;
  for (const event of payloads) {
    const snapshot = (JSON.parse(event.payload_json) as { snapshot: { external_payment_ref: string | null; payments?: unknown[] } }).snapshot;
    assert.equal(snapshot.external_payment_ref, null);
    assert.equal(event.payload_json.includes("public_view"), false);
    assert.equal(event.payload_json.includes("public_scope"), false);
    if (event.kind === "approved") {
      assert.equal(snapshot.payments, undefined);
      assert.equal(event.payload_json.includes("paid_before_confirmation"), false);
    }
    if (event.kind === "payment_recorded") {
      assert.equal(event.payload_json.includes("paid_before_confirmation"), true);
    }
  }
  db.close();

  const again = await appWith(sqlitePath);
  try {
    const lookup = new Database(sqlitePath, { readonly: true });
    const id = (lookup.prepare("SELECT id FROM receipts").get() as { id: string }).id;
    lookup.close();
    const verified = await again.inject({ method: "GET", url: `/v1/receipts/${id}/verify` });
    assert.equal((verified.json() as VerifyBody).valid, true);
    const read = (await again.inject({ method: "GET", url: `/v1/receipts/${id}` })).json() as ReceiptBody;
    assert.equal(read.external_payment_ref, "pi_later_9876");
    assert.equal(read.paid_before_confirmation, true);
    assert.equal(read.over_cap, true);
  } finally {
    await again.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("redacted public view hides purchaser details without changing the signature", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "botsupply-redact-"));
  const sqlitePath = path.join(dir, "botsupply.sqlite");
  const app = await appWith(sqlitePath);
  let id = "";
  let token = "";
  let hash = "";
  try {
    const created = await postReceipt(
      app,
      approval({
        public_view: "redacted",
        public_scope: `Weekly coffee. Reach ${RAW_EMAIL} if needed.`,
      }),
    );
    assert.equal(created.statusCode, 201, created.body);
    const receipt = created.json() as ReceiptBody;
    id = receipt.receipt_id;
    token = receipt.edit_token ?? "";
    hash = receipt.content_hash;
    assert.equal(receipt.public_view, "redacted");
    assert.equal(receipt.approver, "B.F.");
    assert.equal(receipt.agent_name, "Agent");
    assert.equal(receipt.agent_id, null);
    assert.equal(receipt.scope, "Weekly coffee. Reach if needed.");
    assert.equal(receipt.merchant.name, "North Market");
    assert.equal(receipt.merchant.url, "https://north.example/shop");
    assert.equal(receipt.price_cap.amount, "25");
    assert.equal(receipt.scope.includes(RAW_EMAIL), false);
    assert.equal(receipt.scope.includes("4242"), false);
    assert.equal(receipt.merchant.name.includes(RAW_PHONE), false);
    assert.equal(receipt.approver_confirmation.contact_masked, null);
    const seen = (await app.inject({ method: "GET", url: `/v1/receipts/${id}` })).json() as ReceiptBody;
    assert.equal(JSON.stringify(seen).includes(RAW_EMAIL), false);
    assert.equal(JSON.stringify(seen).includes(RAW_PHONE), false);
    assert.equal(JSON.stringify(seen).includes("***@"), false);
    assert.equal(JSON.stringify(seen).includes("4242"), false);

    const proof = await app.inject({
      method: "POST",
      url: `/v1/receipts/${id}/proof`,
      payload: {
        edit_token: token,
        type: "order_confirmation",
        value: `buyer ${RAW_EMAIL} ending 4242 ref ABCD9999`,
        actual_amount: "25.00",
      },
    });
    assert.equal(proof.statusCode, 200, proof.body);
    const proved = proof.json() as ReceiptBody;
    assert.equal(proved.proofs[0]?.value, "on file 9999");
    assert.equal(proved.proofs[0]?.actual_amount, "25");
    assert.equal(proved.status, "delivered");

    const paid = await app.inject({
      method: "POST",
      url: `/v1/receipts/${id}/payment`,
      payload: { edit_token: token, external_payment_ref: "pi_3Nabc9876", amount: "30" },
    });
    assert.equal(paid.statusCode, 200, paid.body);
    const paidBody = paid.json() as ReceiptBody;
    assert.equal(paidBody.external_payment_ref, "on file 9876");
    assert.equal(paidBody.payments[0]?.external_payment_ref, "on file 9876");
    assert.equal(paidBody.payments[0]?.amount, "30");
    assert.equal(paidBody.paid_before_confirmation, true);
    assert.equal(paidBody.over_cap, true);
    assert.equal(paid.body.includes("pi_3Nabc9876"), false);

    const page = await app.inject({ method: "GET", url: `/r/${id}` });
    assert.match(page.body, /Some details hidden by the purchaser/);
    assert.match(page.body, /Approver \(reported by agent\): B\.F\./);
    assert.match(page.body, /<dt>Agent<\/dt><dd>Agent<\/dd>/);
    assert.match(page.body, /<dt>Payment ref<\/dt><dd>on file 9876<\/dd>/);
    assert.match(page.body, /Paid before confirmation/);
    assert.match(page.body, /Over approved cap/);
    assert.match(page.body, /class="cap">25 /);
    assert.match(page.body, /North Market/);
    assert.match(page.body, /https:\/\/north\.example\/shop/);
    assert.match(page.body, /Weekly coffee\. Reach if needed\./);
    assert.equal(page.body.includes(RAW_EMAIL), false);
    assert.equal(page.body.includes(RAW_PHONE), false);
    assert.equal(page.body.includes("ending 4242"), false);
    assert.equal(page.body.includes("Brett"), false);
    assert.equal(page.body.includes("Desk Agent"), false);
    assert.equal(page.body.includes("agent_demo"), false);
    assert.equal(page.body.includes("pi_3Nabc9876"), false);
    assert.equal(page.body.includes("***@"), false);

    const verified = (await app.inject({ method: "GET", url: `/v1/receipts/${id}/verify` })).json() as VerifyBody;
    assert.equal(verified.valid, true);
    assert.equal(verified.approver_confirmation.contact_masked, null);
    assert.equal(verified.approver_confirmation.status, "unconfirmed");

    const confirmPage = await app.inject({
      method: "GET",
      url: `/c/${encodeURIComponent(tokenFrom((created.json() as ReceiptBody).confirm_url ?? ""))}`,
    });
    assert.equal(confirmPage.statusCode, 200, confirmPage.body);
    assert.match(confirmPage.body, new RegExp(RAW_EMAIL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(confirmPage.body, /Some details hidden by the purchaser/);

    const bad = await app.inject({
      method: "POST",
      url: `/v1/receipts/${id}/visibility`,
      payload: { edit_token: "rctok_nope", public_view: "full" },
    });
    assert.equal(bad.statusCode, 403, bad.body);
    assert.equal(bad.json().error.code, "invalid_edit_token");

    const opened = await app.inject({
      method: "POST",
      url: `/v1/receipts/${id}/visibility`,
      payload: { edit_token: token, public_view: "full" },
    });
    assert.equal(opened.statusCode, 200, opened.body);
    const full = opened.json() as ReceiptBody;
    assert.equal(full.public_view, "full");
    assert.equal(full.content_hash, (paid.json() as ReceiptBody).content_hash);
    assert.equal(full.updated_at, (paid.json() as ReceiptBody).updated_at);
    assert.equal(full.approver, `Brett Forbes`);
    assert.equal(full.agent_name, "Desk Agent");
    assert.equal(full.agent_id, "agent_demo");
    assert.match(full.scope, /i\*\*\*@gmail\.com/);
    assert.match(full.merchant.name, /\*\*\*/);
    assert.equal(full.external_payment_ref, "pi_3Nabc9876");
    assert.equal(full.proofs[0]?.value.includes(RAW_EMAIL), false);
    assert.match(full.proofs[0]?.value ?? "", /i\*\*\*@gmail\.com/);
    const fullPage = await app.inject({ method: "GET", url: `/r/${id}` });
    assert.doesNotMatch(fullPage.body, /Some details hidden by the purchaser/);
    assert.match(fullPage.body, /Brett Forbes/);

    const hidden = await app.inject({
      method: "POST",
      url: `/v1/receipts/${id}/visibility`,
      payload: { edit_token: token, public_view: "redacted", public_scope: "Two bags, no contacts" },
    });
    assert.equal(hidden.statusCode, 200, hidden.body);
    const redacted = hidden.json() as ReceiptBody;
    assert.equal(redacted.scope, "Two bags, no contacts");
    assert.equal(redacted.approver, "B.F.");
    assert.equal(redacted.content_hash, full.content_hash);
    assert.equal(redacted.updated_at, full.updated_at);
    assert.notEqual(redacted.content_hash, hash);
    const still = (await app.inject({ method: "GET", url: `/v1/receipts/${id}/verify` })).json() as VerifyBody;
    assert.equal(still.valid, true);
    assert.equal(still.content_hash, redacted.content_hash);
  } finally {
    await app.close();
  }

  const db = new Database(sqlitePath, { readonly: true });
  const row = db.prepare(
    "SELECT approver_name, scope, public_view, public_scope, external_payment_ref, content_hash FROM receipts",
  ).get() as {
    approver_name: string;
    scope: string;
    public_view: string;
    public_scope: string | null;
    external_payment_ref: string | null;
    content_hash: string;
  };
  assert.equal(row.approver_name, "Brett Forbes");
  assert.equal(row.scope.includes(RAW_EMAIL), true);
  assert.equal(row.public_view, "redacted");
  assert.equal(row.public_scope, "Two bags, no contacts");
  assert.equal(row.external_payment_ref, null);
  const proof = db.prepare("SELECT proof_value FROM receipt_proofs").get() as { proof_value: string };
  assert.equal(proof.proof_value.includes(RAW_EMAIL), true);
  const payloads = db.prepare("SELECT payload_json FROM receipt_events").all() as Array<{ payload_json: string }>;
  assert.equal(payloads.some((event) => event.payload_json.includes("public_view")), false);
  assert.equal(payloads.some((event) => event.payload_json.includes("public_scope")), false);
  db.close();

  const again = await appWith(sqlitePath);
  try {
    const verified = await again.inject({ method: "GET", url: `/v1/receipts/${id}/verify` });
    assert.equal((verified.json() as VerifyBody).valid, true);
    const read = (await again.inject({ method: "GET", url: `/v1/receipts/${id}` })).json() as ReceiptBody;
    assert.equal(read.approver, "B.F.");
    assert.equal(read.scope, "Two bags, no contacts");
    assert.equal(read.external_payment_ref, "on file 9876");
    assert.equal(read.content_hash, row.content_hash);
  } finally {
    await again.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP set_receipt_visibility is a fifteenth tool and does not re-sign", async () => {
  const app = await appWith();
  try {
    const listed = await rpc(app, "tools/list", {});
    const names = (listed.result?.tools ?? []).map((tool) => tool.name);
    assert.equal(names.length, 15);
    assert.equal(names.includes("set_receipt_visibility"), true);
    const created = toolJson(
      await rpc(app, "tools/call", {
        name: "record_approval",
        arguments: approval({
          approver_contact: undefined,
          price_cap_amount: "12",
          scope: "A short brief",
          merchant_name: "North Market",
        }),
      }),
    );
    assert.equal(created.isError, false);
    const receipt = created.body as ReceiptBody;
    assert.equal(receipt.public_view, "full");
    assert.equal(receipt.pay_allowed, true);
    const changed = toolJson(
      await rpc(app, "tools/call", {
        name: "set_receipt_visibility",
        arguments: {
          receipt_id: receipt.receipt_id,
          edit_token: receipt.edit_token,
          public_view: "redacted",
          public_scope: "A public brief",
        },
      }),
    );
    assert.equal(changed.isError, false);
    const body = changed.body as ReceiptBody;
    assert.equal(body.public_view, "redacted");
    assert.equal(body.approver, "B.F.");
    assert.equal(body.agent_name, "Agent");
    assert.equal(body.scope, "A public brief");
    assert.equal(body.content_hash, receipt.content_hash);
    const verdict = toolJson(
      await rpc(app, "tools/call", { name: "verify_receipt", arguments: { receipt_id: receipt.receipt_id } }),
    );
    assert.equal((verdict.body as VerifyBody).valid, true);
  } finally {
    await app.close();
  }
});
