import type { PublicReceipt, VerifyResult } from "./receipts.js";

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function row(label: string, value: string): string {
  return `<div class="row"><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`;
}

function proofBlock(receipt: PublicReceipt): string {
  if (receipt.proofs.length === 0) return `<p class="muted">No proof attached yet.</p>`;
  return receipt.proofs
    .map((proof, index) => {
      const amount =
        proof.actual_amount == null
          ? "Not stated"
          : `${proof.actual_amount} ${receipt.price_cap.currency}`;
      const cap = proof.over_cap ? `<span class="flag">Above cap</span>` : "";
      return `<article class="proof">
        <header><span>${esc(proof.type)}</span><time>${esc(proof.attached_at)}</time></header>
        <p class="value">${esc(proof.value)}</p>
        <p class="meta">Amount ${esc(amount)} ${cap}</p>
        <p class="meta">Proof ${index + 1}</p>
      </article>`;
    })
    .join("\n");
}

function timelineBlock(receipt: PublicReceipt): string {
  return receipt.timeline
    .map((entry) => {
      const label = entry.kind === "approved" ? "Reported as approved" : "Proof attached";
      return `<li>
        <div class="row"><dt>${esc(label)}</dt><dd>${esc(entry.at)}</dd></div>
        <p class="hash">prev ${esc(entry.prev_hash || "—")}</p>
        <p class="hash">${esc(entry.hash)}</p>
      </li>`;
    })
    .join("\n");
}

function merchantBlock(receipt: PublicReceipt): string {
  const url = receipt.merchant.url;
  const link =
    url == null
      ? ""
      : `<p><a href="${esc(url)}" rel="noreferrer">${esc(url)}</a></p>`;
  return `<p class="lead">${esc(receipt.merchant.name)}</p>${link}`;
}

