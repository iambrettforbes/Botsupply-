import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import type { ApprovalNotice } from "../src/approval-notifier.js";
import { buildApp } from "../src/app.js";
import { hashApproverContact, planApproval } from "../src/receipts.js";

const SIGNING_KEY = "test-receipt-signing-key";
const CONTACT = "ada.secret@example.com";
const MASKED = "a***@example.com";

type ReceiptBody = {
  receipt_id: string;
  edit_token?: string;
  confirm_url?: string;
  confirm_delivery?: string;
  confirm_expires_at?: string;
  confirm_contact_masked?: string;
  confirm_channel?: string;
  status: string;
  content_hash: string;
  approver_confirmation: {
    status: string;
    at: string | null;
    channel: string | null;
    contact_masked: string | null;
  };
  timeline: Array<{ seq: number; kind: string; prev_hash: string; hash: string }>;
};

type VerifyBody = {
  valid: boolean;
  checks: { chain: boolean; content: boolean; signature: boolean };
  approver_confirmation: { status: string };
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
    external_payment_ref: "pi_test_123",
    ...overrides,
  };
}

function tokenFrom(url: string): string {
  const part = new URL(url).pathname.split("/").pop() ?? "";
  return decodeURIComponent(part);
}

async function appWith(extra: Parameters<typeof buildApp>[0] = {}) {
  return buildApp({
    sqlitePath: ":memory:",
    mode: "dev",
    receiptSigningKey: SIGNING_KEY,
    approvalNotifier: {
      configured: false,
      provider: "none",
      async send() {
        throw new Error("notifier should not send");
      },
    },
    ...extra,
  });
}

function postReceipt(app: FastifyInstance, body: Record<string, unknown> = approval()) {
  return app.inject({ method: "POST", url: "/v1/receipts", payload: body });
}

function postDecision(app: FastifyInstance, token: string, decision: "confirm" | "decline") {
  return app.inject({
    method: "POST",
    url: `/c/${token}/${decision}`,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: "",
  });
}

test("an email contact issues a one-time confirm url and does not send mail", async () => {
  const app = await appWith();
  try {
    const created = await postReceipt(app);
    assert.equal(created.statusCode, 201, created.body);
    const receipt = created.json() as ReceiptBody;
    assert.match(receipt.confirm_url ?? "", /\/c\/cftok_[0-9a-f]{64}$/);
    assert.equal(receipt.confirm_delivery, "caller");
    assert.equal(receipt.confirm_channel, "email");
    assert.equal(receipt.confirm_contact_masked, MASKED);
    assert.equal(receipt.approver_confirmation.status, "unconfirmed");
    assert.equal(created.body.includes(CONTACT), false);
    assert.equal(created.body.includes(hashApproverContact(CONTACT)), false);
    const token = tokenFrom(receipt.confirm_url ?? "");
    assert.equal(created.body.includes(token) ? receipt.confirm_url?.includes(token) : false, true);

    const pub = await app.inject({ method: "GET", url: `/v1/receipts/${receipt.receipt_id}` });
    const seen = pub.json() as ReceiptBody;
    assert.equal(seen.confirm_url, undefined);
    assert.equal(seen.approver_confirmation.status, "unconfirmed");
    assert.equal(seen.approver_confirmation.contact_masked, null);
    assert.equal(pub.body.includes(token), false);
    assert.equal(pub.body.includes(CONTACT), false);

    const objectContact = await postReceipt(app, approval({ approver_contact: { channel: "email", address: "Ada@Example.com" } }));
    assert.equal(objectContact.statusCode, 201, objectContact.body);
    assert.equal((objectContact.json() as ReceiptBody).confirm_contact_masked, "a***@example.com");

    const phone = await postReceipt(app, approval({ approver_contact: "+15551212" }));
    assert.equal(phone.statusCode, 201, phone.body);
    const legacy = phone.json() as ReceiptBody;
    assert.equal(legacy.confirm_url, undefined);
    assert.equal(legacy.confirm_delivery, undefined);
    assert.equal(legacy.approver_confirmation.status, "unconfirmed");

    const none = await postReceipt(app, approval({ approver_contact: undefined }));
    assert.equal(none.statusCode, 201, none.body);
    assert.equal((none.json() as ReceiptBody).confirm_url, undefined);

    const sms = await postReceipt(app, approval({ approver_contact: { channel: "sms", address: "+15555550100" } }));
    assert.equal(sms.statusCode, 400, sms.body);
    assert.match(sms.body, /sms is not available yet/);

    const localWebhook = await postReceipt(app, approval({ confirmation_webhook_url: "https://127.0.0.1/hook" }));
    assert.equal(localWebhook.statusCode, 400, localWebhook.body);
    const httpWebhook = await postReceipt(app, approval({ confirmation_webhook_url: "http://hooks.example/receipt" }));
    assert.equal(httpWebhook.statusCode, 400, httpWebhook.body);
  } finally {
    await app.close();
  }
});

