import { describe, it, expect, vi, beforeAll } from 'vitest'
import { patchAnthropic } from '../../providers/anthropic.js'
import type { State } from '../../types.js'

const mockCreate = vi.fn()
const messagesProto = { create: mockCreate }
class MockMessages {
  declare create: (...args: unknown[]) => unknown
  constructor() {
    Object.setPrototypeOf(this, messagesProto)
  }
}
class MockAnthropic {
  messages = new MockMessages()
}
const mockMod = { Anthropic: MockAnthropic }

function makeState(): State {
  return {
    opts: {
      apiKey: 'test-key',
      endpoint: 'https://example.com',
      batchSize: 20,
      flushInterval: 2000,
      flushMode: 'batch',
      disabled: false,
      env: 'test',
      service: 'svc',
    },
    queue: [],
    timer: null,
    pendingMeta: { env: 'test', service: 'svc' },
    initialized: true,
  }
}

describe('patchAnthropic', () => {
  let state: State

  beforeAll(() => {
    state = makeState()
    patchAnthropic(state, mockMod)
  })

  it('non-streaming: pushes TraceEvent with correct shape', async () => {
    mockCreate.mockResolvedValueOnce({
      model: 'claude-3-5-sonnet-20241022',
      content: [{ type: 'text', text: 'Hi there!' }],
      usage: { input_tokens: 12, output_tokens: 6 },
    })

    const client = new MockAnthropic()
    await (client.messages.create as (b: unknown) => Promise<unknown>)({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hello' }],
    })

    expect(state.queue).toHaveLength(1)
    const event = state.queue[0]
    expect(event.provider).toBe('anthropic')
    expect(event.model).toBe('claude-3-5-sonnet-20241022')
    expect(event.output).toBe('Hi there!')
    expect(event.inputTokens).toBe(12)
    expect(event.outputTokens).toBe(6)
    expect(event.meta).toMatchObject({ env: 'test', service: 'svc' })
  })

  it('non-streaming: extracts first text content block', async () => {
    mockCreate.mockResolvedValueOnce({
      model: 'claude-3-5-sonnet-20241022',
      content: [
        { type: 'tool_use', id: 't1' },
        { type: 'text', text: 'Final answer.' },
      ],
      usage: { input_tokens: 5, output_tokens: 3 },
    })

    const client = new MockAnthropic()
    state.queue.length = 0
    await (client.messages.create as (b: unknown) => Promise<unknown>)({
      model: 'claude-3-5-sonnet-20241022', max_tokens: 100, messages: [],
    })

    expect(state.queue[0].output).toBe('Final answer.')
  })

  it('streaming: accumulates text from content_block_delta events', async () => {
    async function* fakeStream() {
      yield { type: 'message_start', message: { usage: { input_tokens: 10 } } }
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } }
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: ' Claude' } }
      yield { type: 'message_delta', usage: { output_tokens: 7 } }
    }
    mockCreate.mockResolvedValueOnce(fakeStream())

    const client = new MockAnthropic()
    state.queue.length = 0

    const gen = await (client.messages.create as (b: unknown) => Promise<AsyncIterable<unknown>>)({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    })

    for await (const _ of gen) { /* consume */ }

    expect(state.queue).toHaveLength(1)
    const event = state.queue[0]
    expect(event.output).toBe('Hello Claude')
    expect(event.inputTokens).toBe(10)
    expect(event.outputTokens).toBe(7)
  })

  it('streaming: skips non-text delta types', async () => {
    async function* fakeStream() {
      yield { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{}' } }
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'text only' } }
      yield { type: 'message_delta', usage: { output_tokens: 2 } }
    }
    mockCreate.mockResolvedValueOnce(fakeStream())

    const client = new MockAnthropic()
    state.queue.length = 0

    const gen = await (client.messages.create as (b: unknown) => Promise<AsyncIterable<unknown>>)({
      model: 'claude-3-5-sonnet-20241022', max_tokens: 100, messages: [], stream: true,
    })

    for await (const _ of gen) { /* consume */ }

    expect(state.queue[0].output).toBe('text only')
  })

  it('metadata from pendingMeta is attached to event', async () => {
    mockCreate.mockResolvedValueOnce({
      model: 'claude-3-5-sonnet-20241022',
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    })

    const client = new MockAnthropic()
    state.queue.length = 0
    state.pendingMeta = { env: 'staging', promptId: 'p-999' }

    await (client.messages.create as (b: unknown) => Promise<unknown>)({
      model: 'claude-3-5-sonnet-20241022', max_tokens: 100, messages: [],
    })

    expect(state.queue[0].meta).toMatchObject({ promptId: 'p-999', env: 'staging' })
  })

  it('returns early if mod has no Anthropic export', () => {
    const state2 = makeState()
    expect(() => patchAnthropic(state2, {})).not.toThrow()
  })
})
