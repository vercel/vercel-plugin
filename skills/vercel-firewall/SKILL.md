---
name: vercel-firewall
description: Vercel Firewall expert guidance — automatic DDoS mitigation, the Vercel WAF (custom rules, IP blocking, managed rulesets, rate limiting), Attack Challenge Mode, system bypass, bot management, and the `vercel firewall` CLI. Use when configuring platform-level security, responding to attacks, or staging firewall rules.
metadata:
  priority: 7
  docs:
    - 'https://vercel.com/docs/vercel-firewall'
    - 'https://vercel.com/docs/cli/firewall'
  bashPatterns:
    - '\bvercel\s+firewall\b'
  promptSignals:
    phrases:
      - 'vercel firewall'
      - 'vercel waf'
      - 'attack challenge mode'
      - 'ddos protection'
      - 'ip block'
      - 'managed ruleset'
      - 'bot protection'
      - 'system bypass'
      - 'rate limit rule'
    allOf:
      - [firewall, vercel]
      - [waf, vercel]
      - [ddos, vercel]
      - [challenge, vercel]
      - ['rate limit', vercel]
      - ['system bypass', vercel]
      - ['ip block', vercel]
    noneOf: []
    minScore: 6
retrieval:
  aliases:
    - ddos protection
    - waf rules
    - bot protection
    - rate limiting
    - attack mode
    - ip allowlist
    - traffic filtering
    - verified bots
  intents:
    - protect from ddos
    - block malicious traffic
    - configure firewall
    - rate limit api
    - allow bot through firewall
    - enable attack mode
    - publish firewall rule
  entities:
    - Vercel Firewall
    - Vercel WAF
    - DDoS
    - Attack Challenge Mode
    - Bot Protection
    - Managed Rulesets
    - System Bypass
    - JA3
    - JA4
---

# Vercel Firewall

You are an expert in the Vercel Firewall including the `vercel firewall` CLI, Vercel WAF and platform-level protections (custom rules, IP blocks, system bypass, Attack Challenge Mode, system mitigations). Project must be linked first (`vercel link`).

## Core Knowledge

- **Vercel ships a multi-layered firewall**, not just a CDN. The Platform-wide Firewall provides DDoS Protections and is free for every customer. Customers can also configure a Web Application Firewall with custom rules.
- **Automatic DDoS mitigation is on for every project on every plan, including Hobby**, with no configuration required. It covers L3/L4/L7 attacks.
- **Vercel does not bill for traffic blocked by DDoS mitigations.** Usage is only incurred for requests served before mitigation kicked in or not classified as an attack. Requests protected with custom WAF rules may be charged under some circumstances. See https://vercel.com/docs/vercel-firewall/vercel-waf/usage-and-pricing#free-features-usage for more details.
- **The Firewall can be configured with a custom WAF.** Actions: `deny`, `challenge`, `log`, `bypass`, `rate_limit`, `redirect`. Matching on path, method, IP/CIDR, geo, headers/cookies/queries, user agent, regex, JA3/JA4.

## Overview

```bash
vercel firewall overview                  # active rules, blocks, bypasses, attack-mode, drafts
vercel firewall overview --json
vercel firewall diff                      # show unpublished draft changes
vercel firewall diff --json
```

`rules` and `ip-blocks` changes are **staged** as drafts — run `vercel firewall publish --yes` to make them live. `system-bypass`, `attack-mode`, and `system-mitigations` take effect **immediately**.

## Custom rules

