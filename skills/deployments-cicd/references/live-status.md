# Live Deployment Status

The Vercel MCP server's `open_deployments` tool shows deployments as a live card. Hosts that support MCP Apps (ChatGPT, Codex) render a card that updates while the build runs; other hosts receive a text summary. Use it instead of polling `vercel inspect` when it's available.

| The user wants | Call `open_deployments` with |
| --- | --- |
| The build or preview for the current branch or commit | `view: "preview"`, `branch`, `sha` |
| A project's recent deployments | `view: "dashboard"`, `projectId`, optionally `target` (`production` or `preview`) or `branch` |

- Read `projectId` and `teamId` (`orgId`) from `.vercel/project.json`. Without that file, pass `repo` (`git remote get-url origin`) for a preview: the tool finds the linked project, even before the deployment exists. A project name also works as `projectId`.
- Get `branch` from `git rev-parse --abbrev-ref HEAD` and `sha` from `git rev-parse HEAD`.
- Call it right after pushing a branch or running `vercel deploy`. Calling again updates the same card, so call it once: it updates by itself until the build finishes.
- A repository linked to several Vercel projects shows a project chooser in the card.
- When a build fails, the card's **Send Logs to Chat** button asks the agent to investigate. Call `get_deployment_build_logs` with the deployment ID, and if that is not enough, use `get_deployment`, `get_runtime_logs`, or reproduce the build locally.
