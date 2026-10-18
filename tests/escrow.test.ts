import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork } from "node:child_process";
import test from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { openStore, type SettleJobResult } from "../src/db.js";
import { escrowFeeCredits, readEscrowFeeBps } from "../src/escrow.js";

type Wallet = { wallet_id: string; api_key: string };

type JobBody = {
  job_id: string;
  status: string;
  payer_wallet_id: string;
  payee_wallet_id: string;
  amount_credits: number;
  fee_bps: number;
  fee_credits: number;
  payee_credits: number;
  description: string;
  idempotency_key: string;
  payer_balance_credits: number;
  payee_balance_credits: number;
  idempotent_replay?: boolean;
};

async function openWallet(app: FastifyInstance, label: string, credits = 0): Promise<Wallet> {
  const created = await app.inject({ method: "POST", url: "/v1/wallets", payload: { label } });
  assert.equal(created.statusCode, 201, created.body);
  const wallet = created.json() as Wallet;
  if (credits > 0) {
    const topped = await app.inject({
      method: "POST",
      url: `/v1/wallets/${wallet.wallet_id}/topup`,
      payload: { credits },
    });
    assert.equal(topped.statusCode, 200, topped.body);
    assert.equal(topped.json().balance_credits, credits);
  }
  return wallet;
}

