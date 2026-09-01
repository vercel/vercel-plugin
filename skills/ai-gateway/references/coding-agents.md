# Coding agents through AI Gateway

Use this reference when routing a coding agent's model traffic through AI Gateway.

## Recommended setup

One CLI command configures supported coding agents. It provisions or reuses an AI Gateway API key, detects installed agents, previews every planned config change, and asks for confirmation before writing:

```bash
vercel ai-gateway coding-agents setup
```

The current CLI configures Claude Code, OpenAI Codex, OpenCode, and Pi. Check `vercel ai-gateway coding-agents setup --help` before documenting flags or agent support; the CLI is the source of truth for the current list.

Useful flags from the shipped help:

- `--agent <NAME>`: configure one agent; repeatable for a subset.
- `--all`: configure every supported agent.
- `--dry-run`: print the planned diff without writing.
- `--key <KEY>`: reuse an existing AI Gateway key instead of creating one.
- `--budget <AMOUNT>` and `--refresh-period <PERIOD>`: set a spend limit on a newly created key.
- `--expiration <PERIOD>`: expire a newly created key after a fixed period.
- `--apply prompt`: emit an agent prompt instead of writing files, for setups handled by another coding agent.

Behavior worth stating to users:

- On macOS, the key can be stored in Keychain rather than plaintext config.
- Existing Claude Desktop and Codex Desktop sessions can be copied so history survives the provider switch.
- Each agent gets the compatibility URL that matches its protocol, not a single generic one.

CLI docs: <https://vercel.com/docs/cli/ai-gateway#setup>. Coding-agents guide: <https://vercel.com/docs/ai-gateway/coding-agents>.

## When the CLI does not cover an agent

Some agents the CLI does not configure, such as Cline and omp, ship a first-party AI Gateway provider and only need the key. Everything else takes manual configuration. Do not promise CLI support for an agent not in the current `--help` output.

The docs keep a per-agent setup page for each supported agent under <https://vercel.com/docs/ai-gateway/coding-agents>, including agents the CLI does not configure. Prefer the current page over remembered config keys.

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
