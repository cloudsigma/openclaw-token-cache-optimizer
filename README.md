# openclaw-token-cache-optimizer

An [OpenClaw](https://openclaw.ai) provider plugin that maximises prompt-cache hit rates when using [CloudSigma TaaS](https://www.cloudsigma.com) as your LLM provider.

It injects a stable, per-conversation session ID into every outbound request so TaaS can pin your conversation to the same upstream slot (OAuth token, Bedrock region, or Claude Code node) from the very first turn — giving you consistent prompt-cache reuse instead of cold starts on every message.

The plugin is intentionally narrow: requester-side tool execution is handled by Claude Code, TaaS, and the OpenClaw gateway Direction-2 path. This plugin does **not** lease requester bridges, poll for bridge work, invoke local tools, or alter OpenAI tool payloads.

---

## The problem it solves

TaaS routes LLM requests across a pool of upstream slots. Without a session signal, it uses heuristics to guess which requests belong to the same conversation:

| Method | Confidence | Works when |
|---|---:|---|
| Tool-use ID chain | 1.0 | Tool-result follow-up turns only |
| Structural inference | 0.85 | Mid-conversation, after a few turns |
| New session fallback | 0.30 | First turn — no prior context |

That **0.30 confidence on turn 1** means the first message in every conversation is likely routed to a random slot, breaking prompt-cache continuity right from the start.

This plugin passes a stable `session_id` derived from your OpenClaw workspace so TaaS short-circuits heuristic matching and achieves **confidence 1.0 from turn 1**.

---

## How it works

OpenClaw's `wrapStreamFn` hook intercepts the outbound request payload before it is sent to TaaS. The plugin adds session affinity fields plus a small sanitized requester runtime envelope:

```json
{
  "metadata": {
    "session_id": "oc:edebc39a82a8a041",
    "sticky_key": "oc:edebc39a82a8a041",
    "requester_runtime": {
      "schema_version": "2026-06-03",
      "source": "openclaw-token-cache-optimizer",
      "session_key": "oc:edebc39a82a8a041",
      "openclaw_session_id": "oc:edebc39a82a8a041",
      "requester_host_id": "host:1a2b3c4d5e6f7890",
      "repo_name": "my-repo",
      "git_branch_hint": "dev",
      "git_dirty_hint": false,
      "provider": "cloudsigma",
      "model_id": "cloudsigma/auto",
      "session_source_hint": "source:4ae2870a2e73027c",
      "tool_execution": "direction_2_gateway",
      "metadata_classification": {
        "identifiers": "hashed",
        "repository": "name_branch_dirty_only",
        "local_paths": "omitted_by_default"
      },
      "redaction_policy": "no_secrets;no_raw_local_paths;no_env_values;no_git_remotes;no_status_or_diffs;no_extra_params"
    }
  }
}
```

- `session_id` — read by TaaS's OpenAI and Codex affinity paths.
- `sticky_key` — additionally read by the Anthropic substrate routing layer.
- `requester_runtime` — safe advisory hints for downstream routing and diagnostics.
- `X-Session-Id` — injected by `resolveTransportTurnState` for transports that support per-turn native headers.

All metadata fields are no-overwrite: if the caller already supplied `metadata.session_id`, `metadata.sticky_key`, or `metadata.requester_runtime`, the plugin leaves them intact.

### Requester runtime metadata

The runtime envelope is intentionally small and sanitized. By default it contains:

- required affinity/session fields: `session_key`, `openclaw_session_id`
- hashed identifiers: `requester_host_id`, `session_source_hint`
- bounded repo hints when available: `repo_name`, `git_branch_hint`, `git_dirty_hint`
- provider/model hints when available: `provider`, `model_id`
- explicit execution-mode marker: `tool_execution: "direction_2_gateway"`
- metadata classification and redaction policy

It does **not** include raw local paths (`workspace_dir`, `agent_dir`, `repo_root_hint`) by default. It also never includes environment variables, tokens, git remotes, full status output, diffs, or arbitrary provider `extraParams`. Git probes are bounded with a short timeout.

### Tool execution model: Direction-2

Requester-side tools are handled outside this plugin by Claude Code / TaaS / OpenClaw gateway Direction-2. Consequently this plugin:

- does not call `/internal/requester-bridges/leases`
- does not inject `requester_runtime.available_bridges`
- does not set `capture_mode: "bridge_capable"`
- does not poll `/internal/requester-bridges/poll` or post `/internal/requester-bridges/results`
- does not invoke requester-local `/tools/invoke`
- does not intercept OpenAI `tools`, `tool_calls`, or `role: "tool"` messages

### Session ID derivation

The ID is a SHA-256 hash of the session source, truncated to 16 hex chars and prefixed `oc:`. The plugin walks through a tier list to find the best available source:

| Tier | Source | Notes |
|---|---|---|
| 1 | `ctx.workspaceDir` (explicit) | Best signal — populated for main agent and many subagents |
| 2 | `globalThis[pluginRegistryState].workspaceDir` | Parent agent workspace via plugin registry |
| 3 | `process.env.OPENCLAW_SESSION_ID` | If OpenClaw sets this env var for sub-agents in future |
| 4 | `process.env.OPENCLAW_AGENT_ID` / `OPENCLAW_RUN_ID` | Any stable per-agent env var |
| 5 | `OPENCLAW_STATE_DIR` hash | Per-installation fallback — least specific |

| Property | Detail |
|---|---|
| **Stable** | Same value for every API turn within one conversation |
| **Unique** | Different workspaces / env vars → different IDs |
| **Resets on `/new`** | New conversation = new workspace = new ID |
| **Namespaced** | `oc:` prefix avoids collision with Claude Code and other TaaS clients |

### Autorouter capture

The wrapper captures TaaS `X-TaaS-*` response headers for autorouted requests and exposes the most recent route via the gateway RPC:

```text
taas.autorouter.lastRoute
```

Callers can query by `workspaceDir`, direct `sessionId`, or `agentId`. Captured values include the autorouted model, algorithm/mode, algorithm source, thinking level applied, and routed context window.

### Sub-agent behaviour

OpenClaw sub-agents run in isolated processes and may not receive a `workspaceDir` in their `wrapStreamFn` context. The tier fallback system ensures sub-agents always get a deterministic session ID:

1. **If the sub-agent has a workspace** (Tier 1) — derives a unique ID from it.
2. **If the parent agent workspace is visible** via globalThis (Tier 2) — reuses the parent's ID.
3. **If OpenClaw injects env vars** (Tiers 3–4) — uses those for a stable per-agent ID.
4. **Last resort** (Tier 5) — falls back to the state dir hash.

#### Debug logging

Set `OPENCLAW_DEBUG=1` (or `NODE_ENV=development`) to emit the session ID source on each request:

```text
[taas-affinity] wrapStreamFn sessionId=oc:edebc39a82a8a041 source=workspaceDir:/home/user/.openclaw/...
[taas-affinity] resolveTransportTurnState sessionId=oc:edebc39a82a8a041 source=workspaceDir:... turnId=abc attempt=1
```

---

## Requirements

- **OpenClaw** ≥ 2026.4.27
  - Requires the provider plugin hooks exposed via `openclaw/plugin-sdk/core`, including `wrapStreamFn`, `hookAliases`, and `resolveTransportTurnState`.
- **Node.js** 22+
- **TaaS** with session-affinity short-circuit support (commit `61a9960`+, April 2026)
- A CloudSigma account with TaaS access

Older OpenClaw builds may fail to load the plugin or may load it without applying the transport/header hook. Upgrade OpenClaw before deploying this plugin to production instances.

---

## Installation

### Option 1 - npm install

```bash
openclaw plugins install openclaw-token-cache-optimizer
openclaw gateway restart
```

The published npm package ships pre-built JavaScript in `dist/` and works on OpenClaw `2026.4.27` and later.

### Option 2 - manual install from source

```bash
git clone https://github.com/cloudsigma/openclaw-token-cache-optimizer \
  ~/.openclaw/extensions/openclaw-token-cache-optimizer
cd ~/.openclaw/extensions/openclaw-token-cache-optimizer
git checkout dev
npm ci
npm run build
openclaw gateway restart
```

`npm ci` runs the `prepare` lifecycle script, which compiles TypeScript to `dist/index.js`. Re-run `npm run build` after pulling new source changes.

No `openclaw.json` changes are required - the plugin auto-activates for all requests to the `cloudsigma` and `cloudsigma-staging` providers.

### Verify it loaded

```bash
openclaw gateway status
openclaw plugins info openclaw-taas-affinity
```

You should see `Status: loaded` and the source pointing at `dist/index.js`.

---

## Compatibility

| OpenClaw gateway | Status | Notes |
|---|---|---|
| >= 2026.5.x | Supported | Loads compiled `dist/index.js` |
| 2026.4.27 - 2026.4.x | Supported | Loads compiled `dist/index.js`; transport/header support depends on gateway hook availability |
| < 2026.4.27 | Not supported | Hooks the plugin relies on are not exposed |

---

## Verification

### Local validation

For repository/CI validation, install dev dependencies and run the test suite:

```bash
npm ci
npm test
npm run build
```

This runs:

- `npm run typecheck` — validates the TypeScript source against the OpenClaw plugin SDK and Node typings
- `npm run smoke` — imports the plugin, registers the provider hook, and verifies payload/header injection plus autorouter capture
- `npm run unit` — validates sweeper/status/auto-abort behaviour and Direction-2 regressions

Direction-2 regression coverage includes:

- requester bridge lease endpoint is not called
- `available_bridges` and bridge capture metadata are not injected
- OpenAI `tools` pass through untouched
- assistant `tool_calls` and `role: "tool"` messages are not intercepted
- existing metadata fields are not overwritten

### TaaS logs

After installing, the first turn of every new conversation should show:

```text
match_reason: "external_id_new"   ← first turn (new session in Redis)
match_reason: "external_id"       ← subsequent turns (known session)
```

Previously turn 1 would show `match_reason: "new"` with `confidence: 0.30`.

### Redis (from a TaaS pod)

```bash
redis-cli -h redis.taas.svc.cluster.local get "anth:session:oc:edebc39a82a8a041"
```

Replace the ID with your actual session ID. A non-null response confirms TaaS has bound the session to a slot.

---

## Behaviour by session type

| Session type | ID scope |
|---|---|
| Main agent | Own stable ID for the conversation lifetime |
| Spawned subagent | Own ID when a separate `workspaceDir` is present; otherwise tier fallback |
| Cron / isolated run | Own ID when an isolated workspace/env source exists |
| New conversation (`/new`, `/reset`) | New workspace → new ID |
| Parallel conversations | Each gets a separate ID when OpenClaw supplies separate workspaces/env sources |

---

## Configuration

None required for standard CloudSigma TaaS use.

Supported environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `OPENCLAW_DEBUG` | unset | Emit debug logs for session source and autorouter capture |
| `OPENCLAW_SESSION_ID` | unset | Optional session source fallback |
| `OPENCLAW_AGENT_ID` / `OPENCLAW_RUN_ID` | unset | Optional per-agent session source fallback |
| `OPENCLAW_STATE_DIR` | `~/.openclaw` | Last-resort stable source for fallback session ID |
| `TAAS_AFFINITY_SWEEP_INTERVAL_MS` | `3600000` | Background trash sweeper interval |
| `TAAS_AFFINITY_SWEEP_STALE_DAYS` | `7` | Age threshold for stale `.deleted` agent directories |
| `TAAS_AFFINITY_RUNS_STATUS_PATH` | `~/.openclaw/alien-studio/runs-status.json` | Stuck-run status JSON path |
| `TAAS_AFFINITY_AUTO_ABORT_ZOMBIES` | `false` | Opt-in zombie run auto-abort check |
| `TAAS_AFFINITY_AUTO_ABORT_DRY_RUN` | `false` | Log zombie abort candidates without aborting |

Requester bridge variables such as `TAAS_REQUESTER_BRIDGE_PLUGIN_ENABLED`, `TAAS_REQUESTER_BRIDGE_LEASE_URL`, and `TAAS_REQUESTER_BRIDGE_POLL_INTERVAL_MS` are obsolete and ignored by this plugin version.

---

## Contributing

Issues and PRs welcome. The core logic lives in [`index.ts`](./index.ts).

## License

MIT — see [LICENSE](./LICENSE).
