import { hashPrompt } from '../hash.js'
import { push } from '../queue.js'
import type { State, TraceEvent } from '../types.js'

export function patchOpenAI(state: State, injectedMod?: unknown): void {
  let mod: { OpenAI?: new (...a: unknown[]) => unknown; default?: new (...a: unknown[]) => unknown }
  try {
    // require works in CJS; tsup --shims makes it available in ESM builds too
    mod = (injectedMod ?? require('openai')) as typeof mod
  } catch {
    return
  }

  const OpenAI = (mod.OpenAI ?? mod.default) as (new (opts: Record<string, unknown>) => unknown) | undefined
  if (!OpenAI) return

  let tmp: { chat: { completions: unknown } }
  try {
    tmp = new OpenAI({ apiKey: '_', dangerouslyAllowBrowser: true }) as typeof tmp
  } catch {
    return
  }

  const proto = Object.getPrototypeOf(tmp.chat.completions) as Record<string, unknown>
  if (proto['__tt']) return
  proto['__tt'] = true

  const orig = proto['create'] as (this: unknown, body: unknown, opts?: unknown) => unknown
  proto['create'] = function patchedCreate(this: unknown, body: Record<string, unknown>, options?: unknown) {
    if (body?.stream) {
      // Return a Promise resolving to our intercepting async generator.
      // Covers the common `for await (const chunk of await stream)` pattern.
      // Note: toReadableStream() and other Stream-specific methods are not available.
      return Promise.resolve(streamInterceptor(this, orig, state, body, options))
    }

    const start = Date.now()
    const result = (orig.call(this, body, options) as Promise<Record<string, unknown>>)
    return result.then((res) => {
      push(state, buildEvent('openai', start, body, res, state.pendingMeta))
      return res
    })
  }
}

async function* streamInterceptor(
  ctx: unknown,
  orig: (this: unknown, body: unknown, opts?: unknown) => unknown,
  state: State,
  body: Record<string, unknown>,
  options: unknown,
): AsyncGenerator<unknown> {
  const start = Date.now()
  const stream = await (orig.call(ctx, body, options) as Promise<AsyncIterable<Record<string, unknown>>>)

  let output = ''
  let model = (body.model as string) ?? ''
  let inputTokens = 0
  let outputTokens = 0

  for await (const chunk of stream) {
    model = (chunk.model as string) ?? model
    const content = (chunk as { choices?: Array<{ delta?: { content?: string } }> })
      .choices?.[0]?.delta?.content
    if (content) output += content
    const usage = (chunk as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage
    if (usage) {
      inputTokens = usage.prompt_tokens ?? inputTokens
      outputTokens = usage.completion_tokens ?? outputTokens
    }
    yield chunk
  }

  push(state, {
    id: uid(),
    ts: start,
    provider: 'openai',
    model,
    input: (body.messages as unknown[]) ?? [],
    output,
    inputTokens,
    outputTokens,
    latencyMs: Date.now() - start,
    promptHash: hashPrompt((body.messages as unknown[]) ?? []),
    meta: { ...state.pendingMeta },
  })
}

function buildEvent(
  provider: 'openai',
  start: number,
  body: Record<string, unknown>,
  res: Record<string, unknown>,
  meta: Record<string, string>,
): TraceEvent {
  const usage = res.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined
  const choices = res.choices as Array<{ message?: { content?: string } }> | undefined
  return {
    id: uid(),
    ts: start,
    provider,
    model: (res.model as string) ?? (body.model as string) ?? '',
    input: (body.messages as unknown[]) ?? [],
    output: choices?.[0]?.message?.content ?? '',
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    latencyMs: Date.now() - start,
    promptHash: hashPrompt((body.messages as unknown[]) ?? []),
    meta: { ...meta },
  }
}

function uid(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}
