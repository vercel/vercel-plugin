# Vercel Plugin Session Context

Use Vercel guidance only when the current repo, prompt, or tool call makes it relevant.

- Prefer matched skills and official docs over memorized APIs.
- Preserve the project's selected framework, AI SDK/provider, UI, and infrastructure. Use `vercel env` and platform integrations when they belong to the requested Vercel setup; discovery alone does not authorize provisioning or migration.
- Do not push broad Vercel migrations or product recommendations unless they directly help the current task.
- The full ecosystem graph stays in `vercel.md`; runtime hooks now load only thin, topic-sized chunks on demand.
