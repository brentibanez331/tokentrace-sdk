import { hashPrompt } from '../hash.js'
import { push } from '../queue.js'
import type { State, TraceEvent } from '../types.js'

export function patchAnthropic(state: State, injectedMod?: unknown): void {
  let mod: { Anthropic?: new (...a: unknown[]) => unknown; default?: new (...a: unknown[]) => unknown }
  try {
    mod = (injectedMod ?? require('@anthropic-ai/sdk')) as typeof mod
  } catch {
    return
  }

  const Anthropic = (mod.Anthropic ?? mod.default) as (new (opts: Record<string, unknown>) => unknown) | undefined
  if (!Anthropic) return

  let tmp: { messages: unknown }
  try {
    tmp = new Anthropic({ apiKey: '_' }) as typeof tmp
  } catch {
    return
  }

  const proto = Object.getPrototypeOf(tmp.messages) as Record<string, unknown>
  if (proto['__tt']) return
  proto['__tt'] = true

  const orig = proto['create'] as (this: unknown, body: unknown, opts?: unknown) => unknown
  proto['create'] = function patchedCreate(this: unknown, body: Record<string, unknown>, options?: unknown) {
    if (body?.stream) {
      return Promise.resolve(streamInterceptor(this, orig, state, body, options))
    }

    const start = Date.now()
    return (orig.call(this, body, options) as Promise<Record<string, unknown>>).then((res) => {
      push(state, buildEvent(start, body, res, state.pendingMeta))
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
  let inputTokens = 0
  let outputTokens = 0

  for await (const event of stream) {
    const type = event.type as string
    if (type === 'content_block_delta') {
      const delta = (event as { delta?: { type?: string; text?: string } }).delta
      if (delta?.type === 'text_delta' && delta.text) output += delta.text
    } else if (type === 'message_start') {
      const msg = (event as { message?: { usage?: { input_tokens?: number } } }).message
      inputTokens = msg?.usage?.input_tokens ?? inputTokens
    } else if (type === 'message_delta') {
      const usage = (event as { usage?: { output_tokens?: number } }).usage
      outputTokens = usage?.output_tokens ?? outputTokens
    }
    yield event
  }

  push(state, {
    id: uid(),
    ts: start,
    provider: 'anthropic',
    model: (body.model as string) ?? '',
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
  start: number,
  body: Record<string, unknown>,
  res: Record<string, unknown>,
  meta: Record<string, string>,
): TraceEvent {
  const usage = res.usage as { input_tokens?: number; output_tokens?: number } | undefined
  const content = res.content as Array<{ type: string; text?: string }> | undefined
  const text = content?.find((b) => b.type === 'text')?.text ?? ''
  return {
    id: uid(),
    ts: start,
    provider: 'anthropic',
    model: (res.model as string) ?? (body.model as string) ?? '',
    input: (body.messages as unknown[]) ?? [],
    output: text,
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    latencyMs: Date.now() - start,
    promptHash: hashPrompt((body.messages as unknown[]) ?? []),
    meta: { ...meta },
  }
}

function uid(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}
