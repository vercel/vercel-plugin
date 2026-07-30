---
name: access-protected-vercel-deployment
description: Access and test Vercel deployments protected by Vercel Authentication, SSO, or Deployment Protection. Use when curl, agent-browser, Playwright, or another automated request reaches a Vercel login or protection page; when a protected preview or production URL returns 401 or 403; when TRUSTED_SOURCES_ENVIRONMENT_MISMATCH appears; or when choosing between `vercel curl` and the `x-vercel-trusted-oidc-idp-token` header.
summary: Access protected Vercel URLs with vercel curl or a short-lived OIDC token
metadata:
  priority: 8
  docs:
    - "https://vercel.com/docs/cli/curl"
    - "https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/trusted-sources"
    - "https://vercel.com/docs/oidc#in-local-development"
  sitemap: "https://vercel.com/sitemap/docs.xml"
  pathPatterns: []
  bashPatterns:
    - '\b(?:vercel|vc)\s+curl\b'
    - '\b(?:curl|wget)\b[^\n]*\.vercel\.app\b'
    - '\bagent-browser\b[^\n]*(?:open|navigate|goto)[^\n]*\.vercel\.app\b'
    - '\bx-vercel-trusted-oidc-idp-token\b'
  importPatterns: []
  promptSignals:
    phrases:
      - "access protected vercel deployment"
      - "protected vercel deployment"
      - "deployment protection"
      - "vercel sso"
      - "vercel authentication page"
      - "behind vercel authentication"
      - "behind vercel sso"
      - "x-vercel-trusted-oidc-idp-token"
      - "trusted_sources_environment_mismatch"
      - "trusted sources environment mismatch"
      - "protection bypass"
    allOf:
      - [vercel, protected]
      - [vercel, sso]
      - [vercel, "403"]
      - [deployment, login]
      - [preview, protected]
      - [production, protected]
    anyOf:
      - "deployment"
      - "preview"
      - "production"
      - "curl"
      - "browser"
      - "authentication"
    noneOf:
      - "aws deployment protection"
      - "github deployment protection"
      - "kubernetes deployment protection"
    minScore: 6
retrieval:
  aliases:
    - protected Vercel deployment
    - Vercel SSO bypass
    - Vercel deployment authentication
    - Vercel Trusted Sources
  intents:
    - access a protected deployment
    - test a protected preview
    - verify a protected production deployment
    - authenticate browser automation to Vercel
  entities:
    - vercel curl
    - VERCEL_OIDC_TOKEN
    - x-vercel-trusted-oidc-idp-token
    - Trusted Sources
    - Deployment Protection
  examples:
    - preview is behind Vercel SSO
    - curl this protected Vercel deployment
    - open the protected production URL in agent-browser
---

# Access Protected Vercel Deployments

Use the caller's existing Vercel authentication. Do not disable Deployment Protection or ask for a long-lived bypass secret as the first solution.

## Choose the access path

### HTTP requests: use `vercel curl`

For response bodies, headers, health checks, and API calls, replace raw `curl` with `vercel curl` (`vc curl`). It accepts native curl options and uses Vercel authentication to access protected preview and production deployments.

```bash
vc curl https://my-app.vercel.app/api/health
vc curl my-app.vercel.app/api/users -X POST \
  -H "Content-Type: application/json" \
  -d '{"name":"Ada"}'
vc curl /api/health
```

The path-only form targets the linked project's production deployment. Pass a full URL when the exact deployment matters.

If authentication fails, check the local identity and project before changing protection settings:

```bash
vc whoami
```

Inspect `.vercel/project.json` to confirm the linked project and team. Run `vc link` only when the directory is not linked or is linked to the wrong project. Run `vc login` only when the CLI reports that no authenticated user is available.

### Browser automation: attach the development OIDC token

Browser requests must include the short-lived local token as:

```text
x-vercel-trusted-oidc-idp-token: <VERCEL_OIDC_TOKEN>
```

Use a browser tool that supports origin-scoped request headers. With `agent-browser`, inject development variables without printing or persisting the token:

```bash
vc env run -- sh -c \
  'test -n "$VERCEL_OIDC_TOKEN" && agent-browser open "$1" --headers "{\"x-vercel-trusted-oidc-idp-token\":\"$VERCEL_OIDC_TOKEN\"}"' \
  sh https://my-app.vercel.app
```

Then continue the normal browser workflow in the same session. For Playwright or another browser driver, set the same header in the browser context's extra HTTP headers before the first navigation.

If the local CLI version does not provide the token through `vc env run`, refresh local development credentials with:

```bash
vc env pull .env.local --yes
```

Load the file through the project's existing dotenv mechanism. Never print the token, paste its value into source code, or commit `.env.local`.

Use `x-vercel-trusted-oidc-idp-token` for Trusted Sources. Do not substitute `x-vercel-oidc-token`; that header carries an OIDC token into a Vercel Function and serves a different purpose.

## Trusted Sources rules

A local development token for a linked Vercel project can access that same project's deployments by default. Do not ask the user to configure Trusted Sources for the normal same-project case.

Configuration is needed when:

- the caller belongs to another Vercel project or team;
- the target project's self-access rules were customized; or
- the response is `TRUSTED_SOURCES_ENVIRONMENT_MISMATCH`.

In the target project, open **Settings → Deployment Protection → Trusted Sources**. Add or edit the caller and allow the required `from` → `to` environment pair. A local token has the `development` environment, so browser access to protected production may require `development` → `production`.

Treat this as an access-control change: explain the exact rule required and obtain authorization before changing it. Do not broaden unrelated environment pairs.

## Diagnose the response

- A Vercel login, SSO, or Deployment Protection page means the request did not use an accepted authentication path.
- `TRUSTED_SOURCES_ENVIRONMENT_MISMATCH` means the token is valid but its caller environment is not allowed to reach the target environment.
- An application-generated `401` or `403` after Vercel protection is bypassed belongs to the application's own authentication and must be debugged separately.
- A deployment marked `"target": "production"` can still be protected. Do not assume production is public.

## Avoid

- Do not disable Deployment Protection to make automation pass.
- Do not send raw unauthenticated `curl` repeatedly after receiving the protection page.
- Do not start an interactive SSO browser login when `vc curl` or an origin-scoped OIDC header can authenticate the request.
- Do not expose `VERCEL_OIDC_TOKEN` in logs, screenshots, committed files, or user-facing output.

## Related skills

- General Vercel CLI usage: `⤳ skill: vercel-cli`
- End-to-end application verification: `⤳ skill: verification`
