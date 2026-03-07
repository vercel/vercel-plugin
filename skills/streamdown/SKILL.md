---
name: streamdown
description: Streamdown streaming-markdown expert guidance. Use when rendering streaming Markdown from AI models, building chat UIs with real-time content, or replacing react-markdown with a streaming-aware component.
metadata:
  priority: 4
  pathPatterns:
    - 'components/**/streamdown*'
    - 'src/components/**/streamdown*'
  importPatterns:
    - 'streamdown'
    - 'streamdown/*'
    - '@streamdown/*'
  bashPatterns:
    - '\bnpm\s+(install|i|add)\s+[^\n]*\bstreamdown\b'
    - '\bpnpm\s+(install|i|add)\s+[^\n]*\bstreamdown\b'
    - '\bbun\s+(install|i|add)\s+[^\n]*\bstreamdown\b'
    - '\byarn\s+add\s+[^\n]*\bstreamdown\b'
---

# Streamdown — Streaming Markdown for AI

You are an expert in Streamdown, Vercel's drop-in replacement for react-markdown designed for AI streaming. Streamdown gracefully handles incomplete or unterminated Markdown in real-time, providing smooth rendering during AI model output.

## Installation

```bash
npm install streamdown
```

**Tailwind v4** — add to your CSS:
```css
@source "../node_modules/streamdown/dist/*.js";
```

**Tailwind v3** — add to `content` array:
```js
content: ["./node_modules/streamdown/dist/*.js"]
```

## Core Usage

```tsx
import { Streamdown } from 'streamdown'
import 'streamdown/styles.css'

function ChatMessage({ content, isStreaming }: { content: string; isStreaming: boolean }) {
  return (
    <Streamdown isAnimating={isStreaming}>
      {content}
    </Streamdown>
  )
}
```

## Plugins

Streamdown uses a plugin architecture for extended functionality:

```tsx
import { Streamdown } from 'streamdown'
import { code } from '@streamdown/code'       // Syntax highlighting (Shiki)
import { math } from '@streamdown/math'       // KaTeX equations
import { mermaid } from '@streamdown/mermaid' // Mermaid diagrams
import { cjk } from '@streamdown/cjk'         // CJK language support

<Streamdown
  plugins={{
    code: code,
    math: math,
    mermaid: mermaid,
    cjk: cjk,
  }}
>
  {markdown}
</Streamdown>
```

### Plugin packages

| Package | Purpose |
|---|---|
| `@streamdown/code` | Syntax highlighting via Shiki |
| `@streamdown/math` | Math equations via KaTeX |
| `@streamdown/mermaid` | Mermaid diagram rendering |
| `@streamdown/cjk` | CJK language support |

## Controls

Enable interactive controls for code blocks, tables, and diagrams:

```tsx
<Streamdown
  controls={{
    table: true,
    code: true,
    mermaid: {
      download: true,
      copy: true,
      fullscreen: true,
      panZoom: true,
    },
  }}
>
  {markdown}
</Streamdown>
```

## Props Reference

| Prop | Type | Description |
|---|---|---|
| `children` | `string` | Markdown content to render |
| `isAnimating` | `boolean` | Show streaming cursor/animation |
| `plugins` | `object` | Plugin configuration |
| `controls` | `object` | Interactive controls config |
| `className` | `string` | Additional CSS class |

## Integration with AI SDK

```tsx
'use client'
import { useChat } from '@ai-sdk/react'
import { Streamdown } from 'streamdown'
import { code } from '@streamdown/code'
import 'streamdown/styles.css'

export function Chat() {
  const { messages, input, handleInputChange, handleSubmit, status } = useChat()

  return (
    <div>
      {messages.map((m) => (
        <div key={m.id}>
          <strong>{m.role}:</strong>
          <Streamdown
            isAnimating={status === 'streaming' && m.id === messages[messages.length - 1]?.id}
            plugins={{ code: code }}
          >
            {m.content}
          </Streamdown>
        </div>
      ))}
      <form onSubmit={handleSubmit}>
        <input value={input} onChange={handleInputChange} />
      </form>
    </div>
  )
}
```

## Key Rules

- **Requires React 18+** and **Tailwind CSS** for styling
- **Import styles** — always import `streamdown/styles.css` for animations
- **Use `isAnimating`** to show/hide the streaming cursor indicator
- **Plugins are tree-shakeable** — only import what you need
- **Security-first** — uses rehype-harden internally for safe HTML rendering
- **GFM support** — tables, task lists, strikethrough work out of the box