async function balanceOf(app: FastifyInstance, apiKey: string): Promise<number> {
  const response = await app.inject({
    method: "GET",
    url: "/v1/balance",
    headers: { authorization: `Bearer ${apiKey}` },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json().balance_credits as number;
}

function hold(
  app: FastifyInstance,
  payer: Wallet,
  payeeId: string,
  amount: number,
  idempotencyKey: string,
  description = "Write the venue brief",
) {
  return app.inject({
    method: "POST",
    url: "/v1/jobs",
    headers: { authorization: `Bearer ${payer.api_key}` },
    payload: {
      payee_wallet_id: payeeId,
      amount_credits: amount,
      description,
      idempotency_key: idempotencyKey,
    },
  });
}

test("escrow fee is floor of basis points and defaults to zero", () => {
  assert.equal(escrowFeeCredits(1000, 0), 0);
  assert.equal(escrowFeeCredits(1000, 250), 25);
  assert.equal(escrowFeeCredits(1, 1), 0);
  assert.equal(escrowFeeCredits(100, 10_000), 100);
  assert.equal(readEscrowFeeBps(undefined), 0);
  assert.equal(readEscrowFeeBps(""), 0);
  assert.equal(readEscrowFeeBps("250"), 250);
  assert.equal(readEscrowFeeBps("99999", 0), 0);
  assert.throws(() => readEscrowFeeBps("nope"), /ESCROW_FEE_BPS/);
  assert.throws(() => readEscrowFeeBps("10001"), /ESCROW_FEE_BPS/);
});

test("hold, release, and refund move credits once", async () => {
  const app = await buildApp({ sqlitePath: ":memory:" });
  try {
    const payer = await openWallet(app, "payer", 500);
    const payee = await openWallet(app, "payee");
    const stranger = await openWallet(app, "stranger", 50);

    const created = await hold(app, payer, payee.wallet_id, 120, "job-hold-1");
    assert.equal(created.statusCode, 201, created.body);
    const job = created.json() as JobBody;
    assert.match(job.job_id, /^job_[0-9a-f]+$/);
    assert.equal(job.status, "held");
    assert.equal(job.amount_credits, 120);
    assert.equal(job.fee_bps, 0);
    assert.equal(job.fee_credits, 0);
    assert.equal(job.payee_credits, 0);
    assert.equal(job.payer_balance_credits, 380);
    assert.equal(job.payee_balance_credits, 0);
    assert.equal(job.idempotent_replay, undefined);
    assert.equal(await balanceOf(app, payer.api_key), 380);
    assert.equal(await balanceOf(app, payee.api_key), 0);

    const seen = await app.inject({
      method: "GET",
      url: `/v1/jobs/${job.job_id}`,
      headers: { authorization: `Bearer ${payee.api_key}` },
    });
    assert.equal(seen.statusCode, 200, seen.body);
    assert.equal(seen.json().status, "held");

    const hidden = await app.inject({
      method: "GET",
      url: `/v1/jobs/${job.job_id}`,
      headers: { authorization: `Bearer ${stranger.api_key}` },
    });
    assert.equal(hidden.statusCode, 404);

    const payeeRelease = await app.inject({
      method: "POST",
      url: `/v1/jobs/${job.job_id}/release`,
      headers: { authorization: `Bearer ${payee.api_key}` },
      payload: {},
    });
    assert.equal(payeeRelease.statusCode, 403, payeeRelease.body);
    assert.equal(payeeRelease.json().error.code, "forbidden");
    assert.equal(await balanceOf(app, payer.api_key), 380);

    const released = await app.inject({
      method: "POST",
      url: `/v1/jobs/${job.job_id}/release`,
      headers: { authorization: `Bearer ${payer.api_key}` },
      payload: {},
    });
    assert.equal(released.statusCode, 200, released.body);
    const paid = released.json() as JobBody;
    assert.equal(paid.status, "released");
    assert.equal(paid.fee_credits, 0);
    assert.equal(paid.payee_credits, 120);
    assert.equal(paid.payer_balance_credits, 380);
    assert.equal(paid.payee_balance_credits, 120);

    const again = await app.inject({
      method: "POST",
      url: `/v1/jobs/${job.job_id}/release`,
      headers: { authorization: `Bearer ${payer.api_key}` },
      payload: {},
    });
    assert.equal(again.statusCode, 409, again.body);
    assert.equal(again.json().error.code, "job_not_held");
    assert.equal(await balanceOf(app, payee.api_key), 120);
    assert.equal(await balanceOf(app, payer.api_key), 380);

    const refundAfter = await app.inject({
      method: "POST",
      url: `/v1/jobs/${job.job_id}/refund`,
      headers: { authorization: `Bearer ${payer.api_key}` },
      payload: {},
    });
    assert.equal(refundAfter.statusCode, 409);
    assert.equal(await balanceOf(app, payer.api_key), 380);
    assert.equal(await balanceOf(app, payee.api_key), 120);

    const payerRefund = await openWallet(app, "payer-refund", 80);
    const payeeRefund = await openWallet(app, "payee-refund");
    const held = await hold(app, payerRefund, payeeRefund.wallet_id, 80, "job-refund-1");
    assert.equal(held.statusCode, 201, held.body);
    const refundJobId = (held.json() as JobBody).job_id;
    const refunded = await app.inject({
      method: "POST",
      url: `/v1/jobs/${refundJobId}/refund`,
      headers: { authorization: `Bearer ${payeeRefund.api_key}` },
      payload: {},
    });
    assert.equal(refunded.statusCode, 200, refunded.body);
    assert.equal(refunded.json().status, "refunded");
    assert.equal(refunded.json().payee_credits, 0);
    assert.equal(refunded.json().payer_balance_credits, 80);
    assert.equal(refunded.json().payee_balance_credits, 0);
    assert.equal(await balanceOf(app, payerRefund.api_key), 80);

    const releaseAfter = await app.inject({
      method: "POST",
      url: `/v1/jobs/${refundJobId}/release`,
      headers: { authorization: `Bearer ${payerRefund.api_key}` },
      payload: {},
    });
    assert.equal(releaseAfter.statusCode, 409);
    assert.equal(releaseAfter.json().error.code, "job_not_held");
    assert.equal(await balanceOf(app, payerRefund.api_key), 80);
    assert.equal(await balanceOf(app, payeeRefund.api_key), 0);

    const doubleRefund = await app.inject({
      method: "POST",
      url: `/v1/jobs/${refundJobId}/refund`,
      headers: { authorization: `Bearer ${payerRefund.api_key}` },
      payload: {},
    });
    assert.equal(doubleRefund.statusCode, 409);
    assert.equal(await balanceOf(app, payerRefund.api_key), 80);
  } finally {
    await app.close();
  }
});

test("hold rejects insufficient funds, same wallet, and a missing payee", async () => {
  const app = await buildApp({ sqlitePath: ":memory:" });
  try {
    const payer = await openWallet(app, "thin", 40);
    const payee = await openWallet(app, "other");

    const short = await hold(app, payer, payee.wallet_id, 41, "too-much");
    assert.equal(short.statusCode, 402, short.body);
    assert.equal(short.json().error.code, "insufficient_credits");
    assert.equal(await balanceOf(app, payer.api_key), 40);

    const zero = await hold(app, payer, payee.wallet_id, 0, "zero");
    assert.equal(zero.statusCode, 400);
    const negative = await hold(app, payer, payee.wallet_id, -5, "negative");
    assert.equal(negative.statusCode, 400);
    assert.equal(await balanceOf(app, payer.api_key), 40);

    const self = await hold(app, payer, payer.wallet_id, 10, "self");
    assert.equal(self.statusCode, 400, self.body);
    assert.match(self.json().error.message, /different wallets/);

    const missing = await hold(app, payer, "wal_missing", 10, "missing-payee");
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.code, "not_found");
    assert.equal(await balanceOf(app, payer.api_key), 40);

    const anon = await app.inject({
      method: "POST",
      url: "/v1/jobs",
      payload: {
        payee_wallet_id: payee.wallet_id,
        amount_credits: 10,
        description: "no key",
        idempotency_key: "anon",
      },
    });
    assert.equal(anon.statusCode, 401);

    const exact = await hold(app, payer, payee.wallet_id, 40, "exact");
    assert.equal(exact.statusCode, 201, exact.body);
    assert.equal(exact.json().payer_balance_credits, 0);
  } finally {
    await app.close();
  }
});

test("idempotency key replays the same hold and rejects a different payload", async () => {
  const app = await buildApp({ sqlitePath: ":memory:" });
  try {
    const payer = await openWallet(app, "payer", 300);
    const payee = await openWallet(app, "payee");
    const otherPayee = await openWallet(app, "other-payee");

    const first = await hold(app, payer, payee.wallet_id, 70, "same-key", "first brief");
    assert.equal(first.statusCode, 201, first.body);
    const jobId = (first.json() as JobBody).job_id;

    const replay = await hold(app, payer, payee.wallet_id, 70, "same-key", "first brief");
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().job_id, jobId);
    assert.equal(replay.json().idempotent_replay, true);
    assert.equal(replay.json().status, "held");
    assert.equal(await balanceOf(app, payer.api_key), 230);

    const changed = await hold(app, payer, payee.wallet_id, 71, "same-key", "first brief");
    assert.equal(changed.statusCode, 409, changed.body);
    assert.equal(changed.json().error.code, "idempotency_conflict");
    assert.equal(await balanceOf(app, payer.api_key), 230);

    const otherParty = await hold(app, payer, otherPayee.wallet_id, 70, "same-key", "first brief");
    assert.equal(otherParty.statusCode, 409);
    assert.equal(await balanceOf(app, payer.api_key), 230);

    const otherPayer = await openWallet(app, "second-payer", 100);
    const separate = await hold(app, otherPayer, payee.wallet_id, 15, "same-key", "different payer");
    assert.equal(separate.statusCode, 201, separate.body);
    assert.notEqual(separate.json().job_id, jobId);
    assert.equal(await balanceOf(app, otherPayer.api_key), 85);
    assert.equal(await balanceOf(app, payer.api_key), 230);
  } finally {
    await app.close();
  }
});

