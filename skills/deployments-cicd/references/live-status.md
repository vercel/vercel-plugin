# Live Deployment Status

The Vercel MCP server exposes two tools that show deployment status as a live view. Hosts that support MCP Apps (ChatGPT, Codex) render a view that updates while the build runs; other hosts receive a text summary. Use them instead of polling `vercel inspect` when they are available.

| Tool | Use it to | Arguments |
| --- | --- | --- |
| `open_preview_deployment` | Watch the deployment for the current branch or commit | `teamId`, `projectId`, `branch`, `sha` |
| `open_deployments_dashboard` | Browse a project's recent deployments | `teamId`, `projectId`, optional `target` (`production` or `preview`) and `branch` |

- Read `teamId` (`orgId`) and `projectId` from `.vercel/project.json`.
- Get `branch` from `git rev-parse --abbrev-ref HEAD` and `sha` from `git rev-parse HEAD`.
- Call `open_preview_deployment` right after pushing a branch or running `vercel deploy`. If Vercel has not started a deployment for the commit yet, the view waits for it.
- When a build fails, the view's **Send logs to chat** button sends the build log as a message. Otherwise call `get_deployment_build_logs` with the deployment ID.
- Without `teamId` or `projectId`, the view asks the user to pick a project.
