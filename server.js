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
function summarizePortfolio() {
  const { currency, accounts } = loadPortfolio();

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
app.get("/v1/portfolio/summary", verifyToken, (req, res) => {
  try {
    const {
      total_net_worth,
      currency,
      allocations,
      plan,
      accounts_included,
      accounts_excluded,
      upgrade_available,
    } = summarizePortfolio();
    res.json({
      total_net_worth,
      currency,
      allocations,
      plan,
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
app.get("/v1/portfolio/drift", verifyToken, (req, res) => {
  try {
    const { total_net_worth, byClass, total, plan } = summarizePortfolio();

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
