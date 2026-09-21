# Credits, budgets, reporting, and observability

Use this reference for AI Gateway Credits, spend caps, usage reporting, request logs, and debugging. Read current docs before editing billing or spend controls.

## AI Gateway Credits and pricing

AI Gateway adds no platform markup to provider pricing, and some models are priced below provider list for every team; browse current ones at <https://vercel.com/ai-gateway/models?discount=true>. Volume commitments can negotiate custom discounts with invoice payment. Requests draw on AI Gateway Credits unless BYOK credentials are used. Docs: <https://vercel.com/docs/ai-gateway/pricing/discounts>

- A team needs a valid payment method to unlock free AI Gateway Credits. The gateway returns `customer_verification_required` with an action link when verification is missing.
- Free-tier requests use a subset of models and have lower per-model rate limits. Exceeding one returns `429`; buying credits moves the team to the paid tier and raises limits.
- A request that exceeds the balance fails with `402` and `insufficient_funds`. BYOK requests also require a positive balance so fallback providers remain available.
- Credits support manual top-up and auto top-up. Some opt-in extras bill separately: Custom Reporting writes and queries, Trace Drains, and team-wide compliance or provider-restriction policies.

Check the pricing page for the current free-credit amount and tiers instead of hardcoding it. Docs: <https://vercel.com/docs/ai-gateway/pricing>

## Budgets

A budget caps AI Gateway spend at one of four scopes:

| Scope | Meters |
| --- | --- |
| Team | Every request across the team |
| Project | Requests authenticated by that project's OIDC tokens |
| API key | Requests using that one key |
| User | Requests using keys attributed to that member |

Budgets stack. A request must pass every budget in scope, and one exhausted budget rejects it even when the others have room. Exceeded budgets reject further requests with HTTP `402` and type `quota_for_entity_exceeded` until the budget resets or its limit is raised. A budget is a soft cap: the request that crosses the limit completes.

Refresh periods reset at UTC boundaries: daily at midnight, weekly on Monday, monthly on the first of the month. `none` never resets.

### Default budgets

Each of project, API key, and user scopes can have one default that covers every covered resource without its own budget:

- The default applies immediately to existing and future resources in that scope.
- Each covered resource gets its own allowance; the limit is per resource, not split across them.
- A custom budget always wins over the default.
- Removing a default lifts the cap from every covered resource; only a wider team budget still applies.

### Spend alerts

Custom budgets can email on 50%, 75%, or 100% of the limit, at most once per period per threshold. Recipients depend on scope: team and project budgets email team owners and members with the Billing role, an API key budget emails the key's creator, and a user budget emails that member. Alerts are informational; a threshold below 100% never blocks requests.

Default budgets do not send spend alerts; set a custom budget on a resource to get alerts for it.

BYOK spend is metered separately and does not count toward any budget.

### CLI and API

The Vercel CLI manages budgets per scope. `set` creates or updates, `list` shows every scope's limit and spend, `inspect` shows one scope, and `remove` lifts a cap (falling back to the scope's default when one exists). Defaults get their own `defaults` subcommand:

```bash
vercel ai-gateway budgets set team --limit 500 --refresh-period monthly
vercel ai-gateway budgets set project my-project --limit 200
vercel ai-gateway budgets set api-key my-key --limit 50
vercel ai-gateway budgets defaults set api-key --limit 50 --refresh-period monthly
vercel ai-gateway budgets inspect team
vercel ai-gateway budgets list
```

Check `vercel ai-gateway budgets set --help` for the current flag set before scripting.

Budget changes take effect after a short delay, typically tens of seconds and up to about 5 minutes for an actively used key.

Docs: <https://vercel.com/docs/ai-gateway/observability-and-spend/budgets> and <https://vercel.com/docs/cli/ai-gateway#budgets>

## Request authentication

Team budgets count every request. Project budgets apply only to OIDC-authenticated requests from that project's deployments. API key and user budgets apply to key usage. BYOK requests are metered but never counted against a limit. Read the budgets page before changing attribution or defaults; metering is not retroactive for a re-created budget.