[Custom rules](https://vercel.com/docs/vercel-firewall/vercel-waf/custom-rules) define traffic policies based on request attributes. Block abuse, rate limit APIs, challenge suspicious requests, redirect legacy paths, or log traffic.

### View

```bash
vercel firewall rules list                          # table of all rules
vercel firewall rules list --expand                 # show conditions + actions
vercel firewall rules list --json
vercel firewall rules inspect "My Rule"             # full detail of one rule
vercel firewall rules inspect "My Rule" --json
```

### Create — four modes

```bash
# AI — TTY only, BLOCKED FOR AGENTS/SCRIPTS
vercel firewall rules add --ai "Rate limit /api to 100 requests per minute by IP"

# Interactive wizard — TTY only, BLOCKED FOR AGENTS/SCRIPTS
vercel firewall rules add

# Flags — works in scripts and agents
vercel firewall rules add "Block crawlers" \
  --condition '{"type":"user_agent","op":"sub","value":"crawler"}' \
  --action deny --yes

# JSON — works in scripts and agents
vercel firewall rules add --json '{"name":"Block crawlers","conditionGroup":[{"conditions":[{"type":"user_agent","op":"sub","value":"crawler"}]}],"action":{"mitigate":{"action":"deny"}}}' --yes
```

### Multiple conditions (AND) and OR groups

```bash
# AND — multiple --condition flags in the same group
vercel firewall rules add "Secure admin" \
  --condition '{"type":"path","op":"pre","value":"/admin"}' \
  --condition '{"type":"geo_country","op":"eq","neg":true,"value":"US"}' \
  --action deny --yes

# OR — use --or to start a new group
vercel firewall rules add "Block dangerous methods" \
  --condition '{"type":"method","op":"eq","value":"DELETE"}' \
  --or \
  --condition '{"type":"method","op":"eq","value":"PATCH"}' \
  --action challenge --yes
```

### Edit and manage

```bash
vercel firewall rules edit "My Rule" --action challenge --yes      # change action
vercel firewall rules edit "My Rule" --name "New Name" --yes       # rename
vercel firewall rules edit "My Rule" --enabled --yes               # enable
vercel firewall rules edit "My Rule" --disabled --yes              # disable
vercel firewall rules edit "My Rule" \
  --condition '{"type":"path","op":"pre","value":"/new"}' --yes    # replace conditions

vercel firewall rules enable  "My Rule"
vercel firewall rules disable "My Rule"
vercel firewall rules remove  "My Rule" --yes                      # aliases: rm, delete
vercel firewall rules reorder "My Rule" --first  --yes             # move to highest priority
vercel firewall rules reorder "My Rule" --last   --yes
vercel firewall rules reorder "My Rule" --position 3 --yes         # 1-based
```

Rules are evaluated in priority order (top to bottom). Reorder to control which rule matches first.

### Condition format

Each `--condition` is a JSON object:

```json
{
  "type": "path", // condition type (required)
  "op": "pre", // operator (required)
  "value": "/api", // value (required for most operators; omit for ex/nex)
  "key": "Authorization", // required for header / cookie / query types
  "neg": true // negate the condition (optional, default false)
}
```

Conditions within a group are **AND'd**. Multiple groups (separated by `--or`) are **OR'd**.

### Operators

`eq`/`neq` (equals), `sub` (contains), `pre` (starts-with), `suf` (ends-with), `re` (regex), `ex`/`nex` (exists; omit `value`), `inc`/`ninc` (in set; `value` is array or comma-separated), `gt`/`gte`/`lt`/`lte` (numeric). Set `neg: true` to negate any operator.

### Condition types

- **Request shape**: `path`, `raw_path` (pre-rewrite), `target_path` (post-rewrite), `route` (e.g., `/blog/[slug]`), `server_action`, `method`, `host`, `protocol`, `scheme`, `environment` (preview|production), `region`
- **Client**: `ip_address` (IP or CIDR), `user_agent`, `geo_country`, `geo_continent`, `geo_country_region`, `geo_city`, `geo_as_number`
- **Headers / cookies / queries** — require `key`: `header`, `cookie`, `query`
- **TLS fingerprints**: `ja4_digest` (all plans), `ja3_digest` (Enterprise only)
- **Verified bots** (Security Plus only): `bot_name`, `bot_category`

### Actions

- `deny` — block (403)
- `challenge` — show verification page
- `log` — log without blocking (use to tune before enforcing)
- `bypass` — skip remaining WAF custom rules + managed rulesets
- `rate_limit` — throttle by counting key (see Rate limit example for flags)
- `redirect` — redirect to URL (`--redirect-url`, `--redirect-permanent` for 301; default 307)

All actions accept `--duration` (Pro/Enterprise): `1m`, `5m`, `15m`, `30m`, `1h`. Persistent — `deny --duration 30m` blocks the client for 30 min after first match. Without a duration the action evaluates per-request.

### Rate limit example

```bash
vercel firewall rules add "Rate limit API" \
  --condition '{"type":"path","op":"pre","value":"/api"}' \
  --action rate_limit \
  --rate-limit-window 60 \
  --rate-limit-requests 100 \
  --rate-limit-keys ip \
  --rate-limit-action deny \
  --yes
```

- `--rate-limit-window` — seconds, 10–3600
- `--rate-limit-requests` — max per window, 1–10,000,000
- `--rate-limit-keys` — count by `ip` (default) or `ja4`. `header:<name>` Enterprise only. Repeatable.
- `--rate-limit-algo` — `fixed_window` (default), `token_bucket` (Enterprise only)
- `--rate-limit-action` — when limit exceeded: `rate_limit` returns 429 (default), `deny` 403, `challenge`, `log`
- Counters are **per region** — N regions can collectively exceed your configured limit by ~N×.

### Redirect example

```bash
vercel firewall rules add "Redirect old path" \
  --condition '{"type":"path","op":"eq","value":"/old"}' \
  --action redirect \
  --redirect-url "/new" \
  --redirect-permanent \
  --yes
```

- `--redirect-url` — destination (must start with `/`, `http://`, or `https://`)
- `--redirect-permanent` — 301. Default 307.

### JSON rule schema (for `--json`)

```json
{
  "name": "Rule name (max 160 chars)",
  "description": "Optional (max 256)",
  "active": true,
  "conditionGroup": [
    {
      "conditions": [
        { "type": "path", "op": "pre", "value": "/api" },
        { "type": "method", "op": "inc", "value": ["POST", "PUT"] }
      ]
    },
    { "conditions": [{ "type": "ip_address", "op": "eq", "value": "1.2.3.4" }] }
  ],
  "action": {
    "mitigate": {
      "action": "rate_limit",
      "actionDuration": "1h",
      "rateLimit": {
        "algo": "fixed_window",
        "window": 60,
        "limit": 100,
        "keys": ["ip"],
        "action": "rate_limit"
      },
      "redirect": null
    }
  }
}
```

## IP blocks

[IP blocking](https://vercel.com/docs/vercel-firewall/vercel-waf/ip-blocking) blocks IPs or CIDRs entirely. Staged — requires `publish`.

```bash
vercel firewall ip-blocks list
vercel firewall ip-blocks list --json
vercel firewall ip-blocks block 1.2.3.4 --yes
vercel firewall ip-blocks block 10.0.0.0/24 --hostname example.com --yes   # scoped to a host
vercel firewall ip-blocks block 1.2.3.4 --notes "Abuse report #123" --yes
vercel firewall ip-blocks unblock 1.2.3.4 --yes
vercel firewall ip-blocks unblock 1.2.3.4 --hostname example.com --yes     # disambiguate when blocked on multiple hosts
vercel firewall ip-blocks unblock ip_abc123 --yes                          # by rule ID
```

## System bypass

[System bypass rules](https://vercel.com/docs/vercel-firewall/vercel-waf/system-bypass-rules) exempt trusted IPs/CIDRs from **all** firewall checks (office, CI servers, uptime monitors). Immediate — no publish.

```bash
vercel firewall system-bypass list
vercel firewall system-bypass list --json
vercel firewall system-bypass add 10.0.0.1 --yes
vercel firewall system-bypass add 10.0.0.0/24 --yes
vercel firewall system-bypass add 10.0.0.1 --domain example.com --yes
vercel firewall system-bypass add 10.0.0.1 --domain "*.example.com" --yes  # wildcard domain
vercel firewall system-bypass add 10.0.0.1 --notes "Office IP" --yes
vercel firewall system-bypass remove 10.0.0.1 --yes
```

System bypass does **not** override your own custom rules — for that, use a custom rule with `--action bypass`.

## Attack mode

[Attack Challenge Mode](https://vercel.com/docs/vercel-firewall/attack-challenge-mode) is the emergency response for active attacks. Unverified visitors see a challenge page; verified bots and search crawlers are exempt. Immediate — no publish. **Requires interactive confirmation; blocked for agents/scripts due to severity.**

```bash
vercel firewall attack-mode enable --duration 1h --yes    # 1h (default)
vercel firewall attack-mode enable --duration 6h --yes
vercel firewall attack-mode enable --duration 24h --yes
vercel firewall attack-mode disable --yes
```

## System mitigations

Vercel automatically [mitigates DDoS attacks](https://vercel.com/docs/vercel-firewall/ddos-mitigation). In rare cases (debugging false positives) you may need to pause them. Auto-resumes after 24h. Immediate. **Blocked for agents/scripts due to severity — pausing removes DDoS protection.**

```bash
vercel firewall system-mitigations pause  --yes    # 24h, auto-resume
vercel firewall system-mitigations resume --yes
```

## Publishing

```bash
vercel firewall diff                      # review staged changes
vercel firewall publish --yes             # push drafts to production
vercel firewall discard --yes             # throw away drafts
```

## Best practices

The firewall sits in front of every request. A misconfigured rule can block real users, kill SEO crawlers, or break checkout. Treat changes like a production database migration: stage, review, and let the user pull the trigger.

- **Start every new rule in `log` mode.** Set `--action log` first — the rule records hits to the Firewall dashboard but blocks nothing. Ask the user to open the project's **Firewall** tab and review the requests the rule would have blocked or challenged. Once they confirm only malicious traffic is matching, upgrade the action:

  ```bash
  vercel firewall rules edit "Rule name" --action challenge --yes   # or deny
  vercel firewall diff
  ```

  Then ask the user to `vercel firewall publish --yes`. Repeat the log-first cycle for every meaningful change.

- **Stage drafts; let the user publish.** Mutating commands (`rules add/edit/enable/disable/remove/reorder`, `ip-blocks block/unblock`) only stage. Run `vercel firewall diff` to show what will change, then **ask the user to run `vercel firewall publish --yes` themselves** — don't push to production on their behalf. Use `discard --yes` only if the user asks to abandon staged changes.

- **Don't run commands the CLI blocks for agents.** Surface what the user needs to do instead:
  - `vercel firewall rules add --ai "..."` and `vercel firewall rules add` (wizard) — TTY-only. Use `--condition` flags or `--json`.
  - `vercel firewall attack-mode enable` — requires explicit interactive confirmation; have the user run it.
  - `vercel firewall system-mitigations pause` — pauses platform DDoS protection across the project; have the user run it and resume ASAP.

- **Inspect before recommending publish.** A `deny` with a loose condition (e.g., `path` starts with `/`) blocks the entire site. Always `vercel firewall rules inspect "Name" --expand` and `vercel firewall diff` before handing the publish step to the user.

- **Tune rate limits gently.** Start with a generous `--rate-limit-requests` (5–10× the expected legitimate rate) and `--rate-limit-action log`. After the user reviews dashboard data, tighten the limit and switch the action to `rate_limit`, `challenge`, or `deny`.

- **Keep bypasses narrow.** When unblocking trusted automation, scope by a shared-secret header **plus** an IP or CIDR. Avoid wide-open bypasses (e.g., a single header with a known value an attacker could guess).

- **Don't disable managed rulesets to fix one false positive.** If Bot Protection or the AI Bots ruleset is challenging legitimate traffic, add a higher-priority custom rule with `--action bypass` scoped to the specific path, header, or IP instead.

## External reverse proxies

External proxies in front of Vercel reduce firewall and Bot Protection accuracy: real client IPs become opaque, signal reliability drops, legitimate users may be repeatedly challenged. Avoid when you can. If required, use **Verified Proxy** so Vercel trusts your proxy's headers from a known egress range. https://vercel.com/docs/security/reverse-proxy

## Official Documentation

- [Vercel Firewall](https://vercel.com/docs/vercel-firewall)
- [Bot management](https://vercel.com/docs/bot-management)
- [Vercel CLI](https://vercel.com/docs/cli/firewall)
