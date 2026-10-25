export type ConfirmFormModel = {
  token: string;
  scope: string;
  priceCapAmount: string;
  priceCapCurrency: string;
  merchantName: string;
  agentLabel: string;
  expiresAt: string;
};

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

function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <meta name="robots" content="noindex">
  <title>${esc(title)}</title>
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
      --danger: #ff6b4a;
      --danger-ink: #1a0703;
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
    main { width: min(640px, calc(100% - 32px)); margin: 0 auto; padding: 28px 0 48px; }
    .brand { margin: 0; letter-spacing: 0.12em; font-size: 12px; color: var(--muted); }
    h1 { margin: 8px 0 0; font-size: 28px; font-weight: 500; letter-spacing: -0.03em; }
    .note { color: var(--muted); margin: 18px 0 0; }
    section { margin-top: 28px; padding-top: 16px; border-top: 1px solid var(--line); }
    h2 { margin: 0 0 12px; font-size: 12px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--muted); font-weight: 500; }
    .row { display: grid; grid-template-columns: 140px 1fr; gap: 8px 16px; margin: 0 0 8px; }
    dt { color: var(--muted); }
    dd { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
    .actions { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 8px; }
    button {
      font: inherit;
      cursor: pointer;
      border: 1px solid transparent;
      padding: 12px 18px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    button.confirm { background: var(--stamp); color: var(--stamp-ink); }
    button.decline { background: transparent; color: var(--danger); border-color: var(--danger); }
    a { color: var(--stamp); }
    @media (max-width: 640px) {
      .row { grid-template-columns: 1fr; gap: 2px; }
    }
  </style>
</head>
<body>
  <main>
    <p class="brand">BOTSUPPLY // confirm</p>
    ${body}
  </main>
</body>
</html>`;
}

function row(label: string, value: string): string {
  return `<div class="row"><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`;
}

/** Summary and buttons. The token is only in the form action. GET does not decide. */
export function renderConfirmForm(model: ConfirmFormModel): string {
  const token = encodeURIComponent(model.token);
  const cap = `${model.priceCapAmount} ${model.priceCapCurrency}`;
  return page(
    "Confirm purchase",
    `<h1>Confirm this purchase?</h1>
    <p class="note">Opening this page does not confirm or decline. Use a button. The link works once and expires ${esc(model.expiresAt)}. BotSupply does not hold or move the money.</p>
    <section>
      <h2>Request</h2>
      ${row("What", model.scope)}
      ${row("Price cap", cap)}
      ${row("Merchant", model.merchantName)}
      ${row("Requesting agent", model.agentLabel)}
    </section>
    <section>
      <h2>Your decision</h2>
      <div class="actions">
        <form method="post" action="/c/${token}/confirm">
          <button class="confirm" type="submit">Confirm</button>
        </form>
        <form method="post" action="/c/${token}/decline">
          <button class="decline" type="submit">Decline</button>
        </form>
      </div>
    </section>`,
  );
}

export function renderConfirmMessage(title: string, message: string): string {
  return page(title, `<h1>${esc(title)}</h1><p class="note">${esc(message)}</p>`);
}

export function renderConfirmResult(decision: "confirmed" | "declined", receiptPath: string): string {
  const title = decision === "confirmed" ? "You confirmed this request" : "You declined this request";
  const detail =
    decision === "confirmed"
      ? "Your confirm click is now part of the receipt. It means you opened this link and clicked Confirm."
      : "Your decline click is now part of the receipt. It means you opened this link and clicked Decline.";
  return page(
    title,
    `<h1>${esc(title)}</h1>
    <p class="note">${esc(detail)} This link cannot be used again.</p>
    <p class="note"><a href="${esc(receiptPath)}">View the receipt</a></p>`,
  );
}
