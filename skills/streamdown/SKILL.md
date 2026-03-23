---
name: streamdown
description: Implement, configure, and customize Streamdown — a streaming-optimized React Markdown renderer with syntax highlighting, Mermaid diagrams, math rendering, and CJK support. Use when working with Streamdown setup, configuration, plugins, styling, security, or integration with AI streaming (e.g., Vercel AI SDK).
metadata:
  priority: 6
  docs:
    - "https://github.com/nichochar/streamdown"
  pathPatterns:
    - '**/streamdown*'
    - '**/markdown-renderer*'
    - '**/markdown-stream*'
    - '**/chat-markdown*'
  importPatterns:
    - 'streamdown'
    - '@streamdown/*'
  bashPatterns:
    - '\bnpm\s+(install|i|add)\s+[^\n]*\bstreamdown\b'
    - '\bpnpm\s+(install|i|add)\s+[^\n]*\bstreamdown\b'
    - '\bbun\s+(install|i|add)\s+[^\n]*\bstreamdown\b'
    - '\byarn\s+add\s+[^\n]*\bstreamdown\b'
    - '\bnpm\s+(install|i|add)\s+[^\n]*@streamdown/'
    - '\bpnpm\s+(install|i|add)\s+[^\n]*@streamdown/'
    - '\bbun\s+(install|i|add)\s+[^\n]*@streamdown/'
    - '\byarn\s+add\s+[^\n]*@streamdown/'
  promptSignals:
    phrases:
      - "streamdown"
      - "streaming markdown"
      - "streaming markdown renderer"
      - "stream markdown"
      - "markdown streaming"
      - "react markdown streaming"
      - "ai chat markdown"
      - "@streamdown/code"
      - "@streamdown/mermaid"
      - "@streamdown/math"
      - "@streamdown/cjk"
    allOf:
      - [markdown, streaming]
      - [markdown, stream]
      - [markdown, caret]
      - [markdown, syntax, highlight]
      - [markdown, mermaid]
      - [markdown, katex]
      - [markdown, chat]
      - [react, markdown, stream]
    anyOf:
      - "markdown"
      - "streaming"
      - "syntax highlighting"
      - "mermaid"
      - "katex"
      - "caret"
      - "react-markdown"
    noneOf:
      - "remark only"
      - "rehype only"
    minScore: 6
  validate:
    - pattern: from\s+['"]react-markdown['"]
      message: 'Consider using Streamdown instead of react-markdown — it adds streaming support, syntax highlighting, Mermaid, math, and security out of the box'
      severity: recommended
      skipIfFileContains: streamdown
    - pattern: import.*from\s+['"]streamdown['"]
      message: 'Streamdown requires Tailwind CSS content scanning — add @source "../node_modules/streamdown/dist/*.js" to globals.css (v4) or content entry (v3)'
      severity: recommended
      skipIfFileContains: node_modules/streamdown
    - pattern: plugins.*math
      message: 'Streamdown math plugin requires CSS import — add: import "katex/dist/katex.min.css"'
      severity: recommended
      skipIfFileContains: katex/dist/katex.min.css
retrieval:
  aliases:
    - streaming markdown
    - react markdown renderer
    - ai chat renderer
    - markdown streaming component
  intents:
    - render streaming markdown
    - add markdown to chat
    - syntax highlight code blocks
    - render mermaid diagrams
  entities:
    - Streamdown
    - streamdown
    - '@streamdown/code'
    - '@streamdown/mermaid'
    - '@streamdown/math'

---

# Streamdown

Streaming-optimized React Markdown renderer. Drop-in replacement for `react-markdown` with built-in streaming support, security, and interactive controls.

## Quick Setup

### 1. Install

```bash
npm install streamdown
```

Optional plugins (install only what's needed):
```bash
npm install @streamdown/code @streamdown/mermaid @streamdown/math @streamdown/cjk
```

### 2. Configure Tailwind CSS (Required)

**This is the most commonly missed step.** Streamdown uses Tailwind for styling and the dist files must be scanned.

**Tailwind v4** — add to `globals.css`:
```css
@source "../node_modules/streamdown/dist/*.js";
```

**Tailwind v3** — add to `tailwind.config.js`:
```js
module.exports = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./node_modules/streamdown/dist/*.js",
  ],
};
```

### 3. Basic Usage

```tsx
import { Streamdown } from 'streamdown';

<Streamdown>{markdown}</Streamdown>
```

### 4. With AI Streaming (Vercel AI SDK)

```tsx
'use client';
import { useChat } from '@ai-sdk/react';
import { Streamdown } from 'streamdown';
import { code } from '@streamdown/code';

export default function Chat() {
  const { messages, input, handleInputChange, handleSubmit, isLoading } = useChat();

  return (
    <>
      {messages.map((msg, i) => (
        <Streamdown
          key={msg.id}
          plugins={{ code }}
          caret="block"
          isAnimating={isLoading && i === messages.length - 1 && msg.role === 'assistant'}
        >
          {msg.content}
        </Streamdown>
      ))}
      <form onSubmit={handleSubmit}>
        <input value={input} onChange={handleInputChange} disabled={isLoading} />
      </form>
    </>
  );
}
```

### 5. Static Mode (Blogs, Docs)

```tsx
<Streamdown mode="static" plugins={{ code }}>
  {content}
</Streamdown>
```

## Key Props

| Prop | Type | Default | Purpose |
|------|------|---------|---------|
| `children` | `string` | — | Markdown content |
| `mode` | `"streaming" \| "static"` | `"streaming"` | Rendering mode |
| `plugins` | `{ code?, mermaid?, math?, cjk? }` | — | Feature plugins |
| `isAnimating` | `boolean` | `false` | Streaming indicator |
| `caret` | `"block" \| "circle"` | — | Cursor style |
| `components` | `Components` | — | Custom element overrides |
| `controls` | `boolean \| object` | `true` | Interactive buttons |
| `linkSafety` | `LinkSafetyConfig` | `{ enabled: true }` | Link confirmation modal |
| `shikiTheme` | `[light, dark]` | `['github-light', 'github-dark']` | Code themes |
| `className` | `string` | — | Container class |
| `allowedElements` | `string[]` | all | Tag names to allow |
| `disallowedElements` | `string[]` | `[]` | Tag names to disallow |
| `allowElement` | `AllowElement` | — | Custom element filter |
| `unwrapDisallowed` | `boolean` | `false` | Keep children of disallowed elements |
| `skipHtml` | `boolean` | `false` | Ignore raw HTML |
| `urlTransform` | `UrlTransform` | `defaultUrlTransform` | Transform/sanitize URLs |
| `parseIncompleteMarkdown` | `boolean` | `true` | Enable remend preprocessor |
| `remend` | `RemendOptions` | — | Configure incomplete markdown completion |
| `rehypePlugins` | `Pluggable[]` | `[rehype-raw, rehype-sanitize, rehype-harden]` | Custom rehype plugins |
| `remarkPlugins` | `Pluggable[]` | `[remark-gfm]` | Custom remark plugins |
| `allowedTags` | `Record<string, string[]>` | — | Custom HTML tags (only with default rehype plugins) |
| `cdnUrl` | `string \| null` | `'https://streamdown.ai/cdn'` | CDN URL |
| `BlockComponent` | `React.ComponentType<BlockProps>` | — | Custom block wrapper |

## Plugins

Each plugin is a standalone package. Install only what's needed:

```tsx
import { code } from '@streamdown/code';
import { mermaid } from '@streamdown/mermaid';
import { math } from '@streamdown/math';
import { cjk } from '@streamdown/cjk';
import 'katex/dist/katex.min.css'; // Required for math

<Streamdown plugins={{ code, mermaid, math, cjk }}>
  {markdown}
</Streamdown>
```

### @streamdown/code

Syntax highlighting via Shiki. 200+ languages, lazy-loaded on demand.

```tsx
import { code } from '@streamdown/code';
import { createCodePlugin } from '@streamdown/code';

// Default
<Streamdown plugins={{ code }}>{markdown}</Streamdown>

// Custom themes
const code = createCodePlugin({ themes: ['github-light', 'github-dark'] });
```

Features: copy button on hover (disabled during streaming), download button with correct file extension, token caching, lazy language loading.

**Shiki warning in Next.js** — install `shiki` explicitly and add `transpilePackages: ['shiki']` to `next.config.js`.

### @streamdown/mermaid

Interactive Mermaid diagrams (flowcharts, sequence, state, class, pie, Gantt, ER, git graphs).

```tsx
import { mermaid } from '@streamdown/mermaid';
import { createMermaidPlugin } from '@streamdown/mermaid';

// Default
<Streamdown plugins={{ mermaid }}>{markdown}</Streamdown>

// Custom config
const mermaid = createMermaidPlugin({
  config: { theme: 'dark', fontFamily: 'monospace' },
});
```

Controls: fullscreen, download SVG, copy source, pan/zoom. Configure via `controls` prop:
```tsx
<Streamdown
  plugins={{ mermaid }}
  controls={{ mermaid: { download: true, copy: true, fullscreen: true, panZoom: false } }}
>
```

Custom error component:
```tsx
<Streamdown
  plugins={{ mermaid }}
  mermaid={{
    errorComponent: ({ error, chart, retry }) => (
      <div><p>Failed: {error}</p><button onClick={retry}>Retry</button></div>
    ),
  }}
>
```

### @streamdown/math

LaTeX math via KaTeX. **CSS import required.**

```tsx
import { math } from '@streamdown/math';
import { createMathPlugin } from '@streamdown/math';
import 'katex/dist/katex.min.css';

// Default (double $$ only)
<Streamdown plugins={{ math }}>{markdown}</Streamdown>

// Enable single $ syntax
const math = createMathPlugin({ singleDollarTextMath: true, errorColor: '#ff0000' });
```

Syntax: inline `$$E = mc^2$$`, block `$$\nE = mc^2\n$$`. Single `$` disabled by default to avoid currency conflicts.

### @streamdown/cjk

Chinese/Japanese/Korean text support. Fixes emphasis markers adjacent to ideographic punctuation and autolinks swallowing trailing CJK punctuation.

```tsx
import { cjk } from '@streamdown/cjk';

<Streamdown plugins={{ cjk }}>{markdown}</Streamdown>
```

## Streaming Features

### Carets

Visual cursor at end of streaming content. Both `caret` prop AND `isAnimating={true}` required.

```tsx
<Streamdown caret="block" isAnimating={isLoading}>{content}</Streamdown>
<Streamdown caret="circle" isAnimating={isLoading}>{content}</Streamdown>
```

Per-message in chat:
```tsx
{messages.map((msg, i) => (
  <Streamdown
    key={msg.id}
    caret="block"
    isAnimating={isLoading && i === messages.length - 1 && msg.role === 'assistant'}
  >
    {msg.content}
  </Streamdown>
))}
```

### Remend (Incomplete Markdown Completion)

Preprocessor that auto-completes incomplete Markdown during streaming: unclosed `**bold**`, `*italic*`, `` `code` ``, `~~strikethrough~~`, links, images, and `$$math$$`.

```tsx
// Disable
<Streamdown parseIncompleteMarkdown={false}>{content}</Streamdown>

// Configure
<Streamdown
  remend={{
    bold: true, italic: true, links: true, images: true,
    inlineCode: true, strikethrough: true, katex: true,
    linkMode: 'text-only', // 'protocol' | 'text-only'
  }}
>
```

Custom handlers:
```tsx
<Streamdown
  remend={{
    handlers: [{
      name: 'custom-syntax',
      handle: (text) => text.endsWith('<<') ? text + '>>' : null,
      priority: 100, // Lower = earlier (built-ins use 0-70)
    }],
  }}
>
```

### Interactive Controls

Auto-added buttons for images, tables, code, and Mermaid. All disabled during streaming when `isAnimating={true}`.

```tsx
// Disable all
<Streamdown controls={false}>{markdown}</Streamdown>

// Selective
<Streamdown controls={{ table: true, code: false, mermaid: { download: true, copy: true, fullscreen: true, panZoom: false } }}>
```

Button types: images (download), tables (copy CSV/TSV/HTML, download CSV/Markdown), code blocks (copy, download with extension), Mermaid (copy source, download SVG, fullscreen, pan/zoom).

## Styling

### CSS Variables

Streamdown uses shadcn/ui CSS variables. Override in `globals.css`:

```css
@layer base {
  :root {
    --primary: 222.2 47.4% 11.2%;        /* Links, accents */
    --primary-foreground: 210 40% 98%;    /* Text on primary */
    --muted: 210 40% 96.1%;              /* Code blocks, table headers */
    --muted-foreground: 215.4 16.3% 46.9%; /* Blockquote text */
    --border: 214.3 31.8% 91.4%;         /* Tables, rules, code blocks */
    --ring: 222.2 84% 4.9%;              /* Focus rings */
    --radius: 0.5rem;                     /* Border radius */
  }
  .dark {
    --primary: 210 40% 98%;
    --primary-foreground: 222.2 47.4% 11.2%;
    --muted: 217.2 32.6% 17.5%;
    --muted-foreground: 215 20.2% 65.1%;
    --border: 217.2 32.6% 17.5%;
    --ring: 212.7 26.8% 83.9%;
  }
}
```

### Data Attribute Selectors

Target elements via `[data-streamdown="..."]`:

```css
[data-streamdown="heading-1"] { }
[data-streamdown="heading-2"] { }
[data-streamdown="strong"] { }
[data-streamdown="link"] { }
[data-streamdown="inline-code"] { }
[data-streamdown="ordered-list"] { }
[data-streamdown="unordered-list"] { }
[data-streamdown="list-item"] { }
[data-streamdown="blockquote"] { }
[data-streamdown="code-block"] { }
[data-streamdown="mermaid-block"] { }
[data-streamdown="table-wrapper"] { }
[data-streamdown="table"] { }
```

### Custom Components

Override any Markdown element via the `components` prop:

```tsx
<Streamdown
  components={{
    h1: ({ children, ...props }) => (
      <h1 className="text-4xl font-bold" {...props}>{children}</h1>
    ),
    a: ({ children, href, ...props }) => (
      <a href={href} className="text-blue-500 hover:underline" {...props}>{children}</a>
    ),
    code: ({ children, className, ...props }) => {
      const isInline = !className;
      if (isInline) {
        return <code className="bg-gray-100 rounded px-1" {...props}>{children}</code>;
      }
      return <code className={className} {...props}>{children}</code>;
    },
  }}
>
```

Available elements: h1-h6, p, strong, em, ul, ol, li, a, code, pre, blockquote, table, thead, tbody, tr, th, td, img, hr, sup, sub, section.

### Custom HTML Tags

```tsx
<Streamdown
  allowedTags={{
    source: ["id"],
    mention: ["user_id", "type"],
    widget: ["data*"], // wildcard: all data-* attributes
  }}
  components={{
    source: (props) => <Badge>{props.id}</Badge>,
    mention: (props) => <UserMention userId={props.user_id} />,
  }}
>
  {markdown}
</Streamdown>
```

**Note:** `allowedTags` only works when using default rehype plugins.

## Security

### Default Security Posture

Streamdown is permissive by default (all prefixes, protocols, and data images allowed). Security is provided by rehype-sanitize (XSS prevention), rehype-harden (URL/protocol restriction), and link safety modal (confirmation before opening external links).

### Restricting Protocols and Domains

```tsx
import { defaultRehypePlugins } from 'streamdown';

<Streamdown
  rehypePlugins={[
    defaultRehypePlugins.raw,
    defaultRehypePlugins.sanitize,
    [defaultRehypePlugins.harden[0], {
      allowedProtocols: ['https', 'mailto'],
      allowedLinkPrefixes: ['https://your-domain.com'],
      allowedImagePrefixes: ['https://cdn.your-domain.com'],
      allowDataImages: false,
    }],
  ]}
>
```

### Link Safety Modal

```tsx
// Disable
<Streamdown linkSafety={{ enabled: false }}>{markdown}</Streamdown>

// Safelist trusted domains
<Streamdown
  linkSafety={{
    enabled: true,
    onLinkCheck: async (url) => {
      const trusted = ['example.com', 'docs.example.com'];
      return trusted.some((d) => new URL(url).hostname.endsWith(d));
    },
  }}
>

// Custom modal
<Streamdown
  linkSafety={{
    enabled: true,
    renderModal: ({ url, isOpen, onClose, onConfirm }) => (
      <Dialog open={isOpen} onOpenChange={onClose}>
        <DialogContent>
          <p>Open {url}?</p>
          <Button onClick={onConfirm}>Continue</Button>
          <Button onClick={onClose}>Cancel</Button>
        </DialogContent>
      </Dialog>
    ),
  }}
>
```

### Disabling HTML

```tsx
import { defaultRehypePlugins } from 'streamdown';

const { raw, ...rest } = defaultRehypePlugins;
<Streamdown rehypePlugins={Object.values(rest)}>{markdown}</Streamdown>
```

## Built-in Plugins

**Remark:** remark-gfm (tables, task lists, strikethrough, autolinks, footnotes).

**Rehype:** rehype-raw (preserves raw HTML), rehype-sanitize (XSS protection), rehype-harden (URL/protocol restrictions).

Customize:
```tsx
import { defaultRemarkPlugins, defaultRehypePlugins } from 'streamdown';

<Streamdown
  remarkPlugins={[...Object.values(defaultRemarkPlugins), myCustomPlugin]}
  rehypePlugins={[...Object.values(defaultRehypePlugins), anotherPlugin]}
>
```

## Default Exports

```tsx
import {
  Streamdown,
  defaultUrlTransform,    // URL passthrough (security handled by rehype plugins)
  defaultRemarkPlugins,   // { gfm: [remarkGfm, {}] }
  defaultRehypePlugins,   // { raw: rehypeRaw, sanitize: [rehypeSanitize, {}], harden: [harden, {...}] }
} from 'streamdown';

import type { AllowElement, Components, ExtraProps, UrlTransform } from 'streamdown';
```

## Example: Full-Featured AI Chat

```tsx
'use client';
import { useChat } from '@ai-sdk/react';
import { code } from '@streamdown/code';
import { math } from '@streamdown/math';
import { mermaid } from '@streamdown/mermaid';
import { Streamdown } from 'streamdown';
import 'katex/dist/katex.min.css';

export default function FullFeaturedChat() {
  const { messages, input, handleInputChange, handleSubmit, isLoading } = useChat();

  return (
    <div className="flex h-screen flex-col">
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {messages.map((message, index) => (
          <div key={message.id}>
            <Streamdown
              caret="block"
              controls={{ code: true, table: true, mermaid: { download: true, copy: true, fullscreen: true, panZoom: true } }}
              isAnimating={isLoading && index === messages.length - 1 && message.role === 'assistant'}
              linkSafety={{
                enabled: true,
                onLinkCheck: (url) => {
                  const trusted = ['github.com', 'npmjs.com'];
                  return trusted.some((d) => new URL(url).hostname.endsWith(d));
                },
              }}
              plugins={{ code, mermaid, math }}
            >
              {message.content}
            </Streamdown>
          </div>
        ))}
      </div>
      <form className="border-t p-4" onSubmit={handleSubmit}>
        <input
          className="w-full rounded-lg border px-4 py-2"
          disabled={isLoading}
          onChange={handleInputChange}
          placeholder="Ask me anything..."
          value={input}
        />
      </form>
    </div>
  );
}
```

## Example: Static Blog/Docs

```tsx
import { code } from '@streamdown/code';
import { math } from '@streamdown/math';
import { Streamdown } from 'streamdown';
import 'katex/dist/katex.min.css';

export default function BlogPost({ content }: { content: string }) {
  return (
    <Streamdown
      linkSafety={{ enabled: false }}
      mode="static"
      plugins={{ code, math }}
      shikiTheme={['github-light', 'github-dark']}
    >
      {content}
    </Streamdown>
  );
}
```

## Example: Strict Security for AI Content

```tsx
'use client';
import { code } from '@streamdown/code';
import { defaultRehypePlugins, Streamdown } from 'streamdown';

const rehypePlugins = [
  defaultRehypePlugins.raw,
  defaultRehypePlugins.sanitize,
  [defaultRehypePlugins.harden[0], {
    allowedProtocols: ['https', 'mailto'],
    allowedLinkPrefixes: ['https://your-domain.com', 'https://docs.your-domain.com'],
    allowedImagePrefixes: ['https://cdn.your-domain.com'],
    allowDataImages: false,
  }],
];

export default function SecureChat({ content }: { content: string }) {
  return (
    <Streamdown
      linkSafety={{
        enabled: true,
        onLinkCheck: (url) => {
          const trusted = ['your-domain.com'];
          return trusted.some((d) => new URL(url).hostname.endsWith(d));
        },
      }}
      plugins={{ code }}
      rehypePlugins={rehypePlugins}
    >
      {content}
    </Streamdown>
  );
}
```

## Performance

- **Component-level:** `React.memo` on Streamdown, re-renders only on children/shikiTheme/isAnimating changes
- **Block-level:** Content split into blocks, each memoized individually
- **Syntax highlighting:** Cached tokens, lazy-loaded languages, shared highlighter instance
- **Plugin arrays:** Create once at module level, not inside render

## Common Gotchas

1. **Tailwind styles missing** — Add `@source` directive or `content` entry for `node_modules/streamdown/dist/*.js`
2. **Math not rendering** — Import `katex/dist/katex.min.css`
3. **Caret not showing** — Both `caret` prop AND `isAnimating={true}` are required
4. **Copy buttons during streaming** — Disabled automatically when `isAnimating={true}`
5. **Link safety modal appearing** — Enabled by default; disable with `linkSafety={{ enabled: false }}`
6. **Shiki warning in Next.js** — Install `shiki` explicitly, add to `transpilePackages`
7. **`allowedTags` not working** — Only works with default rehype plugins
8. **Math uses `$$` not `$`** — Single dollar is disabled by default to avoid currency conflicts
9. **Vite SSR CSS loading error** — Add `ssr: { noExternal: ['streamdown'] }` to `vite.config.js`
10. **vscode-jsonrpc bundling errors (Next.js)** — Add `serverComponentsExternalPackages: ['vscode-jsonrpc']` and alias it to `false` in webpack config
