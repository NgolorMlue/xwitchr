# XWITCHR

A smart API key pool rotator that lets your team share one endpoint while automatically switching between multiple API keys to stay under rate limits. Supports OpenAI, Anthropic, and Google provider formats.

## How It Works

```
Your Team
   │  (1 shared endpoint + 1 proxy token)
   ▼
XWITCHR  ← picks best key → switches when near threshold
   │
   ▼
Upstream API  (NVIDIA, Google, Anthropic, OpenAI, etc.)
```

- All providers active 24/7, rotating across the full pool
- Auto-rotates at **32 req/min** per key (configurable)
- Live dashboard at `/dashboard` — real-time key health, logs, stats

---

## Quick Start (Docker)

```bash
git clone https://github.com/NgolorMlue/xwitchr.git
cd xwitchr
echo '{}' > config.json
docker compose up -d
```

Open `http://yourserver:51067/dashboard`

**Default login:** `admin` / `xwitchr@)@^`  
Change credentials anytime in the dashboard → Settings tab.

---

## Manual Setup

### 1. Install
```bash
npm install
```

### 2. Configure
```bash
cp .env.example .env
# edit .env with your values
```

### 3. Run
```bash
npm start
# dev mode with auto-reload:
npm run dev
```

Open `http://localhost:51067/dashboard`

> `.env` is only used for initial seeding on first boot. After `config.json` exists, the dashboard is the source of truth.

---

## Using the Proxy

**Before (direct API call):**
```
https://api.example.com/v1/endpoint?api_key=personal_key
```

**After (via XWITCHR):**
```
http://your-server:51067/proxy/v1/endpoint
Authorization: Bearer your-shared-proxy-token
```

XWITCHR strips your proxy token, picks an upstream key, and forwards transparently.

---

## Key Injection Modes

| Mode     | What it does                      | Example                     |
|----------|-----------------------------------|-----------------------------|
| `query`  | Adds key as URL query param       | `?api_key=KEY`              |
| `header` | Adds custom header                | `X-API-Key: KEY`            |
| `bearer` | Adds Authorization header         | `Authorization: Bearer KEY` |

---

## API Endpoints

| Endpoint         | Description                               |
|------------------|-------------------------------------------|
| `GET /dashboard` | Live monitoring UI                        |
| `GET /status`    | Full JSON status of all pools             |
| `GET /logs`      | Last 500 request log entries              |
| `ALL /proxy/*`   | Proxy to upstream (requires proxy token)  |

---

## Rotation Logic

1. Current key used until its 60-second rolling window hits threshold (default: 32)
2. Router advances to next key in pool
3. If ALL keys exhausted (hit hard cap), returns `HTTP 429` with `retryAfter: 60`
4. Keys auto-recover as 60-second windows slide

---

## Environment Variables

> Initial seeding only. Use dashboard Settings after first boot.

| Variable                  | Default   | Description                          |
|---------------------------|-----------|--------------------------------------|
| `PORT`                    | `51067`   | Server port                          |
| `PROXY_AUTH_TOKEN`        | —         | Shared secret for proxy access       |
| `DASHBOARD_USERNAME`      | `admin`   | Dashboard login username             |
| `DASHBOARD_PASSWORD`      | `xwitchr@)@^` | Dashboard login password         |
| `ROTATION_THRESHOLD`      | `32`      | Rotate key at this many req/min      |
| `MAX_REQUESTS_PER_MINUTE` | `35`      | Hard cap per key per minute          |
| `KEY_INJECT_MODE`         | `query`   | `query` / `header` / `bearer`        |
| `KEY_INJECT_PARAM`        | `api_key` | Query param name (mode=query)        |
| `KEY_INJECT_HEADER`       | `X-API-Key` | Header name (mode=header)          |

---

## Docker Notes

- `config.json` and `data/` are mounted as volumes — persist across rebuilds
- Create an empty `config.json` before first run: `echo '{}' > config.json`
- Port `51067` must be open on your server firewall
