---
name: styled-jsx
description: Expert guidance for styled-jsx — scoped CSS-in-JS for React and Next.js. Use when writing component-scoped styles with the styled-jsx babel plugin, using dynamic styles, global styles, or the styled-jsx/css API for external style definitions.
metadata:
  priority: 4
  pathPatterns: []
  importPatterns:
    - 'styled-jsx'
    - 'styled-jsx/css'
  bashPatterns:
    - '\bnpm\s+(install|i|add)\s+[^\n]*\bstyled-jsx\b'
    - '\bpnpm\s+(install|i|add)\s+[^\n]*\bstyled-jsx\b'
    - '\bbun\s+(install|i|add)\s+[^\n]*\bstyled-jsx\b'
    - '\byarn\s+add\s+[^\n]*\bstyled-jsx\b'
---

# styled-jsx — Scoped CSS-in-JS for React

You are an expert in styled-jsx, Vercel's CSS-in-JS library that provides full CSS support scoped to React components. styled-jsx is bundled with Next.js by default.

## Overview

styled-jsx lets you write CSS directly inside React components using a `<style jsx>` tag. Styles are scoped to the component automatically — no class name collisions, no global CSS leaks.

## Basic Usage

```tsx
function Button() {
  return (
    <div>
      <button>Click me</button>
      <style jsx>{`
        button {
          background: #0070f3;
          color: white;
          border: none;
          padding: 8px 16px;
          border-radius: 4px;
          cursor: pointer;
        }
        button:hover {
          background: #0060df;
        }
      `}</style>
    </div>
  )
}
```

## Dynamic Styles

Use JavaScript expressions inside template literals:

```tsx
function Alert({ type }: { type: 'success' | 'error' }) {
  return (
    <div className="alert">
      <style jsx>{`
        .alert {
          color: ${type === 'success' ? 'green' : 'red'};
          padding: 16px;
          border: 1px solid ${type === 'success' ? 'green' : 'red'};
        }
      `}</style>
    </div>
  )
}
```

## Global Styles

Add the `global` attribute to apply styles globally:

```tsx
function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      {children}
      <style jsx global>{`
        body {
          margin: 0;
          font-family: -apple-system, sans-serif;
        }
        * {
          box-sizing: border-box;
        }
      `}</style>
    </div>
  )
}
```

## External Styles with `styled-jsx/css`

Extract styles into variables using the `styled-jsx/css` API:

```tsx
import css from 'styled-jsx/css'

const buttonStyles = css`
  button {
    background: #0070f3;
    color: white;
    border: none;
    padding: 8px 16px;
  }
`

function Button() {
  return (
    <button>
      Click me
      <style jsx>{buttonStyles}</style>
    </button>
  )
}
```

### Resolved Styles (for child components)

Use `css.resolve` to get a `className` and `styles` element you can pass to child components:

```tsx
import css from 'styled-jsx/css'

const { className, styles } = css.resolve`
  a {
    color: #0070f3;
    text-decoration: none;
  }
  a:hover {
    text-decoration: underline;
  }
`

function Link({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <>
      <a href={href} className={className}>{children}</a>
      {styles}
    </>
  )
}
```

### Global External Styles

```tsx
import css from 'styled-jsx/css'

const globalStyles = css.global`
  body {
    margin: 0;
  }
`
```

## Server Components (Next.js App Router)

styled-jsx requires a Client Component boundary. In the App Router, add `"use client"` to any component using `<style jsx>`:

```tsx
"use client"

function StyledComponent() {
  return (
    <div>
      <style jsx>{`div { color: blue; }`}</style>
    </div>
  )
}
```

## Key Rules

1. **Scoped by default** — styles only apply to the component where they're defined
2. **Use `global` for global styles** — `<style jsx global>` applies styles globally
3. **Template literals required** — styles must be in tagged template literals (backticks)
4. **One `<style jsx>` per component** — multiple style tags work but one is idiomatic
5. **Bundled with Next.js** — no extra install needed in Next.js projects
6. **Client Components only** (App Router) — add `"use client"` directive
7. **`css.resolve` for child styling** — when you need to style elements in child components

## Official Resources

- [styled-jsx GitHub](https://github.com/vercel/styled-jsx)
- [Next.js CSS-in-JS docs](https://nextjs.org/docs/app/building-your-application/styling/css-in-js)
