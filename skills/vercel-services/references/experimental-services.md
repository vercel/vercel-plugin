# Experimental Services

The [Experimental Services docs](https://vercel.com/docs/services/experimental) describe `experimentalServices` as the earlier configuration model: new projects use `services`, and `experimentalServices` remains available while you migrate. A project on it has an `experimentalServices` key in `vercel.json`, with entries that use `entrypoint` and `routePrefix`:

```json filename="vercel.json"
{
  "experimentalServices": {
    "web": {
      "entrypoint": "apps/web",
      "routePrefix": "/"
    },
    "backend": {
      "entrypoint": "backend/main.py",
      "routePrefix": "/server"
    }
  }
}
```

The project framework setting must be Services for `experimentalServices` to deploy.

## How the two models route

`experimentalServices` routes by `routePrefix`: Vercel evaluates prefixes longest to shortest, with `"/"` as the catch-all, and mounts each backend at its prefix. `services` routes only through top-level rewrites with `destination.service`: a service is private by default, and a rewrite that exposes it passes the original request path through unchanged, with no automatic prefix mounting.

## Migrate to `services`

| `experimentalServices` | `services` |
| --- | --- |
| `entrypoint`, a path from `vercel.json` | `root` set to the service directory, plus `entrypoint` relative to that root when the runtime needs one |
| `root` | `root` (required on every service) |
| `routePrefix` | A top-level rewrite such as `{ "source": "/server/(.*)", "destination": { "service": "backend" } }`, ordered most specific first. The service receives the original path, so handle the prefix in the app or change the path your code sees with a `request.path` transform in the service's own `routes` |
| `framework` | `framework` on the service |
| `memory`, `maxDuration` | The service's `functions` object |
| `includeFiles`, `excludeFiles` | The service's `functions` object, where each takes a single glob string. `experimentalServices` also accepts an array, so fold an array into one glob pattern when you move it |

A service's `functions` object uses the [same schema](https://github.com/vercel/vercel/blob/c628be7835e03a965b93e9cf9e2bd5ac2acbf5eb/packages/cli/src/util/validate-config.ts#L622) as the [top-level `functions`](https://github.com/vercel/vercel/blob/c628be7835e03a965b93e9cf9e2bd5ac2acbf5eb/packages/cli/src/util/validate-config.ts#L683):

```json filename="vercel.json"
{
  "services": {
    "backend": {
      "root": "apps/backend",
      "functions": {
        "**/*.py": {
          "memory": 1024,
          "maxDuration": 30
        }
      }
    }
  }
}
```

Replace the whole `experimentalServices` key in one change: [validation rejects](https://github.com/vercel/vercel/blob/c628be7835e03a965b93e9cf9e2bd5ac2acbf5eb/packages/cli/src/util/validate-config.ts#L816-L821) a `vercel.json` that declares both `services` and `experimentalServices`.
