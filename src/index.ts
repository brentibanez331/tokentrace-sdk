import { initQueue, flush as flushQueue } from './queue.js'
import { patchOpenAI } from './providers/openai.js'
import { patchAnthropic } from './providers/anthropic.js'
import { patchGemini } from './providers/gemini.js'
import { isServerless } from './serverless.js'
import type { InitOptions, State } from './types.js'

const state: State = {
  opts: {
    apiKey: '',
    endpoint: 'https://ingest.tokentrace.app',
    batchSize: 20,
    flushInterval: 2000,
    flushMode: 'batch',
    disabled: false,
    env: typeof process !== 'undefined' ? (process.env.NODE_ENV ?? 'production') : 'production',
    service: '',
  },
  queue: [],
  timer: null,
  pendingMeta: {},
  initialized: false,
}

export function init(opts: InitOptions): void {
  if (state.initialized) return

  state.opts = {
    apiKey: opts.apiKey,
    endpoint: opts.endpoint ?? 'https://ingest.tokentrace.app',
    batchSize: opts.batchSize ?? 20,
    flushInterval: opts.flushInterval ?? 2000,
    disabled: opts.disabled ?? (process.env.NODE_ENV === 'test'),
    flushMode: opts.flushMode ?? (isServerless() ? 'immediate' : 'batch'),
    env: opts.env ?? (typeof process !== 'undefined' ? (process.env.NODE_ENV ?? 'production') : 'production'),
    service: opts.service ?? '',
  }

  // Seed pendingMeta with global env + service so every event carries them
  state.pendingMeta = {
    ...(state.opts.env ? { env: state.opts.env } : {}),
    ...(state.opts.service ? { service: state.opts.service } : {}),
  }

  state.initialized = true

  patchOpenAI(state)
  patchAnthropic(state)
  patchGemini(state)

  initQueue(state)
}

// Merge metadata into all subsequent trace events. Call tag({}) to clear.
// Use to attach promptId, promptVersion, env, service, or any custom key.
export function tag(meta: Record<string, string>): void {
  state.pendingMeta = {
    env: state.opts.env,
    ...(state.opts.service ? { service: state.opts.service } : {}),
    ...meta,
  }
}

// Flush the event queue manually.
// Required at the end of serverless handlers if flushMode is overridden to 'batch'.
export async function flush(): Promise<void> {
  return flushQueue(state)
}

export type { InitOptions, TraceEvent, CallMeta } from './types.js'
