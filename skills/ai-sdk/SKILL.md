---
name: ai-sdk
description: Vercel AI SDK expert guidance. Use when building AI-powered features — chat interfaces, text generation, structured output, tool calling, agents, MCP integration, streaming, embeddings, reranking, image generation, or working with any LLM provider.
---

# Vercel AI SDK (v6)

You are an expert in the Vercel AI SDK v6. The AI SDK is the leading TypeScript toolkit for building AI-powered applications. It provides a unified API across all LLM providers.

## Installation

```bash
npm install ai @ai-sdk/openai  # or @ai-sdk/anthropic, @ai-sdk/google, etc.
```

## Global Provider System

In AI SDK 6, reference models using `"provider/model"` format. The gateway provider is available from the `ai` package.

```ts
import { gateway } from 'ai'

const model = gateway('openai/gpt-5-mini')
// or: gateway('anthropic/claude-sonnet-4-6')
// or: gateway('google/gemini-2.5-flash')
```

When using the AI Gateway on Vercel, this automatically routes through the gateway with failover, cost tracking, and observability.

## Core Functions

### Text Generation
```ts
import { generateText, streamText } from 'ai'
import { openai } from '@ai-sdk/openai'

// Non-streaming
const { text } = await generateText({
  model: openai('gpt-5-mini'),
  prompt: 'Explain quantum computing in simple terms.',
})

// Streaming
const result = streamText({
  model: openai('gpt-5-mini'),
  prompt: 'Write a poem about coding.',
})

for await (const chunk of result.textStream) {
  process.stdout.write(chunk)
}
```

### Structured Output
```ts
import { generateText, Output } from 'ai'
import { z } from 'zod'

const { output } = await generateText({
  model: openai('gpt-5-mini'),
  output: Output.object({
    schema: z.object({
      recipe: z.object({
        name: z.string(),
        ingredients: z.array(z.object({
          name: z.string(),
          amount: z.string(),
        })),
        steps: z.array(z.string()),
      }),
    }),
  }),
  prompt: 'Generate a recipe for chocolate chip cookies.',
})
```

### Tool Calling (MCP-Aligned)

In AI SDK 6, tools use `inputSchema` (not `parameters`) and `output`/`outputSchema` (not `result`), aligned with the MCP specification.

```ts
import { generateText, tool } from 'ai'
import { z } from 'zod'

const result = await generateText({
  model: openai('gpt-5-mini'),
  tools: {
    weather: tool({
      description: 'Get the weather for a location',
      inputSchema: z.object({
        city: z.string().describe('The city name'),
      }),
      outputSchema: z.object({
        temperature: z.number(),
        condition: z.string(),
      }),
      execute: async ({ city }) => {
        const data = await fetchWeather(city)
        return { temperature: data.temp, condition: data.condition }
      },
    }),
  },
  prompt: 'What is the weather in San Francisco?',
})
```

### Dynamic Tools (MCP Integration)

For tools with schemas not known at compile time (e.g., MCP server tools):

```ts
import { dynamicTool } from 'ai'

const tools = {
  unknownTool: dynamicTool({
    description: 'A tool discovered at runtime',
    execute: async (input) => {
      // Handle dynamically
      return { result: 'done' }
    },
  }),
}
```

### Agents

The Agent class wraps `generateText`/`streamText` with agentic loop control:

```ts
import { Agent } from 'ai'

const agent = new Agent({
  model: openai('gpt-5-mini'),
  tools: { weather, search, calculator },
  system: 'You are a helpful assistant.',
  stopWhen: (context) => context.toolCalls.length === 0, // Stop when no tools called
  prepareStep: (context) => ({
    // Customize each step
    toolChoice: context.steps.length > 5 ? 'none' : 'auto',
  }),
})

const { text } = await agent.generateText({
  prompt: 'Research the weather in Tokyo and calculate the average temperature this week.',
})
```

### MCP Client

Connect to any MCP server and use its tools:

```ts
import { createMCPClient } from '@ai-sdk/mcp'

const mcpClient = await createMCPClient({
  transport: {
    type: 'sse',
    url: 'https://my-mcp-server.com/sse',
  },
})

const tools = await mcpClient.tools()

const result = await generateText({
  model: openai('gpt-5-mini'),
  tools,
  prompt: 'Use the available tools to help the user.',
})

await mcpClient.close()
```

MCP OAuth for remote servers is handled automatically by `@ai-sdk/mcp`.

### Embeddings & Reranking

