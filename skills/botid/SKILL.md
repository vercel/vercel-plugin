---
name: botid
description: "Protect specific routes and server actions from bots in code with Vercel BotID (`botid` npm package). Use when installing BotID, calling `initBotId()` or `checkBotId()`, mounting `<BotIdClient />`, gating signup, login, checkout or AI inference endpoints, allowing verified bots such as ChatGPT agents through, enabling Deep Analysis, or debugging a route that always reports a bot. For site-wide bot rules (Bot Protection, AI Bots, custom rules on bot name or category), use the `vercel-firewall` skill."
summary: "Vercel BotID in code: initBotId() protect list, checkBotId() in the handler, verified bots, Deep Analysis, and local testing."
metadata:
  priority: 6
  docs:
    - 'https://vercel.com/docs/botid'
    - 'https://vercel.com/docs/botid/get-started'
  importPatterns:
    - 'botid'
    - 'botid/*'
  bashPatterns:
    - '\bnpm\s+(install|i|add)\s+[^\n]*(?<![\w@/-])botid(?![\w/-])'
    - '\bpnpm\s+(install|i|add)\s+[^\n]*(?<![\w@/-])botid(?![\w/-])'
    - '\bbun\s+(install|i|add)\s+[^\n]*(?<![\w@/-])botid(?![\w/-])'
    - '\byarn\s+add\s+[^\n]*(?<![\w@/-])botid(?![\w/-])'
  promptSignals:
    phrases:
      - 'botid'
      - 'bot id'
      - 'checkbotid'
      - 'initbotid'
      - 'botidclient'
      - 'invisible captcha'
    allOf:
      - ['deep analysis', bot]
      - [captcha, login]
      - [captcha, signup]
      - [captcha, form]
      - [bot, signup]
      - [bot, checkout]
      - [bot, login]
      - [bot, 'server action']
      - [bot, endpoint]
      - [bots, endpoint]
      - [captcha, vercel]
    anyOf:
      - 'bot'
      - 'bots'
      - 'captcha'
    noneOf:
      - 'slack bot'
      - 'discord bot'
      - 'telegram bot'
    minScore: 6
retrieval:
  aliases:
    - botid
    - vercel botid
    - invisible captcha
    - bot detection sdk
  intents:
    - protect an api route from bots
    - stop bots on signup or checkout
    - protect ai endpoint from bots
    - allow verified bots through botid
    - enable deep analysis
  entities:
    - BotID
    - checkBotId
    - initBotId
    - BotIdClient
    - Deep Analysis
    - Kasada
---


# Vercel BotID

You are an expert in Vercel BotID — invisible, per-route bot protection added in code.

## What It Is

- **Client**: a script attaches challenge headers to the requests you list in `protect`
- **Server**: `checkBotId()` sends those headers to Vercel and returns a verdict for the current request
- **No CAPTCHA**, no score header to read in proxy or middleware
- **Vercel only**: needs the request context and an OIDC token, so it fails self-hosted or under `next start`
- **Levels**: Basic (free, all plans) and Deep Analysis (Kasada, Pro $1 per 1,000 `checkBotId()` calls, Enterprise custom). Only `checkBotId()` calls are billed

## Setup

```bash
npm i botid
```

No config wrapper or rewrites needed: Vercel routes BotID requests automatically. Remove any old `withBotId`, `botid/nuxt` or BotID `vercel.json` rewrites.

### Client: declare protected routes

```ts
// instrumentation-client.ts (Next.js 15.3+)
import { initBotId } from 'botid/client/core';

initBotId({
  protect: [
    { path: '/api/signup', method: 'POST' },
    { path: '/api/user/*', method: 'POST' },
    { path: '/checkout', method: 'POST' }, // server action invoked from /checkout
  ],
});
```