test("GET shows the summary and does not confirm", async () => {
  const app = await appWith();
  try {
    const created = await postReceipt(app);
    const receipt = created.json() as ReceiptBody;
    const token = tokenFrom(receipt.confirm_url ?? "");
    const page = await app.inject({ method: "GET", url: `/c/${token}` });
    assert.equal(page.statusCode, 200, page.body);
    assert.match(String(page.headers["content-type"]), /text\/html/);
    assert.match(page.body, /Two bags of coffee, delivery this week/);
    assert.match(page.body, /North Market/);
    assert.match(page.body, /Desk Agent/);
    assert.match(page.body, />25 USD</);
    assert.match(page.body, /<button class="confirm" type="submit">Confirm<\/button>/);
    assert.match(page.body, /<button class="decline" type="submit">Decline<\/button>/);
    assert.match(page.body, /Opening this page does not confirm or decline/);
    assert.doesNotMatch(page.body, /<script/i);
    assert.equal(page.body.includes(CONTACT), false);

    const seen = await app.inject({ method: "GET", url: `/v1/receipts/${receipt.receipt_id}` });
    const body = seen.json() as ReceiptBody;
    assert.equal(body.approver_confirmation.status, "unconfirmed");
    assert.equal(body.timeline.length, 1);
    assert.equal(body.content_hash, receipt.content_hash);

    const missing = await app.inject({ method: "GET", url: "/c/cftok_" + "ab".repeat(32) });
    assert.equal(missing.statusCode, 404, missing.body);
    assert.match(missing.body, /This confirmation link is not valid/);
  } finally {
    await app.close();
  }
});

