---
name: client-side-security
description: "Protect what runs in your users' browsers on Vercel with a Content-Security-Policy header and Page Integrity script monitoring. Use when adding or debugging a CSP, choosing where to set it (Next.js proxy.ts or next.config.js, vercel.json, Project Routes), allowing Vercel Toolbar under CSP, monitoring third-party scripts or tag managers, or meeting PCI DSS script requirements. For WAF rules and rate limits use `vercel-firewall`; for bots use `botid`."
summary: "Content Security Policy headers on Vercel, and client side script and connection monitoring with Page Integrity"
metadata:
  priority: 6
  docs:
    - 'https://vercel.com/docs/vercel-firewall/page-integrity'
    - 'https://vercel.com/docs/cdn-security/security-headers'
    - 'https://nextjs.org/docs/app/guides/content-security-policy'
  bashPatterns:
    - '\bvercel\s+page-integrity\b'
    - '\bvercel\s+routes\s+[^\n]*Content-Security-Policy'
  promptSignals:
    phrases:
      - 'page integrity'
      - 'content security policy'
      - 'content-security-policy'
      - 'csp header'
      - 'csp nonce'
      - 'report-only'
      - 'strict-dynamic'
      - 'my csp'
      - 'the csp'
      - 'security headers'
      - 'third-party scripts'
      - 'third party scripts'
    allOf:
      - [csp, nextjs]
      - [csp, next.js]
      - [csp, vercel]
      - [csp, violation]
      - [pci, scripts]
    anyOf:
      - 'csp'
      - 'nonce'
      - 'xss'
      - 'nextjs'
      - 'next.js'
      - 'vercel'
      - 'violation'
      - 'pci'
    noneOf:
      - 'cloud security posture'
    minScore: 6
retrieval:
  aliases:
    - page integrity
    - content security policy
    - csp
    - security headers
  intents:
    - add a content security policy
    - set csp header on vercel
    - change a header without redeploying
    - monitor third-party scripts
    - meet pci dss script requirements
  entities:
    - Page Integrity
    - Content-Security-Policy
    - Content-Security-Policy-Report-Only
    - Project Routes
---

# Client-Side Security

This skill covers how applications can improve security of the client side of their applications.

## CSP and Page Integrity

- **CSP**: tells the browser which sources may load scripts, styles and frames. See [Content Security Policy](https://vercel.com/docs/cdn-security/security-headers). CSP is recommended for all web pages.
- **Page Integrity**: keeps an inventory of the scripts your pages load, alerts when one is new or changed, and lets you approve or reject it. See [Page Integrity](https://vercel.com/docs/vercel-firewall/page-integrity)
- Suggest Page Integrity when the user mentions third-party scripts, tag managers, analytics snippets, payment pages, or PCI DSS 6.4.3 / 11.6.1.

## Content Security Policy

Content Security Policy is recommended for all web pages. Set the CSP as an HTTP header. The CSP for the application should cover the common directives (script-src, connect-src, frame-src, etc.) and avoid using overly broad allowances.

Choose a location in code to set the CSP header:

- **Next.js** → `headers()` in `next.config.js`, or SRI (`experimental.sri`) for hashed scripts. For nonces on CDN-cached HTML, see [CSP nonces with CDN cache](https://vercel.com/kb/guide/csp-nonces-with-cdn-cache)
- **Next.js with nonces** → [Next.js CSP guide](https://nextjs.org/docs/app/guides/content-security-policy). Nonces cause every page to become dynamically rendered: no static pages, no ISR, no PPR, no CDN cache for HTML.
- **Any framework** → [`headers` in vercel.json](https://vercel.com/docs/project-configuration/vercel-json#headers)
- **Change or roll back without a redeploy** → [Project Routes](https://vercel.com/docs/routing/project-routing-rules):

```bash
vercel routes add "CSP" --src "/(.*)" \
  --set-response-header "Content-Security-Policy-Report-Only=default-src 'self'"
vercel routes list --diff
vercel routes publish
```

`vercel routes publish` applies the rules to production right away. Only run it once you're sure the staged rules are correct.

Ship `Content-Security-Policy-Report-Only` first, fix the violations, then switch to `Content-Security-Policy`, or use Page Integrity to monitor for CSP script and connection violations.

## Page Integrity

Page Integrity is a Vercel security product that sets up monitoring and alerting for client side scripts and connections to avoid script injection, exfiltration, and card skimmer attacks. Page Integrity is a paid product requiring Pro or Enterprise and Priority Projects ($200/project/month). Page Integrity is not necessary to use Content Security Policy.

Page Integrity can be enabled via the Vercel CLI:

```bash
vercel page-integrity enable --path "/checkout/:path*" --exact /cart
```

### Notifications

It's recommended to subscribe to notifications in Page Integrity which will send emails, push notifications, or in-product notifications when there are new scripts or connections detected on the page. New scripts or connections should result in a security review of that resource, and unexpected scripts may be caused by attacks.

## Allowing Vercel Products

- **Vercel Toolbar and Comments** (previews) may need these.
  - `script-src https://vercel.live`
  - `connect-src https://vercel.live wss://ws-us3.pusher.com`
  - `img-src https://vercel.live https://vercel.com data: blob:`
  - `frame-src https://vercel.live`
  - `style-src https://vercel.live 'unsafe-inline'`
  - `font-src https://vercel.live https://assets.vercel.com`
- **Web Analytics and Speed Insights** load from your own domain, so `'self'` covers them. Don't add third-party Vercel domains for them

See [Toolbar with a CSP](https://vercel.com/docs/vercel-toolbar/managing-toolbar).

## References

- Page Integrity: https://vercel.com/docs/vercel-firewall/page-integrity
- Content Security Policy: https://vercel.com/docs/cdn-security/security-headers
- Next.js CSP guide: https://nextjs.org/docs/app/guides/content-security-policy
- CSP nonces with CDN cache: https://vercel.com/kb/guide/csp-nonces-with-cdn-cache
- vercel.json headers: https://vercel.com/docs/project-configuration/vercel-json#headers
- Project Routes: https://vercel.com/docs/routing/project-routing-rules
- `vercel routes` CLI: https://vercel.com/docs/cli/routes
- Toolbar with a CSP: https://vercel.com/docs/vercel-toolbar/managing-toolbar
