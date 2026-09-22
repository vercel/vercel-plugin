---
name: domains
description: Search, register, connect, transfer, and renew domain names on Vercel using the CLI or Domains Registrar API. Use for domain availability and pricing, custom domains, DNS records, nameservers, ownership verification, and domain orders.
summary: Search domains without authentication; manage registration, project assignment, DNS, transfers, and renewals with Vercel CLI or API.
metadata:
  priority: 7
  docs:
    - "https://vercel.com/docs/domains/registrar-api"
    - "https://vercel.com/docs/cli/domains"
    - "https://vercel.com/docs/cli/dns"
    - "https://openapi.vercel.sh"
  sitemap: "https://vercel.com/sitemap.xml"
  pathPatterns: []
  bashPatterns:
    - '\b(?:vercel|vc)\s+(?:domains?|dns)\b'
    - 'https://api\.vercel\.com/v1/registrar/'
  importPatterns: []
  promptSignals:
    phrases:
      - "domain name"
      - "domain search"
      - "domain availability"
      - "domain pricing"
      - "buy a domain"
      - "register a domain"
      - "transfer a domain"
      - "renew a domain"
      - "renew my domain"
      - "custom domain"
      - "dns record"
      - "nameserver"
      - "registrar api"
      - "vercel domains"
      - "vercel dns"
    allOf:
      - [domain, vercel]
      - [domain, register]
      - [domain, renew]
      - [domain, transfer]
    anyOf:
      - "availability"
      - "pricing"
      - "dns"
      - "registrar"
    minScore: 6
---

# Domains

Use the public Registrar API for unauthenticated discovery. Use the installed Vercel CLI for account and project operations, or the REST API for structured automation. `vc` and `vercel` are equivalent.

Registration, Vercel team ownership, project assignment, and authoritative DNS are separate. Connecting an already-owned domain does not require buying it or transferring its registration.

## Search before asking for credentials

Start exact-name research with one request returning availability and pricing together:

```bash
curl --fail-with-body --silent --show-error \
  https://api.vercel.com/v1/registrar/domains/search \
  --header 'Content-Type: application/json' \
  --data '{"domains":["example.com","example.dev","example.app"]}'
```

Send 1–200 exact domain names per request. The endpoint checks the supplied names; it does not generate suggestions. Generate candidates from the user's naming constraints, then batch them. No Vercel account, token, or project link is needed.

Results preserve input order. Available entries include `domain`, `available`, `years`, `price`, `renewalPrice`, and `premium`; prices are USD for the returned term. Report registration and renewal costs with that term, and flag premium domains. `available: false` means unavailable **or availability could not be confirmed**; it does not prove someone owns the name. Missing prices are unknown, not zero. Availability and quotes can change before purchase.

For keyword/TLD discovery, a recent CLI can generate candidates:

```bash
vercel domains search acme --tld com --tld dev --available --format=json
vercel domains check example.com example.dev --format=json
vercel domains price example.com --format=json
```

Check `vercel domains --help` and the selected subcommand's `--help` against the installed version. If discovery is unavailable or the CLI asks for login, use the public endpoint directly. CLI `search` accepts a keyword; API `search` accepts exact names. Do not substitute one input shape for the other.

## Connect and diagnose an existing domain

For authenticated work, inspect `vercel whoami` and use `--scope <team>` when selecting a team. Resolve the intended project before changing its domains.

```bash
vercel domains ls --scope my-team
vercel domains inspect example.com --scope my-team
vercel domains add example.com my-project --scope my-team
vercel domains verify example.com --project my-project --format=json --scope my-team
```

Use the actual expected DNS records and ownership-verification values returned for that domain and project. Do not hardcode a universal A record or CNAME target. Configure records at the authoritative DNS provider; `vercel dns` changes Vercel DNS only. Preserve unrelated records, especially MX and email-verification TXT records. Nameserver changes require carrying over the zone's required records.