test("confirm and decline are single-use signed events and the pages show the three states", async () => {
  const posts: Array<{ url: string; body: { receipt_id?: string; approver_confirmation?: { status?: string; contact_masked?: string } } }> = [];
  const app = await appWith({
    confirmationWebhook: {
      async post(url, body) {
        posts.push({ url, body: body as (typeof posts)[number]["body"] });
      },
    },
  });
  try {
    const pending = await postReceipt(app, approval({ confirmation_webhook_url: "https://hooks.example/botsupply" }));
    const pendingBody = pending.json() as ReceiptBody;
    const pendingPage = await app.inject({ method: "GET", url: `/r/${pendingBody.receipt_id}` });
    assert.match(pendingPage.body, /Approver unconfirmed/);
    assert.match(pendingPage.body, /class="badge ok">Verified</);
    assert.doesNotMatch(pendingPage.body, /Approver confirmed ✓/);
    assert.doesNotMatch(pendingPage.body, /Approver declined/);

    const token = tokenFrom(pendingBody.confirm_url ?? "");
    const confirmed = await postDecision(app, token, "confirm");
    assert.equal(confirmed.statusCode, 200, confirmed.body);
    assert.match(confirmed.body, /You confirmed this request/);
    assert.equal(posts.length, 1);
    assert.equal(posts[0]?.url, "https://hooks.example/botsupply");
    assert.equal(posts[0]?.body.approver_confirmation?.status, "confirmed");
    assert.equal(posts[0]?.body.approver_confirmation?.contact_masked, MASKED);
    assert.equal(JSON.stringify(posts[0]?.body).includes(CONTACT), false);
    assert.equal(JSON.stringify(posts[0]?.body).includes(token), false);

    const after = await app.inject({ method: "GET", url: `/v1/receipts/${pendingBody.receipt_id}` });
    const confirmedBody = after.json() as ReceiptBody;
    assert.equal(confirmedBody.approver_confirmation.status, "confirmed");
    assert.equal(confirmedBody.approver_confirmation.channel, "email");
    assert.equal(confirmedBody.approver_confirmation.contact_masked, MASKED);
    assert.equal(typeof confirmedBody.approver_confirmation.at, "string");
    assert.equal(confirmedBody.timeline.length, 2);
    assert.equal(confirmedBody.timeline[1]?.kind, "approver_confirmed");
    assert.equal(confirmedBody.timeline[1]?.prev_hash, pendingBody.content_hash);
    assert.equal(confirmedBody.timeline[1]?.hash, confirmedBody.content_hash);
    assert.equal(after.body.includes(CONTACT), false);
    assert.equal(after.body.includes(token), false);

    const verified = await app.inject({ method: "GET", url: `/v1/receipts/${pendingBody.receipt_id}/verify` });
    const verdict = verified.json() as VerifyBody;
    assert.equal(verdict.valid, true);
    assert.equal(verdict.checks.chain, true);
    assert.equal(verdict.checks.content, true);
    assert.equal(verdict.checks.signature, true);
    assert.equal(verdict.approver_confirmation.status, "confirmed");

    const confirmedPage = await app.inject({ method: "GET", url: `/r/${pendingBody.receipt_id}` });
    assert.match(confirmedPage.body, /Approver confirmed ✓/);
    assert.match(confirmedPage.body, /Channel email/);
    assert.equal(confirmedPage.body.includes(MASKED), true);
    assert.match(confirmedPage.body, /class="badge ok">Verified</);
    assert.match(confirmedPage.body, /clicked Confirm/);
    assert.equal(confirmedPage.body.includes(CONTACT), false);

    const again = await postDecision(app, token, "confirm");
    assert.equal(again.statusCode, 409, again.body);
    assert.match(again.body, /already used to confirm/);
    const still = await app.inject({ method: "GET", url: `/v1/receipts/${pendingBody.receipt_id}` });
    assert.equal((still.json() as ReceiptBody).timeline.length, 2);
    assert.equal((still.json() as ReceiptBody).content_hash, confirmedBody.content_hash);

    const usedPage = await app.inject({ method: "GET", url: `/c/${token}` });
    assert.equal(usedPage.statusCode, 409, usedPage.body);
    assert.match(usedPage.body, /already used to confirm/);
    assert.doesNotMatch(usedPage.body, /<button/);

    const proof = await app.inject({
      method: "POST",
      url: `/v1/receipts/${pendingBody.receipt_id}/proof`,
      payload: { edit_token: pendingBody.edit_token, type: "order_confirmation", value: "ord_9", actual_amount: "20" },
    });
    assert.equal(proof.statusCode, 200, proof.body);
    const proved = proof.json() as ReceiptBody;
    assert.equal(proved.status, "delivered");
    assert.equal(proved.approver_confirmation.status, "confirmed");
    assert.equal(proved.timeline.length, 3);
    assert.equal(proved.timeline[2]?.prev_hash, confirmedBody.content_hash);
    const provedVerify = await app.inject({ method: "GET", url: `/v1/receipts/${pendingBody.receipt_id}/verify` });
    assert.equal((provedVerify.json() as VerifyBody).valid, true);

    const declinedCreate = await postReceipt(app, approval({ approver_contact: "sam@example.com", scope: "One notebook" }));
    const declinedReceipt = declinedCreate.json() as ReceiptBody;
    const declined = await postDecision(app, tokenFrom(declinedReceipt.confirm_url ?? ""), "decline");
    assert.equal(declined.statusCode, 200, declined.body);
    assert.match(declined.body, /You declined this request/);
    const declinedSeen = await app.inject({ method: "GET", url: `/v1/receipts/${declinedReceipt.receipt_id}` });
    const declinedBody = declinedSeen.json() as ReceiptBody;
    assert.equal(declinedBody.approver_confirmation.status, "declined");
    assert.equal(declinedBody.approver_confirmation.channel, "email");
    assert.equal(declinedBody.approver_confirmation.contact_masked, "s***@example.com");
    assert.equal(declinedBody.timeline[1]?.kind, "approver_declined");
    const declinedVerify = await app.inject({ method: "GET", url: `/v1/receipts/${declinedReceipt.receipt_id}/verify` });
    assert.equal((declinedVerify.json() as VerifyBody).valid, true);
    const declinedPage = await app.inject({ method: "GET", url: `/r/${declinedReceipt.receipt_id}` });
    assert.match(declinedPage.body, /Approver declined/);
    assert.match(declinedPage.body, /Channel email/);
    assert.doesNotMatch(declinedPage.body, /Approver confirmed ✓/);
    assert.match(declinedPage.body, /class="badge ok">Verified</);

    const second = await postDecision(app, tokenFrom(declinedReceipt.confirm_url ?? ""), "confirm");
    assert.equal(second.statusCode, 409, second.body);
    assert.match(second.body, /already used to decline/);
  } finally {
    await app.close();
  }
});

