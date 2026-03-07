---
name: shadcn
description: shadcn/ui expert guidance — CLI, component installation, custom registries, theming, and Tailwind CSS integration. Use when initializing shadcn, adding components, building custom registries, configuring themes, or troubleshooting component issues.
metadata:
  priority: 5
  pathPatterns: 
    - 'components.json'
    - 'components/ui/**'
    - 'src/components/ui/**'
    - 'apps/*/components/ui/**'
    - 'apps/*/src/components/ui/**'
    - 'packages/*/components/ui/**'
    - 'packages/*/src/components/ui/**'
  bashPatterns: 
    - '\bnpx\s+shadcn\b'
    - '\bnpx\s+shadcn@latest\s+(init|add|build|search|list|migrate)\b'
---

# shadcn/ui

You are an expert in shadcn/ui — a collection of beautifully designed, accessible, and customizable React components built on Radix UI primitives and Tailwind CSS. Components are added directly to your codebase as source code, not installed as a dependency.

## Key Concept

shadcn/ui is **not a component library** in the traditional sense. You don't install it as a package. Instead, the CLI copies component source code into your project, giving you full ownership and customization ability.

## CLI Commands

### Initialize

```bash
npx shadcn@latest init
```

Options:
- `-t, --template` — Project template (`next`, `next-monorepo`)
- `-b, --base-color` — Color palette (`neutral`, `gray`, `zinc`, `stone`, `slate`)
- `-y, --yes` — Skip confirmation prompts
- `-f, --force` — Force overwrite existing configuration

The init command:
1. Detects your framework (Next.js, Vite, Remix, Astro, Laravel)
2. Installs required dependencies (Radix UI, tailwind-merge, class-variance-authority)
3. Creates `components.json` configuration
4. Sets up the `cn()` utility function
5. Configures CSS variables for theming

### Add Components

```bash
# Add specific components
npx shadcn@latest add button dialog card

# Add all available components
npx shadcn@latest add --all

# Add from a custom registry
npx shadcn@latest add @v0/dashboard
npx shadcn@latest add @acme/custom-button

# Add from AI Elements registry
npx shadcn@latest add https://elements.ai-sdk.dev/api/registry/all.json
```

Options:
- `-o, --overwrite` — Overwrite existing files
- `-p, --path` — Custom install path
- `-a, --all` — Install all components

### Search & List

```bash
npx shadcn@latest search button
npx shadcn@latest list @v0
```

### Build (Custom Registry)

```bash
npx shadcn@latest build
npx shadcn@latest build ./registry.json -o ./public/r
```

### Migrate

```bash
npx shadcn@latest migrate rtl    # RTL support migration
npx shadcn@latest migrate icons  # Icon library changes
```

## Configuration (components.json)

The `components.json` file configures how shadcn/ui works in your project:

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": true,
  "tsx": true,
  "tailwind": {
    "config": "tailwind.config.ts",
    "css": "src/app/globals.css",
    "baseColor": "zinc",
    "cssVariables": true
  },
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/hooks"
  },
  "registries": {
    "v0": {
      "url": "https://v0.dev/chat/api/registry"
    },
    "ai-elements": {
      "url": "https://elements.ai-sdk.dev/api/registry"
    }
  }
}
```

### Namespaced Registries

Configure multiple registries for your project:

```json
{
  "registries": {
    "acme": {
      "url": "https://acme.com/registry/{name}.json"
    },
    "private": {
      "url": "https://internal.company.com/registry/{name}.json",
      "headers": {
        "Authorization": "Bearer ${REGISTRY_TOKEN}"
      }
    }
  }
}
```

Install using namespace syntax:

```bash
npx shadcn@latest add @acme/header @private/auth-form
```

## Theming

### CSS Variables

shadcn/ui uses CSS custom properties for theming, defined in `globals.css`:

```css
@theme inline {
  --color-background: oklch(0.145 0 0);
  --color-foreground: oklch(0.985 0 0);
  --color-card: oklch(0.205 0 0);
  --color-card-foreground: oklch(0.985 0 0);
  --color-primary: oklch(0.488 0.243 264.376);
  --color-primary-foreground: oklch(0.985 0 0);
  --color-secondary: oklch(0.269 0 0);
  --color-secondary-foreground: oklch(0.985 0 0);
  --color-muted: oklch(0.269 0 0);
  --color-muted-foreground: oklch(0.708 0 0);
  --color-accent: oklch(0.269 0 0);
  --color-accent-foreground: oklch(0.985 0 0);
  --color-destructive: oklch(0.396 0.141 25.723);
  --color-border: oklch(0.269 0 0);
  --color-input: oklch(0.269 0 0);
  --color-ring: oklch(0.488 0.243 264.376);
  --radius: 0.625rem;
}
```

### Dark Mode

For dark mode, use the `dark` class on `<html>`:

```tsx
// app/layout.tsx
<html lang="en" className="dark">
```

Or use next-themes for toggling:

```tsx
import { ThemeProvider } from 'next-themes'

<ThemeProvider attribute="class" defaultTheme="dark">
  {children}
