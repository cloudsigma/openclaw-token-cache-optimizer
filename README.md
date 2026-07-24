# openclaw-taas-affinity

CloudSigma TaaS affinity provider hook for OpenClaw.

This plugin is intentionally narrow after the Claude Code Direction-2 lane update. It does **not** lease requester bridges, poll for bridge work, invoke requester-local tools, rewrite OpenAI tool payloads, or run OpenClaw maintenance sidecars.

## What it does

For requests routed through the `cloudsigma` or `cloudsigma-staging` provider IDs, the plugin:

- passes OpenClaw's native `ctx.sessionId` through unchanged when available
- generates a stable `oc:<sha256-prefix>` only as a deprecated compatibility fallback from `OPENCLAW_SESSION_ID`
- injects `metadata.session_id` when absent
- injects `metadata.sticky_key` when absent
- injects a sanitized `metadata.requester_runtime` envelope when absent
- injects transport header `X-Session-Id`
- injects correlation headers `X-OpenClaw-Session-Id`, `X-OpenClaw-Turn-Id`, `X-OpenClaw-Attempt`, and `X-OpenClaw-Agent-Id` (when available)
- injects `metadata.openclaw_correlation` for request/run tracing
- captures TaaS autorouter + request/trace response headers
- exposes the latest route capture via gateway method `taas.autorouter.lastRoute`

## Startup compatibility

The manifest explicitly asks OpenClaw to import the plugin at gateway startup:

```json
{
  "activation": {
    "onStartup": true,
    "onProviders": ["cloudsigma", "cloudsigma-staging"]
  }
}
```

This is required because gateway RPC handlers must be attached during gateway startup. Provider/lazy activation is not enough for `taas.autorouter.lastRoute` to be present in the live gateway dispatch table.

## Request metadata

Example injected metadata:

```json
{
  "metadata": {
    "session_id": "oc:0123456789abcdef",
    "sticky_key": "oc:0123456789abcdef",
    "requester_runtime": {
      "schema_version": "2026-06-04",
      "source": "openclaw-taas-affinity",
      "session_key": "oc:0123456789abcdef",
      "openclaw_session_id": "oc:0123456789abcdef",
      "requester_host_id": "host:1a2b3c4d5e6f7890",
      "repo_name": "example-repo",
      "git_branch_hint": "dev",
      "git_dirty_hint": false,
      "provider": "cloudsigma",
      "model_id": "cloudsigma/auto",
      "session_source_hint": "source:1a2b3c4d5e6f7890",
      "tool_execution": "direction_2_gateway",
      "metadata_classification": {
        "identifiers": "hashed",
        "repository": "name_branch_dirty_only",
        "local_paths": "omitted_by_default"
      },
      "redaction_policy": "no_secrets;no_raw_local_paths;no_env_values;no_git_remotes;no_status_or_diffs;no_extra_params"
    },
    "openclaw_correlation": {
      "schema_version": "2026-06-05",
      "source": "openclaw-taas-affinity",
      "plugin_version": "0.6.0",
      "session_id": "oc:0123456789abcdef",
      "sticky_key": "oc:0123456789abcdef",
      "session_source_hint": "source:1a2b3c4d5e6f7890",
      "agent_id": "new-agent-2",
      "provider": "cloudsigma",
      "model_id": "cloudsigma/auto"
    }
  }
}
```

All metadata fields are no-overwrite. If the caller already supplied `metadata.session_id`, `metadata.sticky_key`, or `metadata.requester_runtime`, the plugin leaves them intact.

The plugin does not include raw local paths (`workspace_dir`, `agent_dir`, `repo_root_hint`), environment variables, tokens, git remotes, full git status output, diffs, or arbitrary provider `extraParams`.

## Direction-2 tool handling

Requester-side tool execution is handled outside this plugin by the Claude Code / TaaS / OpenClaw Direction-2 path.

The plugin intentionally leaves these payload structures untouched:

- OpenAI `tools`
- `tool_choice`
- assistant `tool_calls`
- `role: "tool"` continuation messages

It also does not inject:

- `requester_runtime.available_bridges`
- `capture_mode: "bridge_capable"`
- bridge operation names such as `requester.tool.invoke`, `openclaw.tool.invoke`, `bridge.ping`, or `bridge.echo`

## Autorouter route capture

TaaS may return response headers such as:

- `X-TaaS-Autorouted: true`
- `X-TaaS-Autorouter-Model`
- `X-TaaS-Autorouter-Mode`
- `X-TaaS-Autorouter-Algorithm-Source`
- `X-TaaS-Thinking-Applied`
- `X-TaaS-Routed-Context-Window`

The plugin stores the latest bounded capture per affinity session and per derived OpenClaw agent ID.

Query latest route by agent:

```bash
openclaw gateway call taas.autorouter.lastRoute \
  --params '{"agentId":"new-agent-2"}' \
  --json
```

Query by explicit affinity session ID:

```bash
openclaw gateway call taas.autorouter.lastRoute \
  --params '{"sessionId":"oc:0123456789abcdef"}' \
  --json
```

Query by native OpenClaw session ID:

```bash
openclaw gateway call taas.autorouter.lastRoute \
  --params '{"localSessionId":"a5add102-d79b-4168-8a2a-6dd75135f73b"}' \
  --json
```

## Install / update from checkout

```bash
cd /home/cloudsigma/openclaw-taas-affinity
npm ci
npm test
npm run build
rsync -a --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'package-lock.json' \
  ./ ~/.openclaw/extensions/openclaw-taas-affinity/
cd ~/.openclaw/extensions/openclaw-taas-affinity
npm ci --omit=dev --ignore-scripts
```

Then restart the managed gateway service during a controlled window:

```bash
systemctl --user restart openclaw-gateway.service
```

Verify:

```bash
openclaw gateway status
openclaw plugins info openclaw-taas-affinity
openclaw gateway call taas.autorouter.lastRoute --params '{"agentId":"new-agent-2"}' --json
```

## Development

```bash
npm run typecheck
npm run smoke
npm run unit
npm test
npm run build
```

Current tests cover:

- manifest startup activation
- provider hook registration for `cloudsigma` and `cloudsigma-staging`
- metadata/header injection
- no-overwrite behavior
- absence of requester bridge descriptors
- OpenAI tool payload pass-through
- autorouter capture and lookup by workspace/session/agent

## Environment variables

| Variable | Default | Purpose |
|---|---:|---|
| `OPENCLAW_DEBUG` | unset | Emit debug logs for session source and autorouter capture |
| `OPENCLAW_SESSION_ID` | unset | Deprecated compatibility fallback for runtimes that do not supply native `ctx.sessionId` |
| `OPENCLAW_AGENT_ID` / `OPENCLAW_RUN_ID` | unset | Agent label used only for autorouter capture lookup; never a session-identity source |
| `OPENCLAW_STATE_DIR` | `~/.openclaw` | Used only to construct a hashed diagnostic source hint |

Requester bridge variables such as `TAAS_REQUESTER_BRIDGE_PLUGIN_ENABLED`, `TAAS_REQUESTER_BRIDGE_LEASE_URL`, and `TAAS_REQUESTER_BRIDGE_POLL_INTERVAL_MS` are obsolete and ignored by this plugin version.
