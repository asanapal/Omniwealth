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

app.listen(PORT, () => {
  console.log(`OmniWealth Connector running on port ${PORT}`);
});