</ThemeProvider>
```

### Custom Colors

Add application-specific colors alongside shadcn defaults:

```css
@theme inline {
  /* shadcn defaults above... */

  /* Custom app colors */
  --color-priority-urgent: oklch(0.637 0.237 15.163);
  --color-priority-high: oklch(0.705 0.213 47.604);
  --color-status-done: oklch(0.723 0.219 149.579);
}
```

Use in components:

```tsx
<span className="text-[var(--color-priority-urgent)]">Urgent</span>
// Or with Tailwind v4 theme():
<span className="text-priority-urgent">Urgent</span>
```

## Most Common Components

| Component | Use Case |
|-----------|----------|
| `button` | Actions, form submission |
| `card` | Content containers |
| `dialog` | Modals, confirmation prompts |
| `input` / `textarea` | Form fields |
| `select` | Dropdowns |
| `table` | Data display |
| `tabs` | View switching |
| `command` | Command palette (Cmd+K) |
| `dropdown-menu` | Context menus |
| `popover` | Floating content |
| `tooltip` | Hover hints |
| `badge` | Status indicators |
| `avatar` | User profile images |
| `scroll-area` | Scrollable containers |
| `separator` | Visual dividers |
| `label` | Form labels |
| `sheet` | Slide-out panels |
| `skeleton` | Loading placeholders |

## Building a Custom Registry

Create your own component registry to share across projects:

### 1. Define registry.json

```json
[
  {
    "name": "my-component",
    "type": "registry:ui",
    "title": "My Component",
    "description": "A custom component",
    "files": [
      {
        "path": "components/my-component.tsx",
        "type": "registry:ui"
      }
    ],
    "dependencies": ["lucide-react"]
  }
]
```

### 2. Build

```bash
npx shadcn@latest build
# Outputs to public/r/my-component.json
```

### 3. Consume

```bash
npx shadcn@latest add https://your-domain.com/r/my-component.json
```

## Component Gotchas

### `shadcn init` Breaks Geist Font in Next.js (Tailwind v4)

`shadcn init` rewrites `globals.css` and may introduce `--font-sans: var(--font-sans)` — a circular self-reference that breaks font loading. Tailwind v4's `@theme inline` resolves CSS custom properties at **parse time**, not runtime — so even `var(--font-geist-sans)` won't work because Next.js injects that variable via className at runtime.

**The fix**: Use literal font family names in `@theme inline`:

```css
/* In @theme inline — CORRECT (literal names) */
--font-sans: "Geist", "Geist Fallback", ui-sans-serif, system-ui, sans-serif;
--font-mono: "Geist Mono", "Geist Mono Fallback", ui-monospace, monospace;

/* WRONG — circular, resolves to nothing */
--font-sans: var(--font-sans);

/* ALSO WRONG — @theme inline can't resolve runtime CSS variables */
--font-sans: var(--font-geist-sans);
```

**After running `shadcn init`**, always:
1. Replace font declarations in `@theme inline` with literal Geist font names (as shown above)
2. Move the font variable classNames from `<body>` to `<html>` in `layout.tsx`:

```tsx
// layout.tsx — font variables on <html>, not <body>
<html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
  <body className="antialiased">
```

### Avatar Has No `size` Prop

The shadcn Avatar component does **not** accept a `size` variant prop. Control size with Tailwind classes:

```tsx
// WRONG — no size variant exists
<Avatar size="lg" />  // ❌ TypeScript error / silently ignored

// CORRECT — use Tailwind
<Avatar className="h-12 w-12">
  <AvatarImage src={user.image} />
  <AvatarFallback>JD</AvatarFallback>
</Avatar>

// Small avatar
<Avatar className="h-6 w-6"> ... </Avatar>
```

This applies to most shadcn components — they use Tailwind classes for sizing, not variant props. If you need reusable size variants, add them yourself via `cva` in the component source.

## Common Patterns

### cn() Utility

All shadcn components use the `cn()` utility for conditional class merging:

```ts
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
```

### Extending Components

Since you own the source code, extend components directly:

```tsx
// components/ui/button.tsx — add your custom variant
const buttonVariants = cva('...', {
  variants: {
    variant: {
      default: '...',
      destructive: '...',
      // Add custom variants
      success: 'bg-green-600 text-white hover:bg-green-700',
      premium: 'bg-gradient-to-r from-purple-500 to-pink-500 text-white',
    },
  },
})
```

### Wrapping with TooltipProvider

Many components require `TooltipProvider` at the root:

```tsx
// app/layout.tsx
import { TooltipProvider } from '@/components/ui/tooltip'

export default function RootLayout({ children }) {
  return (
    <html lang="en" className="dark">
      <body>
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  )
}
```

## Framework Support

- **Next.js** — Full support (App Router + Pages Router)
- **Vite** — Full support
- **Remix** — Full support
- **Astro** — Full support
- **Laravel** — Full support (via Inertia)

## RTL Support (2026)

The CLI handles RTL transformation at install time:

```bash
npx shadcn@latest migrate rtl
```

Converts directional classes (`ml-4`, `left-2`) to logical properties (`ms-4`, `start-2`) automatically.

## Official Documentation

- [shadcn/ui](https://ui.shadcn.com)
- [Components](https://ui.shadcn.com/docs/components)
- [CLI](https://ui.shadcn.com/docs/cli)
- [Theming](https://ui.shadcn.com/docs/theming)
- [Custom Registry](https://ui.shadcn.com/docs/registry)
- [Registry Directory](https://ui.shadcn.com/docs/directory)
- [GitHub: shadcn/ui](https://github.com/shadcn-ui/ui)