```ts
import { embed, embedMany, rerank } from 'ai'

// Single embedding
const { embedding } = await embed({
  model: openai.embedding('text-embedding-3-small'),
  value: 'The quick brown fox',
})

// Batch embeddings
const { embeddings } = await embedMany({
  model: openai.embedding('text-embedding-3-small'),
  values: ['text 1', 'text 2', 'text 3'],
})

// Rerank search results by relevance
const { results } = await rerank({
  model: cohere.reranker('rerank-v3.5'),
  query: 'What is quantum computing?',
  documents: searchResults,
})
```

### Image Generation & Editing

```ts
import { generateImage, editImage } from 'ai'

const { image } = await generateImage({
  model: openai.image('dall-e-3'),
  prompt: 'A futuristic cityscape at sunset',
})

const { image: edited } = await editImage({
  model: openai.image('dall-e-3'),
  image: originalImage,
  prompt: 'Add flying cars to the scene',
})
```

## UI Hooks (React)

```tsx
'use client'
import { useChat, useCompletion, useObject } from '@ai-sdk/react'

// Chat interface
function Chat() {
  const { messages, input, handleInputChange, handleSubmit } = useChat()
  return (
    <div>
      {messages.map(m => <div key={m.id}>{m.role}: {m.content}</div>)}
      <form onSubmit={handleSubmit}>
        <input value={input} onChange={handleInputChange} />
      </form>
    </div>
  )
}
```

The `useChat` hook connects to a Route Handler or Server Action that uses `streamText`.

### Server-side for useChat
```ts
// app/api/chat/route.ts
import { streamText } from 'ai'
import { openai } from '@ai-sdk/openai'

export async function POST(req: Request) {
  const { messages } = await req.json()
  const result = streamText({
    model: openai('gpt-5-mini'),
    messages,
  })
  return result.toDataStreamResponse()
}
```

## Language Model Middleware

Intercept and transform model calls for RAG, guardrails, logging:

```ts
import { wrapLanguageModel } from 'ai'

const wrappedModel = wrapLanguageModel({
  model: openai('gpt-5-mini'),
  middleware: {
    transformParams: async ({ params }) => {
      // Inject RAG context, modify system prompt, etc.
      return { ...params, system: params.system + '\n\nContext: ...' }
    },
    wrapGenerate: async ({ doGenerate }) => {
      const result = await doGenerate()
      // Post-process, log, validate guardrails
      return result
    },
  },
})
```

## Provider Routing via AI Gateway

```ts
import { generateText } from 'ai'
import { gateway } from 'ai'

const result = await generateText({
  model: gateway('anthropic/claude-sonnet-4-6'),
  prompt: 'Hello!',
  providerOptions: {
    gateway: {
      order: ['bedrock', 'anthropic'],        // Try Bedrock first
      models: ['openai/gpt-5-mini'],           // Fallback model
      only: ['anthropic', 'bedrock'],          // Restrict providers
      user: 'user-123',                        // Usage tracking
      tags: ['feature:chat', 'env:production'], // Cost attribution
    },
  },
})
```

## DevTools

```bash
npx @ai-sdk/devtools
# Opens http://localhost:4983 — inspect LLM calls, agents, token usage, timing
```

## Key Patterns

1. **Always stream for user-facing AI** — use `streamText` + `useChat`, not `generateText`
2. **Use structured output** for extracting data — `generateText` with `Output.object()` and Zod schemas
3. **Use the Agent class** for multi-step reasoning — not manual loops
4. **Use DurableAgent** (from Workflow DevKit) for production agents that must survive crashes
5. **Use AI Gateway** for model routing and cost tracking in production
6. **Use `mcp-to-ai-sdk`** to generate static tool definitions from MCP servers for security

## Migration from AI SDK 5

Run `npx @ai-sdk/codemod v6` to auto-migrate. Key changes:
- `generateObject` / `streamObject` → `generateText` / `streamText` with `Output.object()`
- `parameters` → `inputSchema`
- `result` → `output`
- `CoreMessage` → `ModelMessage` (use `convertToModelMessages()`)
- `Experimental_Agent` → `ToolLoopAgent` (`system` → `instructions`)
- `experimental_createMCPClient` → `createMCPClient` (stable)
- UIMessage / ModelMessage types introduced

## Official Documentation

- [AI SDK Documentation](https://ai-sdk.dev/docs)
- [AI SDK Core](https://ai-sdk.dev/docs/ai-sdk-core)
- [AI SDK UI](https://ai-sdk.dev/docs/ai-sdk-ui)
- [Generating Text](https://ai-sdk.dev/docs/ai-sdk-core/generating-text)
- [Structured Data](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data)
- [Tools and Tool Calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)
- [Agents](https://ai-sdk.dev/docs/ai-sdk-core/agents)
- [Providers and Models](https://ai-sdk.dev/docs/foundations/providers-and-models)
- [Provider Directory](https://ai-sdk.dev/providers)
- [GitHub: AI SDK](https://github.com/vercel/ai)
