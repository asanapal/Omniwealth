/**
 * OmniWealth Muse Connector
 * Secure multi-asset portfolio aggregator for the Meta Muse Connector Platform.
 *
 * Auth: every request must carry `Authorization: Bearer <token>`, validated
 * against the CONNECTOR_API_TOKEN env var with a timing-safe comparison.
 * The connector fails closed: no token configured => service refuses all calls.
 *
 * NOTE: portfolio data below is in-memory seed data. Replace loadPortfolio()
 * with calls to your brokerage / custodian APIs before publishing.
 */

const express = require("express");
const crypto = require("crypto");
require("dotenv").config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_TOKEN = process.env.CONNECTOR_API_TOKEN || "";

// ---- Freemium tiers ----
// free: aggregates up to FREE_ACCOUNT_LIMIT linked accounts
// paid: aggregates all linked accounts (Stripe billing handled on the platform side)
const PLAN = (process.env.PLAN || "free").toLowerCase();
const FREE_ACCOUNT_LIMIT = parseInt(process.env.FREE_ACCOUNT_LIMIT || "2", 10);

// ---- In-memory portfolio seed (replace with live account aggregation) ----
const TARGET_ALLOCATION = {
  Equities: 0.6,
  Crypto: 0.1,
  "Real Estate & Alternatives": 0.3,
};
const DRIFT_THRESHOLD = 0.05; // 5% absolute drift triggers rebalance

function loadPortfolio() {
  return {
    currency: "USD",
    accounts: [
      { name: "Brokerage", asset_class: "Equities", value: 150000.0 },
      { name: "Crypto wallet", asset_class: "Crypto", value: 45000.5 },
      { name: "REIT holdings", asset_class: "Real Estate & Alternatives", value: 89500.0 },
    ],
  };
}

// ---- Security middleware: timing-safe bearer token validation ----
function verifyToken(req, res, next) {
  const header = req.headers.authorization || "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (!API_TOKEN) {
    return res
      .status(503)
      .json({ error: "Service unavailable: connector token not configured." });
  }

  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(API_TOKEN, "utf8");
  const valid =
    a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!valid) {
    // Generic message: do not reveal why the token failed.
    return res.status(401).json({ error: "Unauthorized." });
  }
  next();
}

