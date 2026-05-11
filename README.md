# tokentrace

LLM observability for OpenAI, Anthropic, and Gemini. Drop in one `init` call — every LLM call in your app is automatically traced.

## Install

```bash
npm install tokentrace
# or
bun add tokentrace
```

## Quickstart (~60 seconds)

```ts
import { init } from 'tokentrace'
import OpenAI from 'openai'

init({
  apiKey: 'tt_prod_...',   // from your Tokentrace dashboard
  service: 'svc/my-api',  // optional — groups traces by service
  env: 'production',      // optional — defaults to NODE_ENV
})

// Nothing else changes. All OpenAI/Anthropic/Gemini calls are traced automatically.
const openai = new OpenAI()
const res = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello' }],
})
```

## Options

```ts
init({
  apiKey: string           // required — get from dashboard
  endpoint?: string        // default: 'https://ingest.tokentrace.dev'
  env?: string             // default: process.env.NODE_ENV
  service?: string         // default: '' — label for this service
  batchSize?: number       // default: 20 — flush after N events
  flushInterval?: number   // default: 2000ms — flush every N ms
  flushMode?: 'batch' | 'immediate'  // immediate = flush after every event
  disabled?: boolean       // default: true when NODE_ENV === 'test'
})
```

## Attaching prompt metadata

Use `tag()` to attach a `promptId`, `promptVersion`, or any custom metadata to all subsequent traces. Call it before each LLM call or once globally.

```ts
import { tag } from 'tokentrace'

tag({ promptId: 'prm_abc123', promptVersion: '5' })
const res = await openai.chat.completions.create({ ... })

tag({}) // clear
```

## Serverless (Vercel, Lambda, Netlify, Azure Functions)

The SDK detects serverless environments automatically and switches to immediate flush mode. In immediate mode each event is sent before the function returns.

If you override `flushMode: 'batch'` in a serverless context, call `flush()` at the end of your handler:

```ts
import { flush } from 'tokentrace'

export async function handler(req, res) {
  // ... your handler
  await flush() // ensure events are sent before freeze
}
```

## Providers

| Provider | Auto-patched method |
|----------|-------------------|
| OpenAI | `chat.completions.create` (streaming + non-streaming) |
| Anthropic | `messages.create` (streaming + non-streaming) |
| Gemini | `generateContent` |

All providers are optional peer dependencies — only the ones you have installed are patched.

## How it works

1. `init()` monkey-patches the LLM provider SDK prototypes once
2. Every call is intercepted: request body, response, token counts, and latency are captured
3. Events are queued locally and flushed in batches to `POST /v1/ingest`
4. Transport errors are swallowed silently — your app is never affected
5. Failed sends retry up to 3 times with exponential backoff (100ms, 200ms, 400ms)
