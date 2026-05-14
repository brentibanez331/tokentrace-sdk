# tokentrace-sdk

LLM observability for OpenAI, Anthropic, and Gemini. Trace every call with two lines of code.

## Install

```bash
npm install tokentrace-sdk
# or
bun add tokentrace-sdk
```

## Quickstart

```ts
import { init, wrapOpenAI } from 'tokentrace-sdk'
import OpenAI from 'openai'

init({
  apiKey: 'tt_prod_...',   // from your Tokentrace dashboard
  service: 'my-api',       // optional — groups traces by service
  env: 'production',       // optional — defaults to NODE_ENV
})

const openai = wrapOpenAI(new OpenAI())

const res = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello' }],
})
```

## Providers

### OpenAI

```ts
import { wrapOpenAI } from 'tokentrace-sdk'
import OpenAI from 'openai'

const openai = wrapOpenAI(new OpenAI())
```

Traces `chat.completions.create` — streaming and non-streaming.

### Anthropic

```ts
import { wrapAnthropic } from 'tokentrace-sdk'
import Anthropic from '@anthropic-ai/sdk'

const anthropic = wrapAnthropic(new Anthropic())
```

Traces `messages.create` — streaming and non-streaming.

### Gemini

```ts
import { wrapGeminiModel } from 'tokentrace-sdk'
import { GoogleGenerativeAI } from '@google/generative-ai'

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY!)
const model = wrapGeminiModel(genAI.getGenerativeModel({ model: 'gemini-pro' }))
```

Traces `generateContent` and `generateContentStream`.

## Options

```ts
init({
  apiKey: string           // required — get from dashboard
  endpoint?: string        // default: 'https://api.tokentrace.app'
  env?: string             // default: process.env.NODE_ENV
  service?: string         // default: '' — label for this service
  batchSize?: number       // default: 20 — flush after N events
  flushInterval?: number   // default: 2000ms — flush every N ms
  flushMode?: 'batch' | 'immediate'  // immediate = flush after every event
  disabled?: boolean       // default: true when NODE_ENV === 'test'
  onError?: (err: Error) => void     // surface transport/init errors without throwing
})
```

## Error handling

By default transport errors are swallowed silently so tracing never affects your app. Pass `onError` to receive them:

```ts
init({
  apiKey: 'tt_prod_...',
  onError: (err) => console.error('[tokentrace]', err.message),
})
```

Errors include: invalid API key (reported at init), failed ingest POST (reported after retries exhausted), and network failures.

## Attaching metadata

Use `tag()` to attach a `promptId`, `promptVersion`, or any custom key to all subsequent traces. Call before each LLM call or once globally.

```ts
import { tag } from 'tokentrace-sdk'

tag({ promptId: 'prm_abc123', promptVersion: '5' })
const res = await openai.chat.completions.create({ ... })

tag({}) // clear custom metadata, keep env/service
```

## Serverless (Vercel, Lambda, Netlify, Azure Functions)

The SDK detects serverless environments automatically and switches to `immediate` flush mode so every event is sent before the function returns.

If you override `flushMode: 'batch'` in a serverless context, call `flush()` at the end of your handler:

```ts
import { flush } from 'tokentrace-sdk'

export async function handler(req, res) {
  // ... your handler
  await flush()
}
```

## How it works

1. `wrapOpenAI(client)` / `wrapAnthropic(client)` / `wrapGeminiModel(model)` decorates the specific client instance directly — no prototype mutation, works in ESM and CJS
2. Each intercepted call captures: request body, response, token counts, latency, and prompt hash
3. Events are queued locally and flushed in batches to `POST /v1/ingest`
4. Failed sends retry up to 3 times with exponential backoff (100 ms → 200 ms → 400 ms)
5. Transport errors are never thrown into your code — use `onError` to observe them
