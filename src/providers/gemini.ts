import { push } from '../queue.js'
import type { State, TraceEvent } from '../types.js'

// Gemini SDK structure:
//   const genAI = new GoogleGenerativeAI(apiKey)
//   const model = genAI.getGenerativeModel({ model: 'gemini-pro' })
//   await model.generateContent(prompt)          // non-streaming
//   await model.generateContentStream(prompt)    // streaming
//
// We patch GenerativeModel.prototype since getGenerativeModel returns instances of it.

export function patchGemini(state: State): void {
  let mod: { GoogleGenerativeAI?: new (...a: unknown[]) => unknown; default?: new (...a: unknown[]) => unknown }
  try {
    mod = require('@google/generative-ai')
  } catch {
    return
  }

  const GoogleGenerativeAI = (mod.GoogleGenerativeAI ?? mod.default) as
    | (new (apiKey: string) => { getGenerativeModel: (opts: unknown) => unknown })
    | undefined
  if (!GoogleGenerativeAI) return

  let tmp: ReturnType<InstanceType<typeof GoogleGenerativeAI>['getGenerativeModel']>
  try {
    tmp = new GoogleGenerativeAI('_').getGenerativeModel({ model: 'gemini-pro' })
  } catch {
    return
  }

  const proto = Object.getPrototypeOf(tmp) as Record<string, unknown>
  if (proto['__tt']) return
  proto['__tt'] = true

  const origGenerate = proto['generateContent'] as (this: unknown, req: unknown) => Promise<unknown>
  const origStream = proto['generateContentStream'] as (this: unknown, req: unknown) => Promise<unknown>

  proto['generateContent'] = async function patchedGenerate(this: { model?: string }, req: unknown) {
    const start = Date.now()
    const result = await origGenerate.call(this, req)
    push(state, buildEvent(start, this.model ?? '', req, result, false, state.pendingMeta))
    return result
  }

  proto['generateContentStream'] = async function patchedStream(this: { model?: string }, req: unknown) {
    const start = Date.now()
    const result = await origStream.call(this, req)
    const modelName = this.model ?? ''
    return wrapGeminiStream(result, start, modelName, req, state)
  }
}

function wrapGeminiStream(
  result: unknown,
  start: number,
  model: string,
  req: unknown,
  state: State,
): unknown {
  const original = result as { stream: AsyncIterable<unknown>; response: Promise<unknown> }

  async function* interceptedStream() {
    let output = ''
    let inputTokens = 0
    let outputTokens = 0

    for await (const chunk of original.stream) {
      const text = (chunk as { text?: () => string }).text?.() ?? ''
      output += text
      const usage = (chunk as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } })
        .usageMetadata
      if (usage) {
        inputTokens = usage.promptTokenCount ?? inputTokens
        outputTokens = usage.candidatesTokenCount ?? outputTokens
      }
      yield chunk
    }

    push(state, {
      id: uid(),
      ts: start,
      provider: 'gemini',
      model,
      input: normalizeGeminiInput(req),
      output,
      inputTokens,
      outputTokens,
      latencyMs: Date.now() - start,
      promptHash: '00000000', // Gemini uses a different message format; hash not meaningful here
      meta: { ...state.pendingMeta },
    })
  }

  return { stream: interceptedStream(), response: original.response }
}

function buildEvent(
  start: number,
  model: string,
  req: unknown,
  result: unknown,
  _streaming: boolean,
  meta: Record<string, string>,
): TraceEvent {
  const response = (result as { response?: unknown }).response
  const text = (response as { text?: () => string })?.text?.() ?? ''
  const usage = (response as {
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
  })?.usageMetadata

  return {
    id: uid(),
    ts: start,
    provider: 'gemini',
    model,
    input: normalizeGeminiInput(req),
    output: text,
    inputTokens: usage?.promptTokenCount ?? 0,
    outputTokens: usage?.candidatesTokenCount ?? 0,
    latencyMs: Date.now() - start,
    promptHash: '00000000',
    meta: { ...meta },
  }
}

function normalizeGeminiInput(req: unknown): unknown[] {
  if (typeof req === 'string') return [{ role: 'user', content: req }]
  if (Array.isArray(req)) return req
  const contents = (req as { contents?: unknown[] })?.contents
  return contents ?? [req]
}

function uid(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}
