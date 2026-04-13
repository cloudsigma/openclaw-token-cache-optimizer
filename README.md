# openclaw-taas-affinity

OpenClaw plugin — CloudSigma TaaS session affinity.

Injects a stable `session_id` / `sticky_key` into every outbound CloudSigma TaaS request so the affinity layer pins conversations to the same upstream model slot from turn 1, maximising prompt-cache hit rates.

## Background

[CloudSigma TaaS](https://www.cloudsigma.com) routes LLM requests across a pool of upstream slots (OAuth tokens, Bedrock regions, Claude Code nodes). Its session-affinity layer prefers to keep multi-turn conversations on the same slot so prompt caches stay hot.

Without external session context, TaaS has to infer session boundaries from tool-use-id chains and message structure — which only works reliably mid-conversation and gives confidence=0.30 on the first turn.

This plugin tells TaaS exactly which session every request belongs to, from turn 1, at confidence=1.0.

## How it works

OpenClaw's `wrapStreamFn` plugin hook intercepts the outbound request payload before it reaches TaaS. The plugin injects:

```json
{
  "metadata": {
    "session_id": "oc:a3f2c1b0e9d87654",
    "sticky_key": "oc:a3f2c1b0e9d87654"
  }
}
```

`session_id` is read by TaaS's Codex/OpenAI affinity path. `sticky_key` is additionally read by the Anthropic substrate routing layer.

### Session ID derivation

The session ID is derived from the session's `workspaceDir` — an absolute path that OpenClaw creates fresh per conversation:

- **Stable**: same value for every API turn in the same session.
- **Unique**: each session (main, subagent, cron, isolated) has its own path.
- **Resets on `/new`**: new conversation = new workspace = new session ID.
- **Namespaced**: prefixed with `oc:` to avoid collisions with other TaaS clients.

```
oc:a3f2c1b0e9d87654   ← main agent
oc:7f1d4c3a2e9b0856   ← subagent (its own workspace)
oc:2a8e5f0c1d3b7946   ← same main agent, new conversation
```

## Requirements

- **OpenClaw** ≥ 1.0.0
- **TaaS** commit `61a9960`+ (April 2026): *"feat: session affinity short-circuit via X-Session-Id header"*
- CloudSigma provider configured in `openclaw.json`

## Installation

### From ClaWHub (when published)

```bash
openclaw plugins install openclaw-taas-affinity
```

### Manual

```bash
cp -r openclaw-taas-affinity ~/.openclaw/extensions/
openclaw gateway restart
```

## Verification

After installing, check TaaS logs for:

```
match_reason: "external_id"
```

On the first turn of a conversation. Previously this would be `"new"` (confidence 0.30). With the plugin it becomes `"external_id"` (confidence 1.0) from turn 1.

You can also check Redis directly:

```bash
redis-cli get "anth:session:oc:a3f2c1b0e9d87654"
```

## Behaviour by session type

| Session type | ID scope |
|---|---|
| Main agent | Own stable ID |
| Spawned subagent | Own ID (separate workspaceDir) |
| Cron / isolated run | Own ID (isolated workspace) |
| New conversation (`/new`, `/reset`) | New ID |
| Parallel conversations | Separate IDs |

## Configuration

None required. The plugin auto-activates for all requests to the `cloudsigma` provider.

## Publishing

This plugin was built by CloudSigma for use with TaaS. We plan to publish it on [ClaWHub](https://clawhub.ai) so any OpenClaw user with a CloudSigma account can benefit from improved session affinity and cache hit rates.

## License

MIT