// ---- Shared aggregation logic ----
async function summarizePortfolio() {
  // Prefer live Plaid holdings when a brokerage is linked; fall back to seed data.
  let currency = "USD";
  let accounts = loadPortfolio().accounts;
  let live = false;
  if (plaidAccessToken) {
    try {
      const plaid = await loadPlaidPortfolio();
      currency = plaid.currency;
      accounts = plaid.accounts;
      live = true;
    } catch (err) {
      console.error("plaid holdings error, using seed data:", err.message);
    }
  }

  // Freemium gating: free plan only aggregates the first N accounts
  const visibleAccounts =
    PLAN === "paid" ? accounts : accounts.slice(0, FREE_ACCOUNT_LIMIT);
  const excludedCount = accounts.length - visibleAccounts.length;

  const total = visibleAccounts.reduce((sum, a) => sum + a.value, 0);

  const byClass = new Map();
  for (const a of visibleAccounts) {
    byClass.set(a.asset_class, (byClass.get(a.asset_class) || 0) + a.value);
  }

  const allocations = [...byClass.entries()].map(([asset_class, value]) => ({
    asset_class,
    value: round2(value),
    percentage: total > 0 ? round2((value / total) * 100) : 0,
  }));

  return {
    total_net_worth: round2(total),
    currency,
    allocations,
    byClass,
    total,
    plan: PLAN,
    data_source: live ? "plaid" : "seed",
    accounts_included: visibleAccounts.length,
    accounts_excluded: excludedCount > 0 ? excludedCount : 0,
    upgrade_available: PLAN !== "paid" && excludedCount > 0,
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ---- Endpoints ----

// GET /v1/portfolio/summary — total net worth + asset class breakdown
app.get("/v1/portfolio/summary", verifyToken, async (req, res) => {
  try {
    const {
      total_net_worth,
      currency,
      allocations,
      plan,
      data_source,
      accounts_included,
      accounts_excluded,
      upgrade_available,
    } = await summarizePortfolio();
    res.json({
      total_net_worth,
      currency,
      allocations,
      plan,
      data_source,
      accounts_included,
      accounts_excluded,
      upgrade_available,
    });
  } catch (err) {
    console.error("summary error:", err.message);
    res.status(500).json({ error: "Failed to fetch portfolio data." });
  }
});

// GET /v1/portfolio/drift — compare current weights vs targets, recommend rebalances
app.get("/v1/portfolio/drift", verifyToken, async (req, res) => {
  try {
    const { total_net_worth, byClass, total, plan } = await summarizePortfolio();

    const recommendations = [];
    for (const [asset_class, target] of Object.entries(TARGET_ALLOCATION)) {
      const currentValue = byClass.get(asset_class) || 0;
      const currentWeight = total > 0 ? currentValue / total : 0;
      const drift = currentWeight - target;

      if (Math.abs(drift) >= DRIFT_THRESHOLD) {
        const targetValue = total * target;
        const delta = round2(targetValue - currentValue);
        recommendations.push({
          asset_class,
          action: delta > 0 ? "buy" : "sell",
          amount: Math.abs(delta),
          current_percentage: round2(currentWeight * 100),
          target_percentage: round2(target * 100),
          drift_percentage: round2(drift * 100),
        });
      }
    }

    res.json({
      total_net_worth,
      plan,
      rebalance_needed: recommendations.length > 0,
      drift_threshold_percentage: DRIFT_THRESHOLD * 100,
      recommendations,
    });
  } catch (err) {
    console.error("drift error:", err.message);
    res.status(500).json({ error: "Failed to analyze portfolio drift." });
  }
});

// ---- Plaid integration (live brokerage aggregation) ----
const { Configuration, PlaidApi, PlaidEnvironments } = require("plaid");

const PLAID_CLIENT_ID = process.env.PLAID_CLIENT_ID || "";
const PLAID_SECRET = process.env.PLAID_SECRET || "";
const PLAID_ENV = (process.env.PLAID_ENV || "sandbox").toLowerCase();

const plaidConfig = new Configuration({
  basePath:
    PLAID_ENV === "production"
      ? PlaidEnvironments.production
      : PLAID_ENV === "development"
        ? PlaidEnvironments.development
        : PlaidEnvironments.sandbox,
  baseOptions: {
    headers: { "PLAID-CLIENT-ID": PLAID_CLIENT_ID, "PLAID-SECRET": PLAID_SECRET },
  },
});
const plaidClient = new PlaidApi(plaidConfig);

// PROTOTYPE: single linked item kept in memory. Production needs per-user
// encrypted access-token storage in a database.
let plaidAccessToken = process.env.PLAID_ACCESS_TOKEN || null;

function plaidConfigured() {
  return Boolean(PLAID_CLIENT_ID && PLAID_SECRET);
}

// Map a Plaid security type to one of our three asset-class buckets.
function plaidAssetClass(securityType) {
  const t = (securityType || "").toLowerCase();
  if (t.includes("crypto")) return "Crypto";
  if (
    t.includes("equity") ||
    t.includes("etf") ||
    t.includes("mutual") ||
    t.includes("index") ||
    t.includes("stock")
  )
    return "Equities";
  return "Real Estate & Alternatives";
}

async function loadPlaidPortfolio() {
  const { data } = await plaidClient.investmentsHoldingsGet({
    access_token: plaidAccessToken,
  });
  const securities = new Map((data.securities || []).map((s) => [s.security_id, s]));
  const accounts = new Map();

  for (const h of data.holdings || []) {
    const sec = securities.get(h.security_id) || {};
    const assetClass = plaidAssetClass(sec.type);
    const value = Number(h.institution_value || 0);
    const acct = accounts.get(h.account_id) || {
      name: "",
      byClass: new Map(),
    };
    acct.byClass.set(assetClass, (acct.byClass.get(assetClass) || 0) + value);
    accounts.set(h.account_id, acct);
  }

  const plaidAccounts = new Map((data.accounts || []).map((a) => [a.account_id, a]));
  const result = [];
  for (const [accountId, acct] of accounts) {
    const info = plaidAccounts.get(accountId) || {};
    // Predominant asset class by value becomes the account's class.
    let topClass = "Equities";
    let topValue = -1;
    for (const [cls, v] of acct.byClass) {
      if (v > topValue) {
        topValue = v;
        topClass = cls;
      }
    }
    const total = [...acct.byClass.values()].reduce((s, v) => s + v, 0);
    result.push({
      name: info.name || info.official_name || "Brokerage account",
      asset_class: topClass,
      value: round2(total),
    });
  }
  return { currency: "USD", accounts: result, live: true };
}

// POST /v1/plaid/link-token — create a Plaid Link token for the connect flow
app.post("/v1/plaid/link-token", verifyToken, async (req, res) => {
  if (!plaidConfigured()) {
    return res.status(503).json({ error: "Plaid is not configured on this service." });
  }
  try {
    const { data } = await plaidClient.linkTokenCreate({
      user: { client_user_id: "omniwealth-user" },
      client_name: "OmniWealth",
      products: ["investments"],
      country_codes: ["US"],
      language: "en",
    });
    res.json({ link_token: data.link_token, expiration: data.expiration });
  } catch (err) {
    console.error("link-token error:", err.message);
    res.status(500).json({ error: "Failed to create Plaid link token." });
  }
});

// POST /v1/plaid/exchange — trade a Link public_token for an access token
app.post("/v1/plaid/exchange", verifyToken, async (req, res) => {
  if (!plaidConfigured()) {
    return res.status(503).json({ error: "Plaid is not configured on this service." });
  }
  const publicToken = req.body && req.body.public_token;
  if (!publicToken) {
    return res.status(400).json({ error: "public_token is required." });
  }
  try {
    const { data } = await plaidClient.itemPublicTokenExchange({
      public_token: publicToken,
    });
    plaidAccessToken = data.access_token; // prototype: in-memory (see note above)
    res.json({ linked: true, item_id: data.item_id });
  } catch (err) {
    console.error("exchange error:", err.message);
    res.status(500).json({ error: "Failed to exchange Plaid public token." });
  }
});

// GET /v1/plaid/status — whether a brokerage is linked
app.get("/v1/plaid/status", verifyToken, (req, res) => {
  res.json({
    plaid_configured: plaidConfigured(),
    environment: PLAID_ENV,
    linked: Boolean(plaidAccessToken),
  });
});

// GET /connect — Plaid Link page for connecting a brokerage (sandbox-ready)
app.get("/connect", (req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OmniWealth — Connect brokerage</title>
<script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script></head>
<body style="font-family:system-ui,sans-serif;max-width:560px;margin:3rem auto;padding:0 1rem;line-height:1.6">
<h1>Connect your brokerage</h1>
<p>Link a brokerage account through Plaid. Your credentials go to your bank only —
OmniWealth receives read-only access tokens.</p>
<label>Connector bearer token<br>
<input id="token" type="password" style="width:100%;padding:.6rem;margin:.4rem 0" placeholder="Paste your OmniWealth API token"></label><br>
<button id="go" style="padding:.7rem 1.4rem;font-size:1rem;cursor:pointer">Connect brokerage</button>
<p id="msg"></p>
<script>
const msg = (t) => document.getElementById('msg').textContent = t;
document.getElementById('go').onclick = async () => {
  const token = document.getElementById('token').value.trim();
  if (!token) return msg('Enter your connector bearer token first.');
  msg('Creating secure link session…');
  const r = await fetch('/v1/plaid/link-token', {
    method: 'POST', headers: { 'Authorization': 'Bearer ' + token }
  });
  if (!r.ok) return msg('Could not start link session (check your token).');
  const { link_token } = await r.json();
  const handler = Plaid.create({
    token: link_token,
    onSuccess: async (public_token) => {
      msg('Exchanging token…');
      const e = await fetch('/v1/plaid/exchange', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ public_token })
      });
      msg(e.ok ? 'Brokerage linked! Your portfolio summary now uses live data.' : 'Link failed during exchange.');
    },
    onExit: (err) => { if (err) msg('Link closed: ' + (err.error_message || err.error_code)); }
  });
  handler.open();
};
</script></body></html>`);
});

// Health check (unauthenticated by design)
app.get("/health", (req, res) => res.json({ status: "ok" }));

// Terms of service (unauthenticated by design)
app.get("/terms", (req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OmniWealth — Terms of Service</title></head>
<body style="font-family:system-ui,sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem;line-height:1.6">
<h1>OmniWealth Terms of Service</h1>
<p><strong>Effective date:</strong> September 19, 2026</p>
<h2>1. The service</h2>
<p>OmniWealth is a portfolio aggregation connector for the Meta Muse platform. It summarizes
portfolio values across linked accounts and analyzes drift from target allocations.</p>
<h2>2. Plans and billing</h2>
<p><strong>Free plan:</strong> aggregates up to 2 linked accounts. <strong>Paid plan:</strong>
aggregates all linked accounts. Paid billing, where offered, is processed through the Muse
platform's payment rails (Stripe Link); we do not store your payment credentials.</p>
<h2>3. Your responsibilities</h2>
<p>You are responsible for keeping your API credentials confidential and for the accuracy of
accounts you link. You must have the right to share any account data you connect.</p>
<h2>4. Acceptable use</h2>
<p>Do not abuse, reverse-engineer, or attempt to disrupt the service. We may suspend access
for misuse or security reasons.</p>
<h2>5. No financial advice</h2>
<p>Allocation and rebalance outputs are informational only and are not investment advice.
Consult a licensed advisor before making investment decisions.</p>
<h2>6. Availability and liability</h2>
<p>The service is provided "as is" without warranties. To the maximum extent permitted by law,
we are not liable for indirect or consequential damages. The service may be modified or
discontinued at any time.</p>
<h2>7. Contact</h2>
<p>Questions: open an issue at <a href="https://github.com/asanapal/Omniwealth">github.com/asanapal/Omniwealth</a>.</p>
<h2>8. Changes</h2>
<p>We will update this page if these terms change; the effective date above will be revised.
Continued use after changes constitutes acceptance.</p>
</body></html>`);
});

