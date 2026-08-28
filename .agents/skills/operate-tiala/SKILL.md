---
name: operate-tiala
description: Operate the TIALA (Mac mini M4) host remotely via the OpenClaw Gateway. Use for checking service status, taking screenshots, running allowlisted commands, controlling the GUI, and delegating tasks to the OpenClaw agent. Always require --confirm for destructive or GUI actions.
---

# Operate TIALA

TIALA is a Mac mini M4 host running local services (Ollama, OpenD, moomoo-bridge,
OpenClaw Gateway). Devin can operate it through `magi-moni`'s OpenClaw client.

## Prerequisites

- `magi-moni` repo is cloned and `npm install` has run.
- `GCP_SERVICE_ACCOUNT_KEY` and `OPENCLAW_GATEWAY_TOKEN` are available.
- The OpenClaw Gateway URL is discoverable from BigQuery `magi_core.service_endpoints`
  (`service = 'openclaw'`) or set explicitly in `OPENCLAW_URL`. The current value is
  `https://openclaw.khaos.company` (Cloudflare Named Tunnel).
- If the `openclaw` URL is a stale `*.trycloudflare.com` quick tunnel, TIALA needs a
  Cloudflare Named Tunnel. On TIALA, run:

```bash
cd ~/magi-moomoo
bash scripts/setup-openclaw-named-tunnel.sh openclaw.khaos.company
bash scripts/start-openclaw-named-tunnel.sh
# or install as LaunchAgent:
bash scripts/install-openclaw-launchagent.sh openclaw.khaos.company
```

## Quick CLI

`magi-moni/scripts/operate-tiala.js` wraps all TIALA operations. Use it when the
user asks anything about TIALA status, screenshots, commands, or GUI actions.

```bash
cd ~/repos/magi-moni

# Check services and system info
node scripts/operate-tiala.js services
node scripts/operate-tiala.js system

# Capture the TIALA screen
node scripts/operate-tiala.js screenshot /tmp/tiala.jpg

# Restart an auto-restartable service
node scripts/operate-tiala.js restart ollama --confirm

# Execute an allowlisted command
node scripts/operate-tiala.js exec --command="ollama list" --confirm

# GUI actions (coordinates must be obtained from a screenshot first)
node scripts/operate-tiala.js action --action=click --coordinate=100,200 --confirm
node scripts/operate-tiala.js action --action=type --text="hello" --confirm
node scripts/operate-tiala.js action --action=hotkey --keys=cmd,space --confirm
node scripts/operate-tiala.js action --action=scroll --coordinate=500,300 --direction=down --amount=10 --confirm

# Delegate a task to the OpenClaw agent
node scripts/operate-tiala.js agent "Safariを開いてdogma.jpを表示して" --confirm
```

## HTTP 401 Unauthorized

The gateway token rotates on TIALA and the copy stored on the Devin side goes stale.
The **source of truth is GCP Secret Manager**, not the injected environment variable:

```bash
gcloud auth activate-service-account --key-file=/home/ubuntu/gcp-key.json --project=screen-share-459802
export OPENCLAW_GATEWAY_TOKEN=$(gcloud secrets versions access latest \
  --secret=OPENCLAW_GATEWAY_TOKEN --project=screen-share-459802)
node scripts/operate-tiala.js services
```

Diagnosis order:

1. `curl -s https://openclaw.khaos.company/health` → `{"ok":true,"status":"live"}` means the
   host and tunnel are fine and the problem is purely the token.
2. A request that authenticates but hits a tool missing from the HTTP catalog returns
   `404`, not `401` — a 404 already proves the token is good.
3. If `/health` itself fails, the tunnel is down; see the Named Tunnel commands above.

After recovering a token, suggest saving it back as the org-scoped
`OPENCLAW_GATEWAY_TOKEN` secret so later sessions do not repeat this.

## Reaching TIALA without the gateway

TIALA is on the dogmaai tailnet as `aka` / `aka.aegean-boa.ts.net` / `100.114.185.1`.
Joining the tailnet is useful to prove the host is up when the gateway is unusable:

```bash
sudo tailscale up --authkey="$TAILSCALE_KEY" --hostname=devin-tiala --accept-routes
ping -c2 100.114.185.1
curl -s http://100.114.185.1:11436/health   # moomoo bridge answers over Tailscale
```

Notes:

- Multiple Tailscale auth-key secrets exist and most are expired — try each until
  `tailscale status` lists `aka`.
- The gateway port `18789` accepts TCP over Tailscale but never answers HTTP; go through
  the `openclaw.khaos.company` tunnel instead.
- `sshd` on port 22 is up but rejects Devin (publickey only) and Tailscale SSH is not
  enabled, so there is no shell fallback — the gateway is the only way in.

## Safety

- `services` and `system` are read-only and safe.
- `screenshot` is read-only but can expose screen contents; do not share with
  untrusted parties.
- `restart`, `exec`, `action`, and `agent` require `--confirm`.
- The CLI exits with code `2` and prints a `confirmation_required` payload when
  `--confirm` is missing. Re-run the same command with `--confirm` after the
  user agrees.
- `tiala_restart` blocks manual-restart services (`opend`, `openclaw`, `ttyd`,
  `netdata`) and returns an error; do not attempt to restart those automatically.

## Environment Variables

| Variable | Purpose |
|---|---|
| `GCP_SERVICE_ACCOUNT_KEY` | JSON service-account key for BigQuery discovery |
| `GOOGLE_APPLICATION_CREDENTIALS` | Optional path to an existing key file |
| `OPENCLAW_URL` | Optional override of the BigQuery-discovered gateway URL |
| `OPENCLAW_GATEWAY_TOKEN` | Bearer token for public/tunnel gateway URLs |
| `OPENCLAW_SERVICE_NAME` | BigQuery service name (default: `openclaw`) |

## Fallback: Direct Node

If the CLI is unavailable, call `executeAka1Tool` directly:

```bash
cd ~/repos/magi-moni
node -e "
const { executeAka1Tool } = require('./lib/tools');
executeAka1Tool('tiala_services', {})
  .then(r => console.log(JSON.stringify(r, null, 2)))
  .catch(e => { console.error(e.message); process.exit(1); });
"
```
