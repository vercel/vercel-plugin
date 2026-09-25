# OIDC Federation (Secure Backend Access)

Vercel OIDC federation is for **secure backend access** — letting your deployed Vercel functions authenticate with third-party services (AWS, GCP, HashiCorp Vault) without storing long-lived secrets. It does **not** replace `VERCEL_TOKEN` for CLI deployments.

**What OIDC does:** Your Vercel function requests a short-lived OIDC token from Vercel at runtime, then exchanges it with an external provider's STS/token endpoint for scoped credentials.

**What OIDC does not do:** Authenticate `vercel pull`/`build`/`deploy` in CI; those need a Vercel access token. Only `vcr` and Remote Cache offer CI-side OIDC exchanges.

**When to use OIDC:**
- Serverless functions that need to call AWS APIs (S3, DynamoDB, SQS)
- Functions authenticating to GCP services via Workload Identity Federation
- Any runtime service-to-service auth where you want to avoid storing static secrets in Vercel env vars
