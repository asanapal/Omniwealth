# OmniWealth Connector Brief for Meta Muse

Paste this into Meta Muse (or hand it your Muse) to connect your portfolio aggregator
as a custom connector.

---

I want you to create a custom connector for my OmniWealth portfolio API.

Base URL: https://omniwealth-connector.onrender.com
API docs: https://github.com/asanapal/Omniwealth/blob/main/openapi.yaml

Auth: every request needs `Authorization: Bearer <CONNECTOR_API_TOKEN>`.
Ask me for the token and store it in the Secure Credentials Store.

Endpoints:
- GET /health — unauthenticated liveness check, returns {"status":"ok"}
- GET /v1/portfolio/summary — total net worth, currency, per-asset-class
  allocation breakdown, plan (free|paid), accounts_included,
  accounts_excluded, upgrade_available
- GET /v1/portfolio/drift — current allocation vs targets (Equities 60%,
  Crypto 10%, Real Estate & Alternatives 30%), rebalance_needed flag, and
  buy/sell recommendations when drift exceeds 5%

Tiers: the free plan aggregates the first 2 linked accounts and returns
accounts_excluded plus upgrade_available:true; the paid plan aggregates all
accounts.

Please: build the integration, verify each endpoint against the live base URL,
and save it as a reusable skill. Confirm the free-tier net worth figure you
get back before finishing.