- `*` matches any characters, including `/` and nothing; `method: '*'` matches any method
- Next.js < 15.3: `<BotIdClient protect={routes} />` from `botid/client` in the root layout `<head>`
- Nuxt: `plugins/botid.client.ts` with `enforce: 'pre'`. SvelteKit: `init()` in `src/hooks.client.ts`
- Requests must use `fetch` or XHR. Traditional `<form action method>` posts aren't supported; use `onSubmit` + `fetch` or a server action

### Server: check before the expensive work

```ts
import { checkBotId } from 'botid/server';

export async function POST(request: Request) {
  const { isBot } = await checkBotId();
  if (isBot) return Response.json({ error: 'Access denied' }, { status: 403 });
  // inference, writes, payments
}
```

Same call at the top of a server action. Result fields: `isBot`, `isHuman`, `isVerifiedBot`, `verifiedBotName`, `verifiedBotCategory`, `bypassed`. Pages Router in development: pass `advancedOptions: { headers: req.headers }`.

## Verified Bots

Allow specific agents (botid 1.5.0+) from the [verified bots directory](https://vercel.com/docs/bot-management#verified-bots-directory):

```ts
const { isBot, isVerifiedBot, verifiedBotName } = await checkBotId();
if (isBot && !(isVerifiedBot && verifiedBotName === 'chatgpt-operator')) {
  return Response.json({ error: 'Access denied' }, { status: 403 });
}
```

For a trusted service not in the directory, use a separate authenticated route or a WAF bypass rule scoped to its IPs. Bypassed traffic returns `bypassed: true`.

## Advanced Options

- **Deep Analysis**: dashboard Firewall → Rules → **Vercel BotID Deep Analysis**, or `vercel firewall rules update bot-id --action deep-analysis` (staged; `basic` reverts). Billed, so confirm with the user and let them publish
- **Per-route level**: `advancedOptions.checkLevel: 'deepAnalysis' | 'basic'` (1.4.5+) on **both** the `protect` entry and `checkBotId()`; a mismatch fails verification
- **Separate frontend host**: `checkBotId({ advancedOptions: { extraAllowedHosts: ['app.example.com'] } })`
- **Check once per visit**: [verify on page load](https://vercel.com/docs/botid/verify-on-page-load) and issue a signed cookie only when `isHuman && !bypassed`. It's a bearer credential; keep auth, rate limits and CSRF protection

## Testing

- **Local** (`NODE_ENV=development`): returns human. Force a verdict with `checkBotId({ developmentOptions: { bypass: 'BAD-BOT' } })` (or `'HUMAN'`, `'GOOD-BOT'`)
- **Deployed**: test from the app UI or a `fetch` on a page that loaded the script. `curl`, Postman and the address bar are reported as bots, as expected
- **Monitor**: Firewall traffic view, filtered to BotID; Observability Plus adds metrics

## Common Pitfalls

- **Always a bot**: route missing from `protect`, `path`/`method` mismatch, or a non-browser caller. The logged misconfiguration warning names the `{ path, method }` to add
- **Always human**: `checkBotId()` not called in the handler, or its result ignored
- **`VERCEL_OIDC_TOKEN is not set`**: running outside Vercel

## When to Use

- Signup, login, checkout, form posts and server actions called by your own frontend
- AI inference and other expensive endpoints

## When NOT to Use

- Site-wide page and crawler traffic → Bot Protection or AI Bots managed rules (`vercel-firewall` skill)
- Public APIs called by servers, webhooks or CLIs → API keys, rate limits or WAF rules
- Targeting a bot by name or category → custom rules (`vercel-firewall` skill)

## References

- 📖 docs: https://vercel.com/docs/botid
- 📖 get started: https://vercel.com/docs/botid/get-started
- 📖 advanced configuration: https://vercel.com/docs/botid/advanced-configuration
- 📖 verified bots: https://vercel.com/docs/botid/verified-bots
- 📖 form submissions: https://vercel.com/docs/botid/form-submissions
- 📖 verify on page load: https://vercel.com/docs/botid/verify-on-page-load
