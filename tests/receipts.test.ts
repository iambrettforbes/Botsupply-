import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { openStore } from "../src/db.js";
import {
  canonicalizeAmount,
  decimalCompare,
  hashApproverContact,
  verifyReceiptRecord,
} from "../src/receipts.js";

const SIGNING_KEY = "test-receipt-signing-key";

type ReceiptBody = {
  receipt_id: string;
  receipt_url: string;
  edit_token?: string;
  status: string;
  approver: string;
  scope: string;
  mode: string;
  content_hash: string;
  payment_rail: string;
  merchant: { name: string; url: string | null };
  price_cap: { amount: string; currency: string };
  external_payment_ref: string | null;
  proofs: Array<{ type: string; value: string; actual_amount: string | null; over_cap: boolean; attached_at: string }>;
  timeline: Array<{ seq: number; kind: string; prev_hash: string; hash: string }>;
  over_cap?: boolean;
};

type VerifyBody = {
  valid: boolean;
  receipt_id: string;
  content_hash: string;
  checks: { chain: boolean; content: boolean; signature: boolean };
};

const CONTACT = "ada.secret@example.com";

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
    external_payment_ref: "pi_test_123",
    ...overrides,
  };
}

async function appWith(extra: Parameters<typeof buildApp>[0] = {}) {
  return buildApp({ sqlitePath: ":memory:", mode: "dev", receiptSigningKey: SIGNING_KEY, ...extra });
}

function postReceipt(app: FastifyInstance, body: Record<string, unknown> = approval(), headers?: Record<string, string>) {
  return app.inject({ method: "POST", url: "/v1/receipts", headers, payload: body });
}

test("decimal amounts normalize and compare without float drift", () => {
  assert.equal(canonicalizeAmount("10.50", false), "10.5");
  assert.equal(canonicalizeAmount("25.00", false), "25");
  assert.equal(canonicalizeAmount("0", false), undefined);
  assert.equal(canonicalizeAmount("0", true), "0");
  assert.equal(decimalCompare("10.01", "10") > 0, true);
  assert.equal(decimalCompare("10.00", "10"), 0);
  assert.equal(decimalCompare("9.99", "10") < 0, true);
});

