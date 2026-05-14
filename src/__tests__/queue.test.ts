import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { push, flush } from '../queue.js'
import type { State, TraceEvent } from '../types.js'

function makeState(overrides: Partial<State['opts']> = {}): State {
  return {
    opts: {
      apiKey: 'test-key',
      endpoint: 'https://example.com',
      batchSize: 5,
      flushInterval: 2000,
      flushMode: 'batch',
      disabled: false,
      env: 'test',
      service: '',
      ...overrides,
    },
    queue: [],
    timer: null,
    pendingMeta: {},
    initialized: true,
  }
}

function makeEvent(id = '1'): TraceEvent {
  return {
    id,
    ts: Date.now(),
    provider: 'openai',
    model: 'gpt-4o',
    input: [],
    output: 'hello',
    inputTokens: 10,
    outputTokens: 5,
    latencyMs: 100,
    promptHash: 'abc12345',
    meta: {},
  }
}

describe('push', () => {
  it('does nothing when disabled', () => {
    const state = makeState({ disabled: true })
    push(state, makeEvent())
    expect(state.queue).toHaveLength(0)
  })

  it('adds event to queue in batch mode', () => {
    const state = makeState({ flushMode: 'batch', batchSize: 5 })
    push(state, makeEvent())
    expect(state.queue).toHaveLength(1)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('flushes immediately when flushMode is immediate', async () => {
    const state = makeState({ flushMode: 'immediate' })
    push(state, makeEvent())
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
  })

  it('flushes when queue reaches batchSize', async () => {
    const state = makeState({ flushMode: 'batch', batchSize: 3 })
    push(state, makeEvent('1'))
    push(state, makeEvent('2'))
    expect(fetch).not.toHaveBeenCalled()
    push(state, makeEvent('3'))
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
  })
})

describe('flush', () => {
  it('does nothing when queue is empty', async () => {
    const state = makeState()
    await flush(state)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('sends events to /v1/ingest with correct headers', async () => {
    const state = makeState()
    const event = makeEvent()
    state.queue.push(event)
    await flush(state)
    expect(fetch).toHaveBeenCalledWith(
      'https://example.com/v1/ingest',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'x-api-key': 'test-key',
        }),
      }),
    )
  })

  it('includes events in request body', async () => {
    const state = makeState()
    const event = makeEvent()
    state.queue.push(event)
    await flush(state)
    const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string)
    expect(body.events).toHaveLength(1)
    expect(body.events[0].id).toBe('1')
  })

  it('empties queue after flush', async () => {
    const state = makeState()
    state.queue.push(makeEvent())
    await flush(state)
    expect(state.queue).toHaveLength(0)
  })
})

describe('send retry logic', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('retries up to 3 times on 5xx response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ status: 500 })
    vi.stubGlobal('fetch', mockFetch)

    const state = makeState()
    state.queue.push(makeEvent())

    const flushPromise = flush(state)
    await vi.runAllTimersAsync()
    await flushPromise

    // 1 original + 3 retries = 4 total
    expect(mockFetch).toHaveBeenCalledTimes(4)
  })

  it('does not retry on 4xx response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ status: 400 })
    vi.stubGlobal('fetch', mockFetch)

    const state = makeState()
    state.queue.push(makeEvent())

    const flushPromise = flush(state)
    await vi.runAllTimersAsync()
    await flushPromise

    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('retries on network error (fetch rejects)', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'))
    vi.stubGlobal('fetch', mockFetch)

    const state = makeState()
    state.queue.push(makeEvent())

    const flushPromise = flush(state)
    await vi.runAllTimersAsync()
    await flushPromise

    expect(mockFetch).toHaveBeenCalledTimes(4)
  })

  it('silently swallows error after all retries exhausted', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Permanent failure'))
    vi.stubGlobal('fetch', mockFetch)

    const state = makeState()
    state.queue.push(makeEvent())

    const flushPromise = flush(state)
    await vi.runAllTimersAsync()
    // Should not throw
    await expect(flushPromise).resolves.toBeUndefined()
  })

  it('succeeds on second attempt after 5xx', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({ status: 500 })
      .mockResolvedValueOnce({ status: 200 })
    vi.stubGlobal('fetch', mockFetch)

    const state = makeState()
    state.queue.push(makeEvent())

    const flushPromise = flush(state)
    await vi.runAllTimersAsync()
    await flushPromise

    expect(mockFetch).toHaveBeenCalledTimes(2)
  })
})
