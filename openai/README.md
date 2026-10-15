# vercel

This package is generated from [vercel/vercel-plugin](https://github.com/vercel/vercel-plugin) version `{{version}}` for the OpenAI plugin directory.

## What is included

- `skills/`: {{skills}} current skills, including their reference files and Codex display metadata
- `.mcp.json`: the Vercel MCP server at `https://mcp.vercel.com`
- `vercel.md`: the Vercel ecosystem reference graph
- `agents/` and `commands/`: upstream workflow reference content
- Plugin icons and assets

## OpenAI packaging

The package version is `{{version}}`, matching the upstream source version.

The package uses `.codex-plugin/plugin.json` with the local plugin id `vercel`. Skills are discovered from their `SKILL.md` name, description, and retrieval metadata. The upstream hook runtime is not included.

The runtime skills and supporting references follow upstream, with OpenAI packaging and safety guidance retained. Source-only `overlay.yaml` files and `upstream/` copies are excluded so each skill has one discoverable definition. Unsupported framework skills are excluded by the OpenAI build.

The Eve skill uses installed documentation when available and public documentation otherwise. Installing dependencies or scaffolding an Eve project must be part of the user's requested setup.

Deployment examples keep CI credentials away from untrusted PR code and scope protected browser-test authentication to the verified deployment origin. Next.js framework guidance comes from version-matched Next.js documentation and the official Next.js workflow skills instead of bundled Next.js skills.

The Vercel connection is declared as an MCP server rather than an app reference. Connect and authenticate with Vercel through the host's MCP setup before using its tools. MCP supports both reads and writes within your granted permissions. Use `list_deployment_events` for build output. Digital subscriptions, credits, and add-on purchases are unavailable through MCP; domain registration requires a quote and explicit approval.

## Usage

After installing the plugin, invoke a skill such as `ai-sdk`, `build-agents`, or `deployments-cicd`, or describe the task so the host can choose the relevant skill. The `agents/` and `commands/` files preserve upstream workflows as reference material; they do not register separate Codex agents or slash commands.

## Package layout

```text
vercel/
├── .codex-plugin/plugin.json
├── .mcp.json
├── skills/
├── vercel.md
├── agents/
├── commands/
└── assets/
```

Run `bun run build:openai` in the source repository to generate this package and its submission ZIP. The build includes dotfiles and omits hooks, app manifests, authoring files, and unsupported skills.

## Reporting issues

Report content and OpenAI packaging issues in [vercel/vercel-plugin](https://github.com/vercel/vercel-plugin/issues).
