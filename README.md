# OmniWealth Muse Connector

Secure multi-asset portfolio aggregator for the
[Meta Muse Connector Platform](https://muse.ai/platform).
Exposes two endpoints:

| Method | Endpoint              | Purpose                                            |
| ------ | --------------------- | -------------------------------------------------- |
| GET    | `/v1/portfolio/summary` | Total net worth + asset-class allocation breakdown |
| GET    | `/v1/portfolio/drift`   | Allocation drift vs targets + rebalance advice     |

Both require `Authorization: Bearer <CONNECTOR_API_TOKEN>`.

## Local setup

```bash
cd omniwealth-connector
cp .env.example .env
# put a real secret in CONNECTOR_API_TOKEN:
#   openssl rand -hex 32
npm install
npm start
```

Smoke test:

```bash
TOKEN=$(grep CONNECTOR_API_TOKEN .env | cut -d= -f2)
curl -s localhost:3000/health
curl -s -H "Authorization: Bearer $TOKEN" localhost:3000/v1/portfolio/summary
curl -s -H "Authorization: Bearer $TOKEN" localhost:3000/v1/portfolio/drift
curl -s localhost:3000/v1/portfolio/summary   # expect 401
```

## Freemium tiers

| Plan   | Linked accounts aggregated | Env config |
| ------ | -------------------------- | ---------- |
| Free   | First 2 (set `FREE_ACCOUNT_LIMIT`) | `PLAN=free` |
| Paid   | All accounts               | `PLAN=paid` |

The free tier aggregates only the first `FREE_ACCOUNT_LIMIT` accounts and
returns `accounts_excluded` / `upgrade_available: true` so Muse can nudge
the user toward the paid tier. Paid billing runs through the Meta Muse
Connector Platform's Stripe integration — this server just reads `PLAN`
(which the platform can set per subscriber).

## Deploy (Render)

1. Push this folder to a GitHub repo.
2. Render dashboard → **New +** → **Web Service** → connect the repo.
3. Build command: `npm install` · Start command: `npm start`.
4. Environment → add `CONNECTOR_API_TOKEN` with a generated secret.
5. Note the public URL, e.g. `https://omniwealth-connector.onrender.com`.
6. In `openapi.yaml`, update `servers[0].url` to your live URL
   (`https://omniwealth-connector.onrender.com/v1`) and redeploy.

## Deploy (Railway)

1. Push to GitHub → Railway → **New Project** → **Deploy from Repo**.
2. Variables → add `CONNECTOR_API_TOKEN`.
3. Copy the public domain Railway assigns you.
4. Update `openapi.yaml` `servers[0].url` the same way.

## Connect from Meta Muse

As of September 2026 Meta has no public submission portal for third-party
connectors. Distribution works through **custom connectors**: any Muse user
asks their Muse to connect, hands it the API docs, and Muse builds the
integration itself (Meta Help Center → "Custom connectors").

To connect: paste `CONNECTOR_BRIEF.md` into Muse, provide the
`CONNECTOR_API_TOKEN` when asked, and Muse stores it in its Secure
Credentials Store and saves the integration as a skill.

If Meta opens a connector directory submission process later, the submission
package is: the live base URL (`openapi.yaml` `servers[0].url`), the
`openapi.yaml` spec, and this README.

## Before publishing

- Replace the in-memory seed data in `loadPortfolio()` (`server.js`)
  with live brokerage/custodian API calls.
- Move target allocations into per-user config instead of the
  hardcoded `TARGET_ALLOCATION`.
- The connector currently uses seed values; never ship real-user
  portfolio data without encrypted vault storage for credentials.