test("create, attach, and verify a purchase receipt", async () => {
  const app = await appWith();
  try {
    const created = await postReceipt(app);
    assert.equal(created.statusCode, 201, created.body);
    const receipt = created.json() as ReceiptBody;
    assert.match(receipt.receipt_id, /^rcpt_[0-9a-f]{24}$/);
    assert.match(receipt.edit_token ?? "", /^rctok_[0-9a-f]{48}$/);
    assert.ok(receipt.receipt_url.endsWith(`/r/${receipt.receipt_id}`));
    assert.equal(receipt.status, "approved");
    assert.equal(receipt.approver, "Ada Lovelace");
    assert.equal(receipt.scope, "Two bags of coffee, delivery this week");
    assert.equal(receipt.price_cap.amount, "25");
    assert.equal(receipt.price_cap.currency, "USD");
    assert.equal(receipt.payment_rail, "stripe_link");
    assert.equal(receipt.merchant.name, "North Market");
    assert.equal(receipt.merchant.url, "https://north.example/shop");
    assert.equal(receipt.external_payment_ref, "pi_test_123");
    assert.equal(receipt.proofs.length, 0);
    assert.equal(receipt.timeline.length, 1);
    assert.equal(receipt.timeline[0]?.prev_hash, "");
    assert.equal(receipt.timeline[0]?.hash, receipt.content_hash);
    assert.equal(receipt.mode, "dev");
    const createdText = created.body;
    assert.equal(createdText.includes(CONTACT), false);
    assert.equal(createdText.includes(hashApproverContact(CONTACT)), false);
    assert.equal(createdText.includes("approver_contact"), false);
    assert.equal(createdText.includes("edit_token_hash"), false);

    const seen = await app.inject({ method: "GET", url: `/v1/receipts/${receipt.receipt_id}` });
    assert.equal(seen.statusCode, 200, seen.body);
    const pub = seen.json() as ReceiptBody;
    assert.equal(pub.edit_token, undefined);
    assert.equal(seen.body.includes(CONTACT), false);
    assert.equal(seen.body.includes("edit_token"), false);

    const page = await app.inject({ method: "GET", url: `/r/${receipt.receipt_id}` });
    assert.equal(page.statusCode, 200, page.body);
    assert.match(String(page.headers["content-type"]), /text\/html/);
    assert.match(page.body, /class="badge ok">Verified</);
    assert.match(page.body, /Approver \(reported by agent\): Ada Lovelace/);
    assert.match(
      page.body,
      /Verified = this record hasn't been changed since it was created\. It doesn't confirm who approved\./,
    );
    assert.doesNotMatch(page.body, /human verified|human confirmed|proof they approved|human's approval|human who approved/i);
    assert.match(page.body, /Ada Lovelace/);
    assert.match(page.body, /Two bags of coffee, delivery this week/);
    assert.match(page.body, /North Market/);
    assert.match(page.body, new RegExp(receipt.content_hash));
    assert.match(page.body, /class="cap">25 /);
    assert.equal(page.body.includes(CONTACT), false);
    assert.equal(page.body.includes(receipt.edit_token ?? "missing-token"), false);

    const verified = await app.inject({ method: "GET", url: `/v1/receipts/${receipt.receipt_id}/verify` });
    assert.equal(verified.statusCode, 200, verified.body);
    const verdict = verified.json() as VerifyBody;
    assert.equal(verdict.valid, true);
    assert.equal(verdict.checks.chain, true);
    assert.equal(verdict.checks.content, true);
    assert.equal(verdict.checks.signature, true);
    assert.equal(verdict.content_hash, receipt.content_hash);

    const proof = await app.inject({
      method: "POST",
      url: `/v1/receipts/${receipt.receipt_id}/proof`,
      payload: {
        edit_token: receipt.edit_token,
        type: "order_confirmation",
        value: "ord_123",
        actual_amount: "24.50",
      },
    });
    assert.equal(proof.statusCode, 200, proof.body);
    const delivered = proof.json() as ReceiptBody;
    assert.equal(delivered.status, "delivered");
    assert.equal(delivered.over_cap, false);
    assert.equal(delivered.proofs.length, 1);
    assert.equal(delivered.proofs[0]?.type, "order_confirmation");
    assert.equal(delivered.proofs[0]?.value, "ord_123");
    assert.equal(delivered.proofs[0]?.actual_amount, "24.5");
    assert.equal(delivered.proofs[0]?.over_cap, false);
    assert.equal(delivered.timeline.length, 2);
    assert.equal(delivered.timeline[1]?.prev_hash, receipt.content_hash);
    assert.equal(delivered.timeline[1]?.hash, delivered.content_hash);
    assert.notEqual(delivered.content_hash, receipt.content_hash);
    assert.equal(proof.body.includes("edit_token"), false);

    const again = await app.inject({ method: "GET", url: `/v1/receipts/${receipt.receipt_id}/verify` });
    assert.equal((again.json() as VerifyBody).valid, true);
    const deliveredPage = await app.inject({ method: "GET", url: `/r/${receipt.receipt_id}` });
    assert.match(deliveredPage.body, /class="badge ok">Verified</);
    assert.match(deliveredPage.body, /Approver \(reported by agent\): Ada Lovelace/);
    assert.match(
      deliveredPage.body,
      /Verified = this record hasn't been changed since it was created\. It doesn't confirm who approved\./,
    );
    assert.match(deliveredPage.body, /ord_123/);
    assert.match(deliveredPage.body, /order_confirmation/);
  } finally {
    await app.close();
  }
});

test("MCP receipt tools record, attach, and verify without an API key", async () => {
  const app = await appWith();
  try {
    const listed = await rpc(app, "tools/list", {});
    const record = listed.result?.tools?.find((tool) => tool.name === "record_approval");
    const attach = listed.result?.tools?.find((tool) => tool.name === "attach_proof");
    const verify = listed.result?.tools?.find((tool) => tool.name === "verify_receipt");
    assert.match(record?.description ?? "", /does not hold or move the money/i);
    assert.match(record?.description ?? "", /reported as approved/i);
    assert.match(record?.description ?? "", /does not confirm who approved/i);
    assert.doesNotMatch(JSON.stringify(record), /human who approved|human's approval|human verified|human confirmed|proof they approved/i);
    assert.match(attach?.description ?? "", /edit_token/i);
    assert.match(verify?.description ?? "", /valid is true/i);
    assert.match(verify?.description ?? "", /does not confirm who approved/i);
    const getReceipt = listed.result?.tools?.find((tool) => tool.name === "get_receipt");
    assert.match(getReceipt?.description ?? "", /reported as approved/i);
    assert.doesNotMatch(JSON.stringify(getReceipt), /human who approved|human's approval|human verified|human confirmed/i);

    const created = toolJson(
      await rpc(app, "tools/call", {
        name: "record_approval",
        arguments: approval({ price_cap_amount: 18, payment_rail: "x402" }),
      }),
    );
    assert.equal(created.isError, false);
    const receipt = created.body as ReceiptBody;
    assert.match(receipt.receipt_id, /^rcpt_/);
    assert.match(receipt.edit_token ?? "", /^rctok_/);
    assert.equal(receipt.payment_rail, "x402");
    assert.equal(receipt.price_cap.amount, "18");

    const proved = toolJson(
      await rpc(app, "tools/call", {
        name: "attach_proof",
        arguments: {
          receipt_id: receipt.receipt_id,
          edit_token: receipt.edit_token,
          type: "url",
          value: "https://north.example/orders/1",
          actual_amount: "18",
        },
      }),
    );
    assert.equal(proved.isError, false);
    assert.equal((proved.body as ReceiptBody).status, "delivered");

    const fetched = toolJson(
      await rpc(app, "tools/call", { name: "get_receipt", arguments: { receipt_id: receipt.receipt_id } }),
    );
    assert.equal(fetched.isError, false);
    assert.equal(JSON.stringify(fetched.body).includes(CONTACT), false);
    assert.equal(JSON.stringify(fetched.body).includes("edit_token"), false);

    const verdict = toolJson(
      await rpc(app, "tools/call", { name: "verify_receipt", arguments: { receipt_id: receipt.receipt_id } }),
    );
    assert.equal(verdict.isError, false);
    assert.equal((verdict.body as VerifyBody).valid, true);
  } finally {
    await app.close();
  }
});

test("a wrong edit token is rejected and does not attach proof", async () => {
  const app = await appWith();
  try {
    const created = await postReceipt(app, approval({ approver_contact: undefined }));
    assert.equal(created.statusCode, 201, created.body);
    const receipt = created.json() as ReceiptBody;
    const rejected = await app.inject({
      method: "POST",
      url: `/v1/receipts/${receipt.receipt_id}/proof`,
      payload: { edit_token: "rctok_not-the-token", type: "hash", value: "abc" },
    });
    assert.equal(rejected.statusCode, 403, rejected.body);
    assert.equal(rejected.json().error.code, "invalid_edit_token");
    const seen = await app.inject({ method: "GET", url: `/v1/receipts/${receipt.receipt_id}` });
    const body = seen.json() as ReceiptBody;
    assert.equal(body.status, "approved");
    assert.equal(body.proofs.length, 0);
    assert.equal(body.content_hash, receipt.content_hash);
  } finally {
    await app.close();
  }
});

test("actual amount above the price cap is flagged and still recorded", async () => {
  const app = await appWith();
  try {
    const created = await postReceipt(app, approval({ price_cap_amount: 10, price_cap_currency: "USD" }));
    const receipt = created.json() as ReceiptBody;
    const over = await app.inject({
      method: "POST",
      url: `/v1/receipts/${receipt.receipt_id}/proof`,
      payload: {
        edit_token: receipt.edit_token,
        type: "tracking",
        value: "1Z999",
        actual_amount: "10.01",
      },
    });
    assert.equal(over.statusCode, 200, over.body);
    const body = over.json() as ReceiptBody;
    assert.equal(body.over_cap, true);
    assert.equal(body.proofs[0]?.over_cap, true);
    assert.equal(body.status, "delivered");
    assert.equal(body.price_cap.amount, "10");

    const exact = await app.inject({
      method: "POST",
      url: `/v1/receipts/${receipt.receipt_id}/proof`,
      payload: {
        edit_token: receipt.edit_token,
        type: "order_confirmation",
        value: "ord_exact",
        actual_amount: "10.00",
      },
    });
    assert.equal(exact.statusCode, 200, exact.body);
    const second = exact.json() as ReceiptBody;
    assert.equal(second.over_cap, false);
    assert.equal(second.proofs[1]?.over_cap, false);
    assert.equal(second.proofs[0]?.over_cap, true);
  } finally {
    await app.close();
  }
});

test("disputed receipts do not move back to delivered", async () => {
  const app = await appWith();
  try {
    const created = await postReceipt(app);
    const receipt = created.json() as ReceiptBody;
    const disputed = await app.inject({
      method: "POST",
      url: `/v1/receipts/${receipt.receipt_id}/proof`,
      payload: { edit_token: receipt.edit_token, type: "note", value: "Customer disputes the charge", status: "disputed" },
    });
    assert.equal(disputed.statusCode, 200, disputed.body);
    assert.equal((disputed.json() as ReceiptBody).status, "disputed");
    const back = await app.inject({
      method: "POST",
      url: `/v1/receipts/${receipt.receipt_id}/proof`,
      payload: { edit_token: receipt.edit_token, type: "url", value: "https://example.com/x", status: "delivered" },
    });
    assert.equal(back.statusCode, 409, back.body);
    assert.equal(back.json().error.code, "invalid_status");
    const seen = await app.inject({ method: "GET", url: `/v1/receipts/${receipt.receipt_id}` });
    assert.equal((seen.json() as ReceiptBody).status, "disputed");
    assert.equal((seen.json() as ReceiptBody).proofs.length, 1);
  } finally {
    await app.close();
  }
});

test("editing a receipt row breaks verification", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "botsupply-receipt-tamper-"));
  const sqlitePath = path.join(dir, "botsupply.sqlite");
  const key = Buffer.from(SIGNING_KEY);
  const app = await buildApp({ sqlitePath, mode: "dev", receiptSigningKey: SIGNING_KEY });
  let receiptId = "";
  let editToken = "";
  try {
    const created = await postReceipt(app);
    assert.equal(created.statusCode, 201, created.body);
    const receipt = created.json() as ReceiptBody;
    receiptId = receipt.receipt_id;
    editToken = receipt.edit_token ?? "";
    const before = await app.inject({ method: "GET", url: `/v1/receipts/${receiptId}/verify` });
    assert.equal((before.json() as VerifyBody).valid, true);
  } finally {
    await app.close();
  }

  const store = await openStore({ sqlitePath, mode: "dev", receiptSigningKey: key });
  try {
    const record = await store.getReceipt(receiptId);
    assert.ok(record);
    assert.equal(record.approver_contact_hash, hashApproverContact(CONTACT));
    assert.equal(verifyReceiptRecord(record, key).valid, true);
    const wrong = verifyReceiptRecord(record, Buffer.from("a-different-receipt-key"));
    assert.equal(wrong.valid, false);
    assert.equal(wrong.checks.signature, false);
    assert.equal(wrong.checks.chain, true);
    assert.equal(wrong.checks.content, true);
  } finally {
    await store.close();
  }

  const db = new Database(sqlitePath);
  db.prepare("UPDATE receipts SET scope = ? WHERE id = ?").run("tampered scope", receiptId);
  db.close();

  const again = await buildApp({ sqlitePath, mode: "dev", receiptSigningKey: SIGNING_KEY });
  try {
    const verified = await again.inject({ method: "GET", url: `/v1/receipts/${receiptId}/verify` });
    assert.equal(verified.statusCode, 200, verified.body);
    const verdict = verified.json() as VerifyBody;
    assert.equal(verdict.valid, false);
    assert.equal(verdict.checks.content, false);
    const page = await again.inject({ method: "GET", url: `/r/${receiptId}` });
    assert.match(page.body, /class="badge bad">Tampered</);
    assert.doesNotMatch(page.body, /class="badge ok"/);
    assert.match(page.body, /Approver \(reported by agent\): Ada Lovelace/);
    assert.match(page.body, /The stored receipt does not match its hash chain or server signature\./);
    assert.doesNotMatch(page.body, /Verified = this record hasn't been changed/);
    assert.match(page.body, /tampered scope/);
    assert.equal(page.body.includes(CONTACT), false);
    const proof = await again.inject({
      method: "POST",
      url: `/v1/receipts/${receiptId}/proof`,
      payload: { edit_token: editToken, type: "hash", value: "deadbeef" },
    });
    assert.equal(proof.statusCode, 409, proof.body);
    assert.equal(proof.json().error.code, "receipt_tampered");
  } finally {
    await again.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("receipts stay inside the Stripe mode that created them", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "botsupply-receipt-mode-"));
  const sqlitePath = path.join(dir, "botsupply.sqlite");
  const testApp = await buildApp({ sqlitePath, mode: "test", receiptSigningKey: SIGNING_KEY });
  const liveApp = await buildApp({ sqlitePath, mode: "live", receiptSigningKey: SIGNING_KEY });
  try {
    const created = await postReceipt(testApp, approval({ payment_rail: "card" }));
    assert.equal(created.statusCode, 201, created.body);
    const receipt = created.json() as ReceiptBody;
    assert.equal(receipt.mode, "test");

    const liveGet = await liveApp.inject({ method: "GET", url: `/v1/receipts/${receipt.receipt_id}` });
    assert.equal(liveGet.statusCode, 404, liveGet.body);
    const liveVerify = await liveApp.inject({ method: "GET", url: `/v1/receipts/${receipt.receipt_id}/verify` });
    assert.equal(liveVerify.statusCode, 404);
    const livePage = await liveApp.inject({ method: "GET", url: `/r/${receipt.receipt_id}` });
    assert.equal(livePage.statusCode, 404);
    const liveProof = await liveApp.inject({
      method: "POST",
      url: `/v1/receipts/${receipt.receipt_id}/proof`,
      payload: { edit_token: receipt.edit_token, type: "url", value: "https://example.com/hidden" },
    });
    assert.equal(liveProof.statusCode, 404);

    const testGet = await testApp.inject({ method: "GET", url: `/v1/receipts/${receipt.receipt_id}` });
    assert.equal(testGet.statusCode, 200, testGet.body);
    assert.equal((testGet.json() as ReceiptBody).status, "approved");
    const testVerify = await testApp.inject({ method: "GET", url: `/v1/receipts/${receipt.receipt_id}/verify` });
    assert.equal((testVerify.json() as VerifyBody).valid, true);
  } finally {
    await testApp.close();
    await liveApp.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("record approval is rate limited per IP", async () => {
  const app = await appWith({ receiptRateLimit: { max: 3, windowMs: 60_000 } });
  try {
    const headers = { "x-forwarded-for": "198.51.100.10" };
    for (let i = 0; i < 3; i += 1) {
      const created = await postReceipt(app, approval({ external_payment_ref: `ref-${i}` }), headers);
      assert.equal(created.statusCode, 201, created.body);
    }
    const blocked = await postReceipt(app, approval(), headers);
    assert.equal(blocked.statusCode, 429, blocked.body);
    assert.equal(blocked.json().error.code, "rate_limited");
    assert.ok(Number(blocked.headers["retry-after"]) >= 1);
    const other = await postReceipt(app, approval(), { "x-forwarded-for": "198.51.100.11" });
    assert.equal(other.statusCode, 201, other.body);
  } finally {
    await app.close();
  }
});

test("MCP record_approval uses the caller IP for the rate limit", async () => {
  const app = await appWith({ receiptRateLimit: { max: 2, windowMs: 60_000 } });
  try {
    const args = { name: "record_approval", arguments: approval({ payment_rail: "botsupply_wallet" }) };
    const first = toolJson(await rpc(app, "tools/call", args, { "x-forwarded-for": "203.0.113.8" }));
    const second = toolJson(await rpc(app, "tools/call", args, { "x-forwarded-for": "203.0.113.8" }));
    assert.equal(first.isError, false);
    assert.equal(second.isError, false);
    const third = toolJson(await rpc(app, "tools/call", args, { "x-forwarded-for": "203.0.113.8" }));
    assert.equal(third.isError, true);
    assert.equal((third.body as { body: { error: { code: string } } }).body.error.code, "rate_limited");
    const other = toolJson(await rpc(app, "tools/call", args, { "x-forwarded-for": "203.0.113.9" }));
    assert.equal(other.isError, false);
  } finally {
    await app.close();
  }
});

type Rpc = {
  result?: {
    isError?: boolean;
    content?: Array<{ type: string; text?: string }>;
    tools?: Array<{ name: string; description?: string }>;
  };
  error?: { message?: string };
};

async function rpc(
  app: FastifyInstance,
  method: string,
  params: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<Rpc> {
  const response = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...extraHeaders,
    },
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