test("an expired confirm link cannot decide", async () => {
  const app = await appWith({ confirmTtlMs: 0 });
  try {
    const created = await postReceipt(app);
    const receipt = created.json() as ReceiptBody;
    const token = tokenFrom(receipt.confirm_url ?? "");
    const page = await app.inject({ method: "GET", url: `/c/${token}` });
    assert.equal(page.statusCode, 410, page.body);
    assert.match(page.body, /This confirmation link has expired/);
    assert.doesNotMatch(page.body, /<button/);
    const posted = await postDecision(app, token, "confirm");
    assert.equal(posted.statusCode, 410, posted.body);
    assert.match(posted.body, /This confirmation link has expired/);
    const seen = await app.inject({ method: "GET", url: `/v1/receipts/${receipt.receipt_id}` });
    const body = seen.json() as ReceiptBody;
    assert.equal(body.approver_confirmation.status, "unconfirmed");
    assert.equal(body.timeline.length, 1);
    assert.equal(body.content_hash, receipt.content_hash);
    const verified = await app.inject({ method: "GET", url: `/v1/receipts/${receipt.receipt_id}/verify` });
    assert.equal((verified.json() as VerifyBody).valid, true);
  } finally {
    await app.close();
  }
});

test("a configured notifier sends and omits confirm_url; a failed send returns the url", async () => {
  const sent: ApprovalNotice[] = [];
  const sending = await appWith({
    approvalNotifier: {
      configured: true,
      provider: "test",
      async send(notice) {
        sent.push(notice);
      },
    },
  });
  try {
    const created = await postReceipt(sending);
    const receipt = created.json() as ReceiptBody;
    assert.equal(receipt.confirm_url, undefined);
    assert.equal(receipt.confirm_delivery, "email");
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.to, CONTACT);
    assert.equal(sent[0]?.channel, "email");
    assert.match(sent[0]?.confirmUrl ?? "", /\/c\/cftok_/);
    const page = await sending.inject({ method: "GET", url: new URL(sent[0]?.confirmUrl ?? "").pathname });
    assert.equal(page.statusCode, 200, page.body);
    assert.match(page.body, /Confirm/);
  } finally {
    await sending.close();
  }

  const failing = await appWith({
    approvalNotifier: {
      configured: true,
      provider: "test",
      async send() {
        throw new Error("mailbox down");
      },
    },
  });
  try {
    const created = await postReceipt(failing);
    assert.equal(created.statusCode, 201, created.body);
    const receipt = created.json() as ReceiptBody;
    assert.equal(receipt.confirm_delivery, "caller");
    assert.match(receipt.confirm_url ?? "", /\/c\/cftok_/);
  } finally {
    await failing.close();
  }
});

test("a webhook failure still records the decision", async () => {
  const app = await appWith({
    confirmationWebhook: {
      async post() {
        throw new Error("down");
      },
    },
  });
  try {
    const created = await postReceipt(app, approval({ confirmation_webhook_url: "https://hooks.example/down" }));
    const receipt = created.json() as ReceiptBody;
    const decided = await postDecision(app, tokenFrom(receipt.confirm_url ?? ""), "confirm");
    assert.equal(decided.statusCode, 200, decided.body);
    const seen = await app.inject({ method: "GET", url: `/v1/receipts/${receipt.receipt_id}` });
    assert.equal((seen.json() as ReceiptBody).approver_confirmation.status, "confirmed");
    const verified = await app.inject({ method: "GET", url: `/v1/receipts/${receipt.receipt_id}/verify` });
    assert.equal((verified.json() as VerifyBody).valid, true);
  } finally {
    await app.close();
  }
});