### Spend attribution and permissions

Each API key is attributed to the team or to the member who created it. Only member-attributed keys count toward a user budget; OIDC tokens, personal access tokens, and app tokens never do. Attribution is editable: <https://vercel.com/docs/ai-gateway/authentication-and-byok/api-keys#spend-attribution>

Every team role except Contributor can view budgets. An Owner can grant a member the AI Gateway Budget Manager permission, which covers budget writes at every scope except API key budgets, which follow key-editing permission.

## Observability

The AI Gateway Overview shows usage, spend, time to first token, and token counts by model, plus request summaries by project and API key. AI Traces and Trace Drains cover OpenTelemetry tracing and export for Pro and Enterprise (<https://vercel.com/docs/ai-gateway/observability-and-spend/trace-drains>).

For individual requests, use the Logs page. It lists every request and asynchronous job newest first with status, model, provider, usage, cost, duration, and authentication, and supports filters for status, model, provider, authentication, routing, modality, latency, tokens, cost, and date range. Filters live in the URL, so a filtered view can be shared. Live mode tails new requests as they arrive; requests take about 90 seconds to fully ingest. Logs also exist at project scope under `/[team]/[project]/ai-gateway/logs`, and the page copies visible rows or exports loaded rows as CSV or JSON.

One request's details panel shows every provider attempt, including retries, credential source, time to first token, timing spans, status, and provider response, plus usage and cost breakdowns. Routing attempt details are kept for 30 days; the list allows up to 36 days.

Docs: <https://vercel.com/docs/ai-gateway/observability-and-spend/logs> and <https://vercel.com/docs/ai-gateway/observability-and-spend/observability>

## Custom Reporting

The Custom Reporting API aggregates usage by model, user, tag, provider, credential type, ZDR status, or API key name, with filters for each dimension and day- or hour-level granularity. It requires a Pro or Enterprise plan, is beta, and bills writes and queries.

Attach `user` and/or `tags` to requests through `providerOptions.gateway` (AI SDK) or `extra_body.providerOptions.gateway` (Python SDKs), or through the `ai-reporting-user` and `ai-reporting-tags` headers when a proxy stamps context without changing application code.

```bash
curl "https://ai-gateway.vercel.sh/v1/report?start_date=2026-01-01&end_date=2026-01-31&group_by=model" \
  -H "Authorization: Bearer $AI_GATEWAY_API_KEY"
```

Results can take a few minutes to appear. The AI SDK exposes equivalent helpers, such as `gateway.getSpendReport()` and `gateway.getGenerationInfo()`; confirm names against the installed package.

Docs: <https://vercel.com/docs/ai-gateway/observability-and-spend/custom-reporting>

## Usage and billing endpoints

Two REST endpoints cover balance and per-request cost without opening the dashboard:

- `GET /v1/credits` returns the team's remaining credit balance and lifetime spend.
- `GET /v1/generation` returns cost, latency, finish reason, and token usage for one generation.

Every response carries its generation ID: the `id` field on a chat completion, injected into the first chunk of a stream, and `providerMetadata.gateway.generationId` in the AI SDK. Capture it when the application may need a cost lookup later.

Docs: <https://vercel.com/docs/ai-gateway/observability-and-spend/usage> and the REST API reference at <https://vercel.com/docs/ai-gateway/sdks-and-apis/rest-api>

## Debugging checklist

1. Find the request in AI Gateway Logs by request ID, model, status, or time range.
2. Check authentication: the row names the API key, OIDC project, app token, or personal access token used.
3. Read the routing cards for every provider attempt and their statuses.
4. Compare usage and cost against the budget and credit balance.
5. For a failed request, match the status against the first-request error table before changing routing or credentials.
6. For recurring spend patterns, query Custom Reporting by model, tag, user, or credential type rather than reading individual logs one at a time.