/** Public receipt page. Inline CSS only. The approver contact is not rendered. */
export function renderReceiptPage(receipt: PublicReceipt, verification: VerifyResult): string {
  const valid = verification.valid;
  const badge = valid
    ? `<p class="badge ok">Verified</p>`
    : `<p class="badge bad">Tampered</p>`;
  const note = valid
    ? "The hash chain and server signature match this receipt."
    : "The stored receipt does not match its hash chain or server signature.";
  const verifiedMeaning = valid
    ? `<p class="explain">Verified = this record hasn't been changed since it was created. It doesn't confirm who approved.</p>`
    : "";
  const agent =
    receipt.agent_name || receipt.agent_id
      ? [receipt.agent_name, receipt.agent_id].filter((part) => part && part.length > 0).join(" · ")
      : "Not recorded";
  const ref = receipt.external_payment_ref ?? "None";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Receipt ${esc(receipt.receipt_id)}</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #090b08;
      --bg-2: #10140e;
      --ink: #e7f0dc;
      --muted: #93a38a;
      --line: #2a3824;
      --stamp: #d6ff4a;
      --stamp-ink: #142000;
      --amber: #ffb020;
      --danger: #ff6b4a;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      background:
        radial-gradient(900px 420px at 100% -10%, rgba(214, 255, 74, 0.08), transparent 50%),
        var(--bg);
      color: var(--ink);
      font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
      line-height: 1.5;
    }
    main { width: min(760px, calc(100% - 32px)); margin: 0 auto; padding: 28px 0 48px; }
    header.top { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
    .brand { margin: 0; letter-spacing: 0.12em; font-size: 12px; color: var(--muted); }
    h1 { margin: 8px 0 0; font-size: 28px; font-weight: 500; letter-spacing: -0.03em; }
    .verdict { display: flex; flex-direction: column; align-items: flex-end; gap: 10px; max-width: min(100%, 420px); }
    .badge { margin: 0; padding: 6px 10px; font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase; }
    .badge.ok { background: var(--stamp); color: var(--stamp-ink); }
    .badge.bad { background: var(--danger); color: #1a0703; }
    .reported { margin: 0; font-size: 13px; text-align: right; }
    .explain { color: var(--muted); margin: 18px 0 0; max-width: 62ch; }
    .note { color: var(--muted); margin: 18px 0 0; }
    .explain + .note { margin-top: 8px; }
    section { margin-top: 28px; padding-top: 16px; border-top: 1px solid var(--line); }
    h2 { margin: 0 0 12px; font-size: 12px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--muted); font-weight: 500; }
    .lead { margin: 0 0 8px; font-size: 18px; }
    .row { display: grid; grid-template-columns: minmax(140px, 220px) 1fr; gap: 8px 16px; margin: 0 0 8px; }
    dt { color: var(--muted); }
    dd { margin: 0; overflow-wrap: anywhere; }
    .scope { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
    .cap { margin: 0; font-size: 28px; letter-spacing: -0.04em; }
    .cap span { color: var(--amber); font-size: 14px; letter-spacing: 0.08em; }
    a { color: var(--stamp); }
    .proof { background: var(--bg-2); border: 1px solid var(--line); padding: 12px 14px; margin: 0 0 10px; }
    .proof header { display: flex; justify-content: space-between; gap: 12px; color: var(--stamp); font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; }
    .value { margin: 10px 0; overflow-wrap: anywhere; white-space: pre-wrap; }
    .meta, .muted, .hash { color: var(--muted); font-size: 12px; margin: 0 0 4px; overflow-wrap: anywhere; }
    .flag { color: var(--danger); letter-spacing: 0.08em; text-transform: uppercase; }
    ol { list-style: none; margin: 0; padding: 0; }
    li { margin: 0 0 14px; }
    .content-hash { margin: 0; overflow-wrap: anywhere; font-size: 13px; }
    footer { margin-top: 28px; color: var(--muted); font-size: 12px; }
    @media (max-width: 640px) {
      .row { grid-template-columns: 1fr; gap: 2px; }
      header.top { flex-direction: column; }
      .verdict { align-items: flex-start; }
      .reported { text-align: left; }
    }
  </style>
</head>
<body>
  <main>
    <header class="top">
      <div>
        <p class="brand">BOTSUPPLY // receipt</p>
        <h1>Purchase receipt</h1>
      </div>
      <div class="verdict">
        ${badge}
        <p class="reported">Approver (reported by agent): ${esc(receipt.approver)}</p>
      </div>
    </header>
    ${verifiedMeaning}
    <p class="note">${esc(note)} BotSupply did not hold or move the money. Rail: ${esc(receipt.payment_rail)}.</p>
    <section>
      <h2>Reported approval</h2>
      ${row("Approver (reported by agent)", receipt.approver)}
      ${row("Status", receipt.status)}
      ${row("When", receipt.created_at)}
      ${row("Agent", agent)}
      ${row("Mode", receipt.mode)}
      ${row("Receipt", receipt.receipt_id)}
    </section>
    <section>
      <h2>Scope</h2>
      <p class="scope">${esc(receipt.scope)}</p>
    </section>
    <section>
      <h2>Price cap</h2>
      <p class="cap">${esc(receipt.price_cap.amount)} <span>${esc(receipt.price_cap.currency)}</span></p>
      ${row("Payment ref", ref)}
    </section>
    <section>
      <h2>Merchant</h2>
      ${merchantBlock(receipt)}
    </section>
    <section>
      <h2>Proof</h2>
      ${proofBlock(receipt)}
    </section>
    <section>
      <h2>Timeline</h2>
      <ol>
        ${timelineBlock(receipt)}
      </ol>
    </section>
    <section>
      <h2>Content hash</h2>
      <p class="content-hash">${esc(receipt.content_hash)}</p>
    </section>
    <footer>Integrity check at /v1/receipts/${esc(receipt.receipt_id)}/verify. This does not confirm who approved.</footer>
  </main>
</body>
</html>`;
}
