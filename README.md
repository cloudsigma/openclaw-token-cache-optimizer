# openclaw-token-cache-optimizer

An [OpenClaw](https://openclaw.ai) plugin that maximises prompt-cache hit rates when using [CloudSigma TaaS](https://www.cloudsigma.com) as your LLM provider.

It injects a stable, per-conversation session ID into every outbound request so TaaS can pin your conversation to the same upstream slot (OAuth token, Bedrock region, or Claude Code node) from the very first turn — giving you consistent prompt-cache reuse instead of cold starts on every message.

---

## The problem it solves

TaaS routes LLM requests across a pool of upstream slots. Without a session signal, it uses heuristics to guess which requests belong to the same conversation:

| Method | Confidence | Works when |
|---|---|---|
| Tool-use ID chain | 1.0 | Tool-result follow-up turns only |
| Structural inference | 0.85 | Mid-conversation, after a few turns |
| New session fallback | 0.30 | First turn — no prior context |

That **0.30 confidence on turn 1** means the first message in every conversation is likely routed to a random slot, breaking prompt-cache continuity right from the start.

This plugin passes a stable `session_id` derived from your OpenClaw workspace so TaaS short-circuits heuristic matching and achieves **confidence 1.0 from turn 1**.

---

## How it works

OpenClaw's `wrapStreamFn` hook intercepts the outbound request payload before it is sent to TaaS. The plugin adds two fields:

```json
{
  "metadata": {
    "session_id": "oc:edebc39a82a8a041",
    "sticky_key": "oc:edebc39a82a8a041"
  }
}
```

- `session_id` — read by TaaS's OpenAI and Codex affinity paths
- `sticky_key` — additionally read by the Anthropic substrate routing layer

Both fields point to the same value. No headers are modified.

### Session ID derivation

The ID is a SHA-256 hash of the session's `workspaceDir`, truncated to 16 hex chars and prefixed `oc:`:

| Property | Detail |
|---|---|
| **Stable** | Same value for every API turn within one conversation |
| **Unique** | Each session (main agent, subagent, cron, isolated) has its own workspace → its own ID |
| **Resets on `/new`** | New conversation = new workspace = new ID |
| **Namespaced** | `oc:` prefix avoids collision with Claude Code and other TaaS clients |

Example IDs:
```
oc:edebc39a82a8a041   ← main agent session
oc:4ae2870a2e73027c   ← subagent spawned from the above
oc:a1b2c3d4e5f60718   ← same agent, next conversation
```

---

## Requirements

- **OpenClaw** ≥ 1.0.0
- **TaaS** with session-affinity short-circuit support (commit `61a9960`+, April 2026)
- A CloudSigma account with TaaS access

---

## Installation

### Option 1 — ClaWHub (coming soon)

```bash
openclaw plugins install openclaw-token-cache-optimizer
openclaw gateway restart
```

### Option 2 — Manual

```bash
# Clone into your OpenClaw extensions directory
git clone https://github.com/cloudsigma/openclaw-token-cache-optimizer \
  ~/.openclaw/extensions/openclaw-token-cache-optimizer

# Restart the gateway to load the plugin
openclaw gateway restart
```

That's it. No `openclaw.json` changes are required — the plugin auto-activates for all requests to the `cloudsigma` provider.

### Verify it loaded

```bash
openclaw gateway status
```

You should see the plugin listed in the startup log:

```
[plugins] openclaw-token-cache-optimizer: loaded
```

---

## Verification

### TaaS logs

After installing, the first turn of every new conversation should show:

```
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
| Spawned subagent | Own ID (separate `workspaceDir`) |
| Cron / isolated run | Own ID (isolated workspace per run) |
| New conversation (`/new`, `/reset`) | New workspace → new ID |
| Parallel conversations | Each gets a separate ID |

---

## Configuration

None required. The plugin works out of the box with zero configuration.

---

## Contributing

Issues and PRs welcome. The core logic lives in [`index.ts`](./index.ts).

## License

MIT — see [LICENSE](./LICENSE).
