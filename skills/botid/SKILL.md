---
name: botid
description: "Protect specific routes and server actions from bots in code with Vercel BotID (`botid` npm package). Use when installing BotID, calling `initBotId()` or `checkBotId()`, mounting `<BotIdClient />`, gating signup, login, checkout or AI inference endpoints, allowing verified bots such as ChatGPT agents through, enabling Deep Analysis, or debugging a route that always reports a bot. For site-wide bot rules (Bot Protection, AI Bots, custom rules on bot name or category), use the `vercel-firewall` skill."
summary: "Vercel BotID in code: framework config, initBotId() protect list, checkBotId() in the handler, verified bots, Deep Analysis, and local testing."
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
      - 'deep analysis'
      - 'invisible captcha'
    allOf:
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
      - 'chat bot'
      - 'chatbot'
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
    - withBotId
    - Deep Analysis
    - Kasada
---

# Vercel BotID

BotID is an invisible challenge for specific routes. A client script runs in the browser and attaches challenge headers to the requests you list. On the server, `checkBotId()` turns those headers into a verdict for the current request. Users see no CAPTCHA.

It works per route, in your code. It is the right tool when the route is called by **your own frontend** and is expensive or abusable: signup, login, checkout, form posts, AI inference, server actions. It is the wrong tool for:

- **Page views and crawlable content.** Use the Bot Protection managed ruleset or custom rules (see the `vercel-firewall` skill).
- **Public APIs called by other servers, webhooks, CLIs or `curl`.** Those requests never run the client script, so `checkBotId()` reports every one of them as a bot. Use API keys, rate limits, or WAF rules instead.

There's no bot score header to read. The verdict comes from calling `checkBotId()` in the server code that handles the protected request; it sends the request's challenge headers to Vercel and returns the result. It needs the Vercel request context and an OIDC token, so it only works on Vercel deployments, not self-hosted or `next start`.

## Levels and pricing

| Level         | Plans               | Price                                       |
| ------------- | ------------------- | ------------------------------------------- |
| Basic         | All plans           | Free                                        |
| Deep Analysis | Pro                 | $1 per 1,000 Deep Analysis `checkBotId()` calls |
| Deep Analysis | Enterprise          | Custom                                      |

Basic validates the challenge response and catches less sophisticated bots. Deep Analysis is powered by Kasada and catches bots that run real browsers. Only `checkBotId()` calls are billed, not page loads. Check https://vercel.com/docs/botid#pricing before quoting prices.

## Set up

### 1. Install

```bash
npm i botid
```

### 2. Wrap the framework config

This adds the rewrites that serve the challenge script from your own domain, so ad blockers and third-party scripts can't strip it.

```ts
// next.config.ts
import { withBotId } from 'botid/next/config';

const nextConfig = {};
export default withBotId(nextConfig);
```

```ts
// nuxt.config.ts
export default defineNuxtConfig({ modules: ['botid/nuxt'] });
```

Other frameworks add the rewrites to `vercel.json`. Copy them from https://vercel.com/docs/botid/get-started rather than from memory: the paths are fixed IDs.

### 3. Declare protected routes on the client

List every route you'll call `checkBotId()` in. `path` and `method` must match the request the browser makes. `*` matches any characters, including `/` and nothing at all, so `/api/user/*` covers `/api/user/` and `/api/user/a/b`. `method: '*'` matches any method. For a server action, list the **page** it's invoked from (for example `/dashboard`) with `POST`.

```ts
// instrumentation-client.ts (Next.js 15.3+)
import { initBotId } from 'botid/client/core';

initBotId({
  protect: [
    { path: '/api/signup', method: 'POST' },
    { path: '/api/chat', method: 'POST' },
    { path: '/checkout', method: 'POST' }, // server action on /checkout
  ],
});
```

- **Next.js before 15.3:** render `<BotIdClient protect={routes} />` from `botid/client` inside `<head>` in the root layout.
- **Nuxt:** call `initBotId()` in `plugins/botid.client.ts` with `enforce: 'pre'`.
- **SvelteKit:** call `initBotId()` from `init()` in `src/hooks.client.ts`.
- **Other frameworks:** call `initBotId()` during client start-up, before the first protected request.

The request has to be made by `fetch` or XHR from a page where the script has loaded. Traditional HTML forms that post with `action` and `method` aren't supported: submit with `fetch` in an `onSubmit` handler, or use a server action ([Form submissions](https://vercel.com/docs/botid/form-submissions)).

