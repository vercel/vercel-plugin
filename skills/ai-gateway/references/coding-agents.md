# Coding agents through AI Gateway

Use this reference when routing a coding agent's model traffic through AI Gateway.

## Distinguish the two coding-agent workflows

| Workflow | Meaning |
| --- | --- |
| Ask a coding agent to make a Gateway request | The agent writes and runs an application or HTTP request. The agent itself can use any model or provider; the request's `provider/model` is a separate target. Use the first-request guide routed from `SKILL.md`. |
| Route a coding agent through Gateway | Configure the agent's own inference traffic, model picker, credentials, and spend tracking to use AI Gateway. Continue with this reference. |

Do not describe the target model in a one-off Gateway request as "the coding agent." Name the controlling tool separately, such as Codex or Claude Code.

## Recommended setup

One CLI command configures supported coding agents. It provisions or reuses an AI Gateway API key, detects installed agents, previews every planned config change, and asks for confirmation before writing:

```bash
vercel ai-gateway setup
```

Check `vercel ai-gateway setup --help` before documenting flags or agent support; the CLI is the source of truth for the current command shape.

Useful flags from the shipped help:

- `--agent <NAME>`: configure one agent; repeatable for a subset.
- `--all`: configure every supported agent.
- `--dry-run`: print the planned diff without writing.
- `--key <KEY>`: reuse an existing AI Gateway key instead of creating one. Do not put a literal key in a saved command or agent transcript; prefer the CLI's interactive or OS credential-store path.
- `--budget <AMOUNT>` and `--refresh-period <PERIOD>`: set a spend limit on a newly created key.
- `--expiration <PERIOD>`: expire a newly created key after a fixed period.
- `--apply prompt`: emit an agent prompt instead of writing files, for setups handled by another coding agent.

Behavior worth stating to users:

- On macOS, the key can be stored in Keychain rather than plaintext config.
- Existing Claude Desktop and Codex Desktop sessions can be copied so history survives the provider switch.
- Each agent gets the compatibility URL that matches its protocol, not a single generic one.

CLI docs: <https://vercel.com/docs/cli/ai-gateway#setup>. Coding-agents guide: <https://vercel.com/docs/ai-gateway/coding-agents>.

## When the CLI does not cover an agent

Some agents may support AI Gateway without being configurable by the CLI. Do not infer CLI coverage from provider support or a remembered agent list.

The docs keep a per-agent setup page under <https://vercel.com/docs/ai-gateway/coding-agents>. Prefer the current page over remembered config keys, and use manual configuration when the current setup command does not cover an agent.

## Manual configuration

Point the agent at the coding-agent surface unless it has a dedicated endpoint:

```text
https://ai-gateway.vercel.sh/coding-agent/v1
```

The generic coding-agent URL forwards to the same `/v1` handlers, so authentication, routing, billing, and errors are identical. A client that speaks the Anthropic protocol and appends `/v1/messages` itself should use `https://ai-gateway.vercel.sh/coding-agent` without the `/v1` suffix.

Dedicated endpoints exist for Claude Code, OpenAI Codex, and Cursor. Use each agent's page for what its endpoint adds; for example, Claude Code:

```bash
export ANTHROPIC_BASE_URL="https://ai-gateway.vercel.sh/claude-code"
export ANTHROPIC_API_KEY=""
export ANTHROPIC_AUTH_TOKEN="your-ai-gateway-api-key"
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
```

`ANTHROPIC_API_KEY` must be empty: a non-empty value is used instead of the gateway token. The discovery variable puts every gateway model in Claude Code's `/model` picker.

## Verify a setup

1. Run a trivial prompt through the agent.
2. Confirm the request appears in AI Gateway Logs with the coding-agent authentication and the expected model.
3. Check that retries, model pickers, and spend tracking work. Coding-agent sessions can generate high token counts; recommend a key budget or expiration when appropriate.

If an agent fails, inspect Logs before rewriting its config: a `401` is authentication, a `402` is credits or budget, and a `429` is a rate limit.

## Building an application that uses an agent

This reference covers routing existing coding agents. To build an agent application, read the `ai-sdk` skill and current `ToolLoopAgent` docs, or the eve and build-agents skills for a durable agent project. Do not conflate "route my coding agent" with "build my own agent."