test("confirm links are rate limited and stay inside the Stripe mode that issued them", async () => {
  const limited = await appWith({ confirmRateLimit: { max: 2, windowMs: 60_000 } });
  try {
    const headers = { "x-forwarded-for": "203.0.113.40" };
    const first = await limited.inject({ method: "GET", url: "/c/cftok_" + "aa".repeat(32), headers });
    const second = await limited.inject({ method: "GET", url: "/c/cftok_" + "bb".repeat(32), headers });
    assert.equal(first.statusCode, 404);
    assert.equal(second.statusCode, 404);
    const third = await limited.inject({ method: "GET", url: "/c/cftok_" + "cc".repeat(32), headers });
    assert.equal(third.statusCode, 429, third.body);
    assert.match(third.body, /Too many confirmation attempts/);
    assert.ok(Number(third.headers["retry-after"]) >= 1);
  } finally {
    await limited.close();
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "botsupply-confirm-mode-"));
  const sqlitePath = path.join(dir, "botsupply.sqlite");
  const testApp = await buildApp({
    sqlitePath,
    mode: "test",
    receiptSigningKey: SIGNING_KEY,
    approvalNotifier: { configured: false, provider: "none", async send() {} },
  });
  const liveApp = await buildApp({
    sqlitePath,
    mode: "live",
    receiptSigningKey: SIGNING_KEY,
    approvalNotifier: { configured: false, provider: "none", async send() {} },
  });
  try {
    const created = await postReceipt(testApp);
    const receipt = created.json() as ReceiptBody;
    const token = tokenFrom(receipt.confirm_url ?? "");
    const live = await liveApp.inject({ method: "GET", url: `/c/${token}` });
    assert.equal(live.statusCode, 404, live.body);
    const livePost = await postDecision(liveApp, token, "confirm");
    assert.equal(livePost.statusCode, 404, livePost.body);
    const testGet = await testApp.inject({ method: "GET", url: `/c/${token}` });
    assert.equal(testGet.statusCode, 200, testGet.body);
    const seen = await testApp.inject({ method: "GET", url: `/v1/receipts/${receipt.receipt_id}` });
    assert.equal((seen.json() as ReceiptBody).approver_confirmation.status, "unconfirmed");
  } finally {
    await testApp.close();
    await liveApp.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("receipts stored before confirmation columns still verify as unconfirmed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "botsupply-confirm-legacy-"));
  const sqlitePath = path.join(dir, "botsupply.sqlite");
  const key = Buffer.from(SIGNING_KEY);
  const planned = planApproval(
    {
      approverName: "Ada Lovelace",
      approverContactHash: hashApproverContact(CONTACT),
      confirmContact: null,
      confirmationWebhookUrl: null,
      agentId: null,
      agentName: "Desk Agent",
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
    key,
  );
  assert.equal(planned.event.payload_json.includes("approver_confirmation"), false);
  const db = new Database(sqlitePath);
  db.exec(`
    CREATE TABLE receipts (
      id TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      approver_name TEXT NOT NULL,
      approver_contact_hash TEXT,
      agent_id TEXT,
      agent_name TEXT,
      merchant_name TEXT NOT NULL,
      merchant_url TEXT,
      scope TEXT NOT NULL,
      price_cap_amount TEXT NOT NULL,
      price_cap_currency TEXT NOT NULL,
      payment_rail TEXT NOT NULL,
      external_payment_ref TEXT,
      status TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      signature TEXT NOT NULL,
      edit_token_hash TEXT NOT NULL
    );
    CREATE TABLE receipt_events (
      id TEXT PRIMARY KEY,
      receipt_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      seq INTEGER NOT NULL,
      kind TEXT NOT NULL,
      prev_hash TEXT NOT NULL,
      hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  const record = planned.record;
  db.prepare(
    `INSERT INTO receipts (
       id, mode, created_at, updated_at, approver_name, approver_contact_hash, agent_id, agent_name,
       merchant_name, merchant_url, scope, price_cap_amount, price_cap_currency, payment_rail,
       external_payment_ref, status, content_hash, signature, edit_token_hash
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.id,
    record.mode,
    record.created_at,
    record.updated_at,
    record.approver_name,
    record.approver_contact_hash,
    record.agent_id,
    record.agent_name,
    record.merchant_name,
    record.merchant_url,
    record.scope,
    record.price_cap_amount,
    record.price_cap_currency,
    record.payment_rail,
    record.external_payment_ref,
    record.status,
    record.content_hash,
    record.signature,
    record.edit_token_hash,
  );
  const event = planned.event;
  db.prepare(
    `INSERT INTO receipt_events (
       id, receipt_id, mode, seq, kind, prev_hash, hash, payload_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(event.id, record.id, record.mode, event.seq, event.kind, event.prev_hash, event.hash, event.payload_json, event.created_at);
  db.close();

  const app = await buildApp({ sqlitePath, mode: "dev", receiptSigningKey: SIGNING_KEY });
  try {
    const verified = await app.inject({ method: "GET", url: `/v1/receipts/${record.id}/verify` });
    assert.equal(verified.statusCode, 200, verified.body);
    const verdict = verified.json() as VerifyBody;
    assert.equal(verdict.valid, true);
    assert.equal(verdict.approver_confirmation.status, "unconfirmed");
    const page = await app.inject({ method: "GET", url: `/r/${record.id}` });
    assert.match(page.body, /Approver unconfirmed/);
    assert.match(page.body, /class="badge ok">Verified</);
    assert.doesNotMatch(page.body, /Approver confirmed ✓/);
    assert.equal(page.body.includes(CONTACT), false);
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
