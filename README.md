# openclaw-taas-affinity

> [!WARNING]
> **Legacy compatibility repository. Do not use this plugin for new CloudSigma installations.**
>
> [`@cloudsigma/openclaw-taas-provider`](https://github.com/cloudsigma/openclaw-taas-provider) is the canonical CloudSigma TaaS integration. It owns the `cloudsigma` provider, model catalogue, onboarding/auth, transport, and session-affinity hooks. This repository remains temporarily supported only for optimizer-only installations that define `models.providers.cloudsigma` statically, such as the current Rufus topology.
>
> **Do not enable both plugins.** OpenClaw resolves a literal provider owner before a provider `hookAliases` match. If the first-class plugin owns `cloudsigma`, this legacy plugin may still load and observe lifecycle events, but its outbound wrapper and transport hooks do not execute. That failure mode silently removes the session metadata/headers this plugin was installed to add. This compatibility branch emits a loud startup warning when its public runtime config shows the literal `cloudsigma` plugin owner enabled; the SDK exposes no supported provider-registry inspection or conflict-rejection API, so the warning is diagnostic rather than a safe ownership override.

CloudSigma TaaS affinity provider hook for legacy OpenClaw static-provider installations.

## Supported topology matrix

| Topology | Status | Provider owner / effective hooks | Action |
|---|---|---|---|
| `@cloudsigma/openclaw-taas-provider` only | **Canonical / supported** | First-class plugin owns literal `cloudsigma`; its catalogue, auth, transport, and affinity hooks execute | Use for all new installs and migrated hosts |
| Static `models.providers.cloudsigma` + `openclaw-taas-affinity` only | **Legacy supported temporarily** | No literal plugin owner exists, so this plugin's `cloudsigma` alias hooks execute | Keep only while scheduling migration; Rufus-like topology falls here |
| Both plugins enabled | **Unsupported conflict** | Literal `cloudsigma` owner wins; this plugin's alias hooks do not execute | Migrate immediately; do not assume two plugins compose |
| Static provider only, no plugin | **Unsupported for affinity** | No plugin injects native session identity | Install the canonical provider |

## Migrate to the canonical provider

These steps intentionally keep the existing static provider catalogue in place during the first migration. Do not remove credentials or static model configuration until the canonical provider has passed canaries. **Do not migrate until the canonical package's release notes explicitly confirm native session header plus full and simple-completion payload-metadata parity.** Run the commands in one controlled change window:

1. Inspect and validate the current state:

   ```bash
   openclaw plugins inspect openclaw-taas-affinity --runtime --json
   openclaw plugins inspect cloudsigma --runtime --json
   openclaw config get models.providers.cloudsigma --json
   openclaw config validate
   ```

   `plugins inspect cloudsigma` may report that the plugin is absent on a legacy-only host; that is the expected starting state. Record how `CLOUDSIGMA_API_KEY` or the existing secret reference is supplied before changing anything.

2. Install the canonical package, then disable this legacy plugin **before restarting the gateway**:

   ```bash
   openclaw plugins install clawhub:@cloudsigma/openclaw-taas-provider
   openclaw plugins disable openclaw-taas-affinity
   openclaw plugins enable cloudsigma
   openclaw config validate
   openclaw gateway restart --safe
   ```

   The unversioned ClawHub install records the canonical package source so routine `openclaw plugins update cloudsigma` follows later supported releases. For a staged fleet rollout, use the exact parity-capable version published in that release's notes instead.

   Do not leave both enabled as a fallback. They are alternative owners, not a chain: the literal `cloudsigma` provider owner has precedence and prevents this alias hook from executing.

3. Verify plugin ownership and request continuity:

   ```bash
   openclaw gateway status
   openclaw plugins inspect cloudsigma --runtime --json
   openclaw plugins inspect openclaw-taas-affinity --json
   openclaw plugins doctor
   ```

   Confirm the canonical `cloudsigma` plugin is loaded, this legacy plugin is disabled, and there is no `LEGACY TOPOLOGY CONFLICT` diagnostic. Then run at least two turns in the same native OpenClaw conversation for each used path (GPT, Claude, AutoRouter, and simple/background completion where applicable). Verify TaaS receives the same explicit session identity on both turns and selects the same eligible upstream node; for Claude Code also verify native resume. A successful model response alone is insufficient because the ownership conflict can preserve inference while losing affinity.

### Rollback

Rollback is configuration-only. Keep the static `models.providers.cloudsigma` entry and its credential available until verification completes. If canonical-provider canaries fail:

```bash
openclaw plugins disable cloudsigma
openclaw plugins enable openclaw-taas-affinity
openclaw config validate
openclaw gateway restart --safe
openclaw gateway status
openclaw plugins inspect openclaw-taas-affinity --runtime --json
openclaw plugins doctor
```

After rollback, repeat a same-session two-turn check and query `taas.affinity.stats` if the legacy gateway method is available. Do not enable both plugins as a rollback mechanism.

This plugin is intentionally narrow after the Claude Code Direction-2 lane update. It does **not** lease requester bridges, poll for bridge work, invoke requester-local tools, rewrite OpenAI tool payloads, or run OpenClaw maintenance sidecars.

## What it does

For requests routed through the `cloudsigma` or `cloudsigma-staging` provider IDs, the plugin:

- resolves identity in strict order: invocation `options.sessionId`, wrapper `ctx.sessionId`, exact trace bridge, explicit legacy environment fallback
- records authoritative `model_call_started` session identity against the exact W3C `traceId` + `spanId` exposed through public `ctx.trace`
- resolves generic/provider calls from the matching `StreamOptions.headers.traceparent` when direct session identity is absent
- keeps the trace bridge bounded (1,024 entries), short-lived (30-minute sliding TTL), and fail-closed for malformed or ambiguous correlation
- generates a stable `oc:<sha256-prefix>` only as a deprecated compatibility fallback from `OPENCLAW_SESSION_ID`
- injects `metadata.session_id` when absent
- injects `metadata.sticky_key` when absent
- injects a sanitized `metadata.requester_runtime` envelope when absent
- injects transport header `X-Session-Id`
- injects correlation headers `X-OpenClaw-Session-Id`, `X-OpenClaw-Turn-Id`, `X-OpenClaw-Attempt`, and `X-OpenClaw-Agent-Id` (when available)
- injects `metadata.openclaw_correlation` for request/run tracing
- captures TaaS autorouter + request/trace response headers
- exposes the latest route capture via gateway method `taas.autorouter.lastRoute`
- accepts a per-session request override via `taas.autorouter.setAlgorithm`
- exposes privacy-safe bridge outcome counters via `taas.affinity.stats` (hits, misses, expiries, ambiguous traces, and direct invocation IDs); no trace or session values are returned

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

## Trace bridge compatibility

On OpenClaw versions that expose the public `model_call_started` lifecycle hook, the plugin feature-detects `api.on`, records an authoritative non-empty `ctx.sessionId` (while checking `event.sessionId` for consistency), and requires an exact valid W3C trace/span match in the later provider invocation. It never uses timing, agent ID, workspace, session key, or a process-global "current session" for correlation. Exact successful matches refresh a 30-minute sliding bridge TTL so delayed retries remain safe; TaaS retains the resulting session affinity independently for seven days.

Older OpenClaw versions without this hook continue to work when `options.sessionId`, wrapper `ctx.sessionId`, or the explicit legacy `OPENCLAW_SESSION_ID` is available. Calls without one of those strong identities remain affinity-less.

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
      "plugin_version": "0.12.0",
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

All metadata fields, including `openclaw_correlation`, are no-overwrite. If the caller already supplied `metadata.session_id`, `metadata.sticky_key`, `metadata.requester_runtime`, or `metadata.openclaw_correlation`, the plugin leaves them intact.

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

## Legacy install / update from checkout

The following procedure is retained for maintainers of a temporary optimizer-only static-provider host. New or migrated hosts must use `@cloudsigma/openclaw-taas-provider` instead.

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

- direct GPT invocation identity and strict precedence
- Kimi and generic CloudSigma trace-bridge identity
- simple-completion trace bridging
- concurrent traces, same-trace retries, and subagent isolation
- malformed, absent, expired, oversized, or ambiguous trace state failing closed
- graceful operation when the lifecycle hook is unavailable
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