// Privacy policy (unauthenticated by design)
app.get("/privacy", (req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OmniWealth — Privacy Policy</title></head>
<body style="font-family:system-ui,sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem;line-height:1.6">
<h1>OmniWealth Privacy Policy</h1>
<p><strong>Effective date:</strong> September 19, 2026</p>
<p>OmniWealth ("we") is a portfolio aggregation connector for the Meta Muse platform.
This policy explains what data the connector handles.</p>
<h2>Data we process</h2>
<ul>
<li><strong>Portfolio data</strong> — account names, asset classes, and balances you link,
used solely to compute portfolio summaries and allocation-drift analysis you request.</li>
<li><strong>Authentication tokens</strong> — bearer tokens used to authorize API requests.
Tokens are stored in secure server environment variables and in Muse's Secure Credentials Store; they are never logged or exposed.</li>
</ul>
<h2>How we use data</h2>
<p>Data is used only to fulfill your requests (net-worth summaries, allocation breakdowns,
rebalance recommendations). We do not sell, rent, or share your personal or financial data
with third parties for marketing.</p>
<h2>Third parties</h2>
<ul><li>Hosting infrastructure (Render) processes requests on our behalf.</li>
<li>The Meta Muse platform relays your requests and stores credentials you provide in its Secure Credentials Store under Meta's own terms.</li></ul>
<h2>Data retention</h2>
<p>The connector keeps no persistent copy of your portfolio data; aggregations are computed
in memory per request. Logs contain no tokens or account identifiers.</p>
<h2>Your choices</h2>
<p>Disconnecting the connector in Muse settings immediately stops all data exchange.
You may request deletion of any data we hold by contacting us.</p>
<h2>Contact</h2>
<p>Questions: open an issue at <a href="https://github.com/asanapal/Omniwealth">github.com/asanapal/Omniwealth</a>.</p>
<h2>Changes</h2>
<p>We will update this page if the policy changes; the effective date above will be revised.</p>
</body></html>`);
});

// Service info landing (unauthenticated by design)
app.get("/", (req, res) =>
  res.json({
    service: "OmniWealth Portfolio Aggregator",
    version: "1.0.0",
    status: "ok",
    docs: "See openapi.yaml in the asanapal/Omniwealth repo",
    endpoints: ["/health", "/v1/portfolio/summary", "/v1/portfolio/drift"],
  })
);

app.listen(PORT, () => {
  console.log(`OmniWealth Connector running on port ${PORT}`);
});
