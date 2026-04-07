# Managing Microfrontends Security

> Source: [Vercel Docs — Managing microfrontends security](https://vercel.com/docs/microfrontends/managing-microfrontends/security)

Understand how and where you manage [Deployment Protection](https://vercel.com/docs/deployment-protection) and [Vercel Firewall](https://vercel.com/docs/vercel-firewall) for each microfrontend application.

- [Deployment Protection and microfrontends](#deployment-protection-and-microfrontends)
- [Vercel Firewall and microfrontends](#vercel-firewall-and-microfrontends)

## Deployment Protection and microfrontends

Because each URL is protected by the [Deployment Protection](https://vercel.com/docs/security/deployment-protection) settings of the project it belongs to, the deployment protection for the microfrontend experience as a whole is determined by the **default application**.

For requests to a microfrontend host (a domain belonging to the microfrontend default application):

- Requests are **only** verified by the [Deployment Protection](https://vercel.com/docs/security/deployment-protection) settings for the project of your **default application**

For requests directly to a child application (a domain belonging to a child microfrontend):

- Requests are **only** verified by the [Deployment Protection](https://vercel.com/docs/security/deployment-protection) settings for the project of the **child application**

This applies to all [protection methods](https://vercel.com/docs/security/deployment-protection/methods-to-protect-deployments) and [bypass methods](https://vercel.com/docs/security/deployment-protection/methods-to-bypass-deployment-protection), including:

- [Vercel Authentication](https://vercel.com/docs/security/deployment-protection/methods-to-protect-deployments/vercel-authentication)
- [Password Protection](https://vercel.com/docs/security/deployment-protection/methods-to-protect-deployments/password-protection)
- [Trusted IPs](https://vercel.com/docs/security/deployment-protection/methods-to-protect-deployments/trusted-ips)
- [Shareable Links](https://vercel.com/docs/security/deployment-protection/methods-to-bypass-deployment-protection/sharable-links)
- [Protection Bypass for Automation](https://vercel.com/docs/security/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation)
- [Deployment Protection Exceptions](https://vercel.com/docs/security/deployment-protection/methods-to-bypass-deployment-protection/deployment-protection-exceptions)
- [OPTIONS Allowlist](https://vercel.com/docs/security/deployment-protection/methods-to-bypass-deployment-protection/options-allowlist)

### Managing Deployment Protection for your microfrontend

Use the [Deployment Protection](https://vercel.com/docs/security/deployment-protection) settings for the project of the default application to control access to the microfrontend.

Recommended configuration:

- **Default app**: Use [Standard Protection](https://vercel.com/docs/security/deployment-protection) so that end users can access the microfrontend through the default app's URL.
- **Child apps**: Enable [protection for all deployments](https://vercel.com/docs/security/deployment-protection) so that child apps are not directly accessible. Since child app content is served through the default app's URL, child apps can only be accessed via the URL of the default project.

This works because Vercel handles routing to child apps within a single request at the network layer — as explained in [Path Routing](https://vercel.com/docs/microfrontends/path-routing) — it is not a rewrite that would result in a separate request to the child app's URL. Deployment protection on the child app therefore applies only when the child app's URL is accessed directly.

## Vercel Firewall and microfrontends

- The [Platform-wide firewall](https://vercel.com/docs/vercel-firewall#platform-wide-firewall) is applied to all requests.
- The customizable [Web Application Firewall (WAF)](https://vercel.com/docs/vercel-firewall/vercel-waf) from the default application and the corresponding child application is applied for a request.

### Vercel WAF and microfrontends

For requests to a microfrontend host (a domain belonging to the microfrontend default application):

- All requests are verified by the [Vercel WAF](https://vercel.com/docs/vercel-firewall/vercel-waf) for the project of your default application
- Requests to child applications are **additionally** verified by the [Vercel WAF](https://vercel.com/docs/vercel-firewall/vercel-waf) for their project

For requests directly to a child application (a domain belonging to a child microfrontend):

- Requests are **only** verified by the [Vercel WAF](https://vercel.com/docs/vercel-firewall/vercel-waf) for the project of the child application.

This applies for the entire [Vercel WAF](https://vercel.com/docs/vercel-firewall/vercel-waf), including [Custom Rules](https://vercel.com/docs/vercel-firewall/vercel-waf/custom-rules), [IP Blocking](https://vercel.com/docs/vercel-firewall/vercel-waf/ip-blocking), [WAF Managed Rulesets](https://vercel.com/docs/vercel-firewall/vercel-waf/managed-rulesets), and [Attack Challenge Mode](https://vercel.com/docs/vercel-firewall/attack-challenge-mode).

### Managing the Vercel WAF for your microfrontend

- To set a WAF rule that applies to all requests to a microfrontend, use the [Vercel WAF](https://vercel.com/docs/vercel-firewall/vercel-waf) for your default application.
- To set a WAF rule that applies **only** to requests to paths of a child application, use the [Vercel WAF](https://vercel.com/docs/vercel-firewall/vercel-waf) for the child project.