| Task | CLI |
| --- | --- |
| List DNS records | `vercel dns ls example.com` |
| Inspect a record | `vercel dns inspect <record-id> --format=json` |
| Add the required TXT record | `vercel dns add example.com <record-name> TXT <record-value>` |
| Update an existing record | `vercel dns update <record-id> --value <record-value>` |
| Remove a specific record | `vercel dns rm <record-id>` |
| Move team ownership | `vercel domains move example.com <destination-team>` |
| Remove team ownership | `vercel domains rm example.com` |

After a change, rerun `domains verify` and check DNS propagation and HTTPS. Verification can exit nonzero while returning useful JSON describing the mismatch. An accepted DNS write is not proof that DNS has propagated or a certificate is ready. `domains add --force` can detach the domain from another project; use it only when that reassignment is intended. Removing team ownership is not a registrar transfer or cancellation of registration.

## Purchase, transfer, and renew

Use existing authorization for the exact domain, term, price, and renewal preference. If those choices are unresolved, prepare the current quote before asking. Do not treat a discovery request as permission to purchase. Use real user-provided registrant information and keep tokens, contact data, and transfer codes out of logs and committed files.

| Task | CLI |
| --- | --- |
| Register a domain | `vercel domains buy example.com` |
| Transfer from another registrar | `vercel domains transfer-in example.com` |
| Renew registration | `vercel domains renew example.com` |
| Enable or disable automatic renewal | `vercel domains auto-renew example.com on` / `off` |

Purchase, transfer, and renewal flows may require interactive input. JSON output does not bypass renewal's charge confirmation. For an authorized noninteractive operation, use the Registrar API with the required payload instead of inventing CLI flags. Moving between Vercel teams uses `domains move`, not `transfer-in`.

## Registrar API

Base URL: `https://api.vercel.com`. Consult the [live OpenAPI schema](https://openapi.vercel.sh) for the selected operation's request and response fields before constructing a mutation.

### Public discovery

Use the [Registrar API reference](https://vercel.com/docs/domains/registrar-api) for public TLD metadata, term-specific domain prices, availability, and contact requirements. These operations require no authentication. Bulk availability and price calls accept 1–50 domains; search accepts 1–200.

TLD base prices do not quote premium domains. Use domain-specific prices for the requested term; price endpoints return `purchasePrice`, unlike search's `price`. Some price fields can be strings rather than numeric quotes; do not submit those as `expectedPrice`.

### Authenticated operations

Send `Authorization: Bearer <token>` and use `?teamId=<team-id>` for the intended team. Use `Content-Type: application/json` for JSON bodies. Reuse a securely available token; do not ask for one for public discovery.

Use the selected operation in the live schema for purchases, transfers, renewals, automatic renewal, nameservers, and contact verification. Inspect asynchronous results with `GET /v1/registrar/orders/{orderId}`. An empty nameservers array selects Vercel defaults; contact verification is unavailable for the first 30 minutes after purchase.

For purchases, retrieve the contact schema and supply required TLD-specific values through the purchase payload's `contactInformation.additional` field. For transfers, use only contact fields accepted by that operation's live schema; it does not accept the purchase-only `additional` field. Punycode purchases require a supported `languageCode`; inspect the TLD metadata. Quote the exact operation and term, then use that numeric quote as `expectedPrice`. Reassess a price mismatch against the user's authorized spend instead of silently accepting an increase.

Purchases, renewals, and transfers can complete asynchronously. Save the returned order ID, inspect the order and each domain's status, and report pending or failed outcomes accurately. If a submission times out, reconcile its order status before resubmitting a charge. Stop polling when completed or failed; if still pending after a bounded check, return the order ID and next status-check action. Complete any required registrant email verification.

Use `/v1/registrar/*` for registrar operations instead of sunset legacy purchase, price, availability, or transfer endpoints. Existing project-domain and DNS APIs serve separate purposes; the registrar API does not replace them.