To avoid a check on every request, run one BotID-protected request on page load and issue a short-lived signed cookie that later requests validate ([Verify visitors on page load](https://vercel.com/docs/botid/verify-on-page-load)). Only issue it when `isHuman` is true and `bypassed` is false, and keep auth, rate limits and CSRF protection in place: the cookie is a bearer credential.

### 4. Check on the server, before the expensive work

```ts
// app/api/chat/route.ts
import { checkBotId } from 'botid/server';

export async function POST(request: Request) {
  const verification = await checkBotId();
  if (verification.isBot) {
    return Response.json({ error: 'Access denied' }, { status: 403 });
  }
  // Inference, writes, payments, etc. run only after the check
}
```

```ts
'use server';
import { checkBotId } from 'botid/server';

export async function createAccount(formData: FormData) {
  const { isBot } = await checkBotId();
  if (isBot) throw new Error('Access denied');
  // ...
}
```

The result has `isBot`, `isHuman`, `isVerifiedBot`, `verifiedBotName`, `verifiedBotCategory` and `bypassed`. Put the check first in the handler so a blocked request costs nothing.

Pages Router API routes must pass headers in development: `checkBotId({ advancedOptions: { headers: req.headers } })`.

## Let verified bots through

Blocking on `isBot` alone also blocks legitimate agents, such as AI assistants browsing on a user's behalf. Verified bots (botid 1.5.0+) are identified from Vercel's [verified bots directory](https://vercel.com/docs/bot-management#verified-bots-directory):

```ts
const { isBot, isVerifiedBot, verifiedBotName } = await checkBotId();

const allowedAgent = isVerifiedBot && verifiedBotName === 'chatgpt-operator';
if (isBot && !allowedAgent) {
  return Response.json({ error: 'Access denied' }, { status: 403 });
}
```

Only allow the bots the route actually needs. For a trusted service that isn't in the directory, don't weaken the check; give it its own authenticated route or a WAF bypass rule scoped to its IPs. Traffic a WAF bypass rule lets through comes back from `checkBotId()` with `bypassed: true`.

## Deep Analysis

Deep Analysis is a project setting. It's off by default and needs Pro or Enterprise.

- **Dashboard:** Project → Firewall → Rules → enable **Vercel BotID Deep Analysis**.
- **CLI:** `vercel firewall rules update bot-id --action deep-analysis --yes` stages it, and `basic` turns it back off. Like other firewall changes it only goes live when published, so hand the publish step to the user (see the `vercel-firewall` skill). This is a billed setting, so confirm with the user before staging it.

To mix levels per route, set `advancedOptions.checkLevel` (`'deepAnalysis'` or `'basic'`, botid 1.4.5+) on **both** the client `protect` entry and the matching `checkBotId()` call. If they don't match, verification fails.

## Separate frontend and backend hosts

By default `checkBotId()` only accepts requests from the host that served the challenge. If the frontend lives on another domain, list it: `checkBotId({ advancedOptions: { extraAllowedHosts: ['app.example.com'] } })`. Only add domains you control.

## Testing

- **Locally** (`NODE_ENV=development`) the client skips the challenge and `checkBotId()` returns a human verdict. To exercise your blocking branch, pass `developmentOptions: { bypass: 'BAD-BOT' }` (or `'HUMAN'`, `'GOOD-BOT'`). Remove it or leave it; it only applies in development.
- **On a deployment**, test from the app's own UI or a `fetch` in the browser console on a page that loaded the script. `curl`, Postman, or opening the route in the address bar will be reported as a bot. That's expected, not a bug.
- **Monitor** checks on the project's Firewall traffic view by selecting BotID in the traffic filter; Observability Plus adds metrics. `vercel firewall bot-management` shows whether Deep Analysis is on, not check results.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Every request is a bot in production | Route missing from `protect`, or `path`/`method` don't match the real request. Or the caller isn't a browser running your frontend. |
| Every request is human in production | `checkBotId()` isn't called in the handler that serves the route, or its result is ignored. |
| Works locally, fails on deploy | Config wrapper (`withBotId`, Nuxt module, or `vercel.json` rewrites) missing, so the challenge script 404s. |
| `VERCEL_OIDC_TOKEN is not set` or "Must be deployed on Vercel" | Running a production build outside Vercel. `checkBotId()` only works on Vercel deployments. |
| Misconfiguration warning in logs naming a path and method | The request reached `checkBotId()` without challenge headers. Add the logged `{ path, method }` to `protect`, or it was a direct non-browser request. |
| Fails only for some routes after enabling per-route levels | `checkLevel` differs between the client entry and the server call. |
| Legitimate agent blocked | Allow it by `verifiedBotName`, or use a separate authenticated route. |

## Related

- Site-wide bot rules, the AI Bots ruleset, and custom rules on `bot_name` / `bot_category`: `vercel-firewall` skill.
- Docs: [BotID](https://vercel.com/docs/botid), [Get started](https://vercel.com/docs/botid/get-started), [Advanced configuration](https://vercel.com/docs/botid/advanced-configuration), [Verified bots](https://vercel.com/docs/botid/verified-bots), [Local development](https://vercel.com/docs/botid/local-development-behavior), [Form submissions](https://vercel.com/docs/botid/form-submissions), [Verify on page load](https://vercel.com/docs/botid/verify-on-page-load).