test("release fee is withheld from the payee and credited to nobody", async () => {
  const app = await buildApp({ sqlitePath: ":memory:", escrowFeeBps: 250 });
  try {
    const payer = await openWallet(app, "payer", 1000);
    const payee = await openWallet(app, "payee", 5);
    const created = await hold(app, payer, payee.wallet_id, 1000, "fee-job");
    assert.equal(created.statusCode, 201, created.body);
    const released = await app.inject({
      method: "POST",
      url: `/v1/jobs/${created.json().job_id}/release`,
      headers: { authorization: `Bearer ${payer.api_key}` },
      payload: {},
    });
    assert.equal(released.statusCode, 200, released.body);
    const body = released.json() as JobBody;
    assert.equal(body.fee_bps, 250);
    assert.equal(body.fee_credits, 25);
    assert.equal(body.payee_credits, 975);
    assert.equal(body.payer_balance_credits, 0);
    assert.equal(body.payee_balance_credits, 980);
    assert.equal(await balanceOf(app, payer.api_key), 0);
    assert.equal(await balanceOf(app, payee.api_key), 980);
  } finally {
    await app.close();
  }
});

test("test-mode jobs and wallets are invisible in live mode", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "botsupply-escrow-mode-"));
  const sqlitePath = path.join(dir, "botsupply.sqlite");
  const testApp = await buildApp({ sqlitePath, mode: "test" });
  const liveApp = await buildApp({ sqlitePath, mode: "live" });
  try {
    const payer = await openWallet(testApp, "test-payer", 200);
    const payee = await openWallet(testApp, "test-payee");
    const liveWallet = await openWallet(liveApp, "live-wallet", 200);
    const created = await hold(testApp, payer, payee.wallet_id, 60, "mode-job");
    assert.equal(created.statusCode, 201, created.body);
    const jobId = (created.json() as JobBody).job_id;

    const crossPayee = await hold(testApp, payer, liveWallet.wallet_id, 10, "cross-payee");
    assert.equal(crossPayee.statusCode, 404, crossPayee.body);
    assert.equal(await balanceOf(testApp, payer.api_key), 140);

    const liveGet = await liveApp.inject({
      method: "GET",
      url: `/v1/jobs/${jobId}`,
      headers: { authorization: `Bearer ${liveWallet.api_key}` },
    });
    assert.equal(liveGet.statusCode, 404);
    const liveRelease = await liveApp.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/release`,
      headers: { authorization: `Bearer ${liveWallet.api_key}` },
      payload: {},
    });
    assert.equal(liveRelease.statusCode, 404);
    const liveKeyOnTestJob = await liveApp.inject({
      method: "GET",
      url: `/v1/jobs/${jobId}`,
      headers: { authorization: `Bearer ${payer.api_key}` },
    });
    assert.equal(liveKeyOnTestJob.statusCode, 401);

    const testStore = await openStore({ sqlitePath, mode: "test" });
    const liveStore = await openStore({ sqlitePath, mode: "live" });
    try {
      assert.equal((await liveStore.getJob(jobId))?.id, undefined);
      const liveSettle = await liveStore.releaseJob(jobId, 0);
      assert.equal(liveSettle.ok, false);
      if (!liveSettle.ok) assert.equal(liveSettle.code, "not_found");
      const liveRefund = await liveStore.refundJob(jobId);
      assert.equal(liveRefund.ok, false);
      const stillHeld = await testStore.getJob(jobId);
      assert.equal(stillHeld?.status, "held");
      assert.equal((await testStore.findWalletById(payer.wallet_id))?.balance_credits, 140);
      assert.equal((await testStore.findWalletById(payee.wallet_id))?.balance_credits, 0);
      assert.equal(await liveStore.findWalletById(payer.wallet_id), undefined);
    } finally {
      await testStore.close();
      await liveStore.close();
    }

    const testGet = await testApp.inject({
      method: "GET",
      url: `/v1/jobs/${jobId}`,
      headers: { authorization: `Bearer ${payer.api_key}` },
    });
    assert.equal(testGet.statusCode, 200);
    assert.equal(testGet.json().status, "held");
  } finally {
    await testApp.close();
    await liveApp.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function releaseInChild(sqlitePath: string, jobId: string): Promise<SettleJobResult> {
  return new Promise((resolve, reject) => {
    const child = fork(new URL("./escrow-release-worker.ts", import.meta.url), [sqlitePath, jobId]);
    let settled = false;
    child.once("message", (message: SettleJobResult) => {
      settled = true;
      resolve(message);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (!settled) reject(new Error(`escrow child exited ${code} before posting a result`));
    });
  });
}

test("concurrent releases credit the payee once", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "botsupply-escrow-race-"));
  const sqlitePath = path.join(dir, "botsupply.sqlite");
  const app = await buildApp({ sqlitePath, mode: "dev" });
  let jobId = "";
  let payerId = "";
  let payeeId = "";
  try {
    const payer = await openWallet(app, "payer", 500);
    const payee = await openWallet(app, "payee");
    payerId = payer.wallet_id;
    payeeId = payee.wallet_id;
    const created = await hold(app, payer, payee.wallet_id, 200, "race-job");
    assert.equal(created.statusCode, 201, created.body);
    jobId = (created.json() as JobBody).job_id;
  } finally {
    await app.close();
  }

  try {
    const [left, right] = await Promise.all([releaseInChild(sqlitePath, jobId), releaseInChild(sqlitePath, jobId)]);
    const wins = [left, right].filter((result) => result.ok);
    const losses = [left, right].filter((result) => !result.ok);
    assert.equal(wins.length, 1, JSON.stringify([left, right]));
    assert.equal(losses.length, 1);
    const loss = losses[0];
    assert.ok(loss);
    if (!loss.ok) assert.equal(loss.code, "not_held");

    const store = await openStore({ sqlitePath, mode: "dev" });
    try {
      const job = await store.getJob(jobId);
      assert.equal(job?.status, "released");
      assert.equal((await store.findWalletById(payerId))?.balance_credits, 300);
      assert.equal((await store.findWalletById(payeeId))?.balance_credits, 200);
      const third = await store.releaseJob(jobId, 0);
      assert.equal(third.ok, false);
      assert.equal((await store.findWalletById(payeeId))?.balance_credits, 200);
    } finally {
      await store.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP escrow tools hold, release, and refund through the HTTP routes", async () => {
  const app = await buildApp({ sqlitePath: ":memory:" });
  try {
    const payer = await openWallet(app, "mcp-payer", 90);
    const payee = await openWallet(app, "mcp-payee");
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${payer.api_key}`,
    };
    const call = async (name: string, args: Record<string, unknown>, authorization?: string) => {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: authorization ? { ...headers, authorization } : headers,
        payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
      });
      assert.equal(response.statusCode, 200, response.body);
      const type = String(response.headers["content-type"] ?? "");
      const payload = type.includes("text/event-stream")
        ? (JSON.parse(response.body.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim() ?? "null") as {
            result?: { isError?: boolean; content?: Array<{ text?: string }> };
          })
        : (response.json() as { result?: { isError?: boolean; content?: Array<{ text?: string }> } });
      const text = payload.result?.content?.find((block) => block.text)?.text ?? "";
      return { isError: payload.result?.isError === true, body: JSON.parse(text) as JobBody & { error?: { code: string } } };
    };

    const created = await call("create_job", {
      payee_wallet_id: payee.wallet_id,
      amount_credits: 30,
      description: "MCP escrow",
      idempotency_key: "mcp-1",
    });
    assert.equal(created.isError, false, JSON.stringify(created.body));
    assert.equal(created.body.status, "held");
    assert.equal(created.body.payer_balance_credits, 60);

    const fetched = await call("get_job", { job_id: created.body.job_id }, `Bearer ${payee.api_key}`);
    assert.equal(fetched.isError, false);
    assert.equal(fetched.body.job_id, created.body.job_id);

    const refunded = await call("refund_job", { job_id: created.body.job_id }, `Bearer ${payee.api_key}`);
    assert.equal(refunded.isError, false, JSON.stringify(refunded.body));
    assert.equal(refunded.body.status, "refunded");
    assert.equal(await balanceOf(app, payer.api_key), 90);

    const second = await call("create_job", {
      payee_wallet_id: payee.wallet_id,
      amount_credits: 20,
      description: "MCP release",
      idempotency_key: "mcp-2",
    });
    assert.equal(second.isError, false, JSON.stringify(second.body));
    const released = await call("release_job", { job_id: second.body.job_id });
    assert.equal(released.isError, false, JSON.stringify(released.body));
    assert.equal(released.body.status, "released");
    assert.equal(released.body.payee_credits, 20);
    assert.equal(await balanceOf(app, payee.api_key), 20);

    const doubled = await call("release_job", { job_id: second.body.job_id });
    assert.equal(doubled.isError, true);
    assert.equal(await balanceOf(app, payee.api_key), 20);
  } finally {
    await app.close();
  }
});
