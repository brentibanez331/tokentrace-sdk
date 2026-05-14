import type { State, TraceEvent } from './types.js'

export function initQueue(state: State): void {
  if (state.opts.flushMode === 'batch') {
    scheduleTick(state)
  }

  if (typeof process !== 'undefined') {
    const drain = () => { void flush(state) }
    process.once('exit', drain)
    process.once('SIGTERM', drain)
    process.once('SIGINT', drain)
  }

  if (typeof globalThis.addEventListener === 'function') {
    globalThis.addEventListener('beforeunload', () => { void flush(state) })
  }
}

export function push(state: State, event: TraceEvent): void {
  if (state.opts.disabled) return
  state.queue.push(event)

  const shouldFlushNow =
    state.opts.flushMode === 'immediate' ||
    state.queue.length >= state.opts.batchSize

  if (shouldFlushNow) {
    void flush(state)
  }
}

export async function flush(state: State): Promise<void> {
  if (state.queue.length === 0) return
  const batch = state.queue.splice(0)
  await send(state, batch)
}

function scheduleTick(state: State): void {
  if (state.timer !== null) return
  state.timer = setTimeout(() => {
    state.timer = null
    void flush(state)
    scheduleTick(state)
  }, state.opts.flushInterval)

  // Don't keep the Node process alive just for this timer
  if (typeof state.timer === 'object' && state.timer !== null && 'unref' in state.timer) {
    (state.timer as NodeJS.Timeout).unref()
  }
}

async function send(state: State, events: TraceEvent[], attempt = 0): Promise<void> {
  try {
    const res = await fetch(`${state.opts.endpoint}/v1/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': state.opts.apiKey,
      },
      body: JSON.stringify({ events }),
    })
    // Retry on 5xx (server error), not on 4xx (bad key, rate limit, etc.)
    if (res.status >= 500 && attempt < 3) {
      await delay(100 * 2 ** attempt)
      return send(state, events, attempt + 1)
    }
    if (!res.ok) {
      state.opts.onError?.(new Error(`tokentrace ingest failed: ${res.status} ${res.statusText}`))
    }
  } catch (err) {
    // Network failure — retry up to 3 times
    if (attempt < 3) {
      await delay(100 * 2 ** attempt)
      return send(state, events, attempt + 1)
    }
    // All retries exhausted — report without surfacing into user code
    state.opts.onError?.(err instanceof Error ? err : new Error(String(err)))
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
