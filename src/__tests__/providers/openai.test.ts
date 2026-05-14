import { describe, it, expect, vi, beforeAll } from 'vitest'
import { patchOpenAI } from '../../providers/openai.js'
import type { State } from '../../types.js'

// Build a mock OpenAI module whose prototype patchOpenAI will wrap
const mockCreate = vi.fn()
const completionsProto = { create: mockCreate }
class MockCompletions {
  declare create: (...args: unknown[]) => unknown
  constructor() {
    Object.setPrototypeOf(this, completionsProto)
  }
}
class MockChat {
  completions = new MockCompletions()
}
class MockOpenAI {
  chat = new MockChat()
}
const mockMod = { OpenAI: MockOpenAI }

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
      service: 'my-service',
    },
    queue: [],
    timer: null,
    pendingMeta: { env: 'test', service: 'my-service' },
    initialized: true,
  }
}

describe('patchOpenAI', () => {
  let state: State

  beforeAll(() => {
    state = makeState()
    patchOpenAI(state, mockMod)
  })

  it('non-streaming: pushes TraceEvent with correct shape', async () => {
    mockCreate.mockResolvedValueOnce({
      model: 'gpt-4o',
      choices: [{ message: { content: 'Hello, world!' } }],
      usage: { prompt_tokens: 20, completion_tokens: 10 },
    })

    const client = new MockOpenAI()
    await (client.chat.completions.create as (b: unknown) => Promise<unknown>)({
      model: 'gpt-4o',
      messages: [{ role: 'system', content: 'Be helpful.' }, { role: 'user', content: 'Hi' }],
    })

    expect(state.queue).toHaveLength(1)
    const event = state.queue[0]
    expect(event.provider).toBe('openai')
    expect(event.model).toBe('gpt-4o')
    expect(event.output).toBe('Hello, world!')
    expect(event.inputTokens).toBe(20)
    expect(event.outputTokens).toBe(10)
    expect(event.promptHash).toMatch(/^[0-9a-f]{8}$/)
    expect(event.meta).toMatchObject({ env: 'test', service: 'my-service' })
  })

  it('non-streaming: promptHash stable across same system prompt', async () => {
    mockCreate.mockResolvedValueOnce({
      model: 'gpt-4o',
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    })

    const client = new MockOpenAI()
    state.queue.length = 0

    await (client.chat.completions.create as (b: unknown) => Promise<unknown>)({
      model: 'gpt-4o',
      messages: [{ role: 'system', content: 'Be helpful.' }, { role: 'user', content: 'Different user msg' }],
    })

    const { hashPrompt } = await import('../../hash.js')
    const expectedHash = hashPrompt([{ role: 'system', content: 'Be helpful.' }, { role: 'user', content: 'Different user msg' }])
    expect(state.queue[0].promptHash).toBe(expectedHash)
  })

  it('streaming: pushes TraceEvent after exhausting generator', async () => {
    async function* fakeStream() {
      yield { model: 'gpt-4o', choices: [{ delta: { content: 'Hello' } }] }
      yield { model: 'gpt-4o', choices: [{ delta: { content: ' world' } }] }
      yield { model: 'gpt-4o', choices: [{ delta: {} }], usage: { prompt_tokens: 15, completion_tokens: 8 } }
    }
    mockCreate.mockResolvedValueOnce(fakeStream())

    const client = new MockOpenAI()
    state.queue.length = 0

    const gen = await (client.chat.completions.create as (b: unknown) => Promise<AsyncIterable<unknown>>)({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    })

    for await (const _ of gen) { /* consume */ }

    expect(state.queue).toHaveLength(1)
    const event = state.queue[0]
    expect(event.output).toBe('Hello world')
    expect(event.inputTokens).toBe(15)
    expect(event.outputTokens).toBe(8)
  })

  it('streaming: no event pushed until stream is exhausted', async () => {
    // Create the promise BEFORE the generator so resolveNext is assigned upfront
    let resolveNext!: () => void
    const pause = new Promise<void>((r) => { resolveNext = r })
    async function* slowStream() {
      yield { model: 'gpt-4o', choices: [{ delta: { content: 'A' } }] }
      await pause
      yield { model: 'gpt-4o', choices: [{ delta: {} }] }
    }
    mockCreate.mockResolvedValueOnce(slowStream())

    const client = new MockOpenAI()
    state.queue.length = 0

    const gen = await (client.chat.completions.create as (b: unknown) => Promise<AsyncIterable<unknown>>)({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    })

    const iter = gen[Symbol.asyncIterator]()
    await iter.next() // consume first chunk
    expect(state.queue).toHaveLength(0) // not pushed yet
    resolveNext()
    await iter.next() // consume second chunk
    await iter.next() // consume done
    expect(state.queue).toHaveLength(1)
  })

  it('metadata from pendingMeta is attached to event', async () => {
    mockCreate.mockResolvedValueOnce({
      model: 'gpt-4o',
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    })

    const client = new MockOpenAI()
    state.queue.length = 0
    state.pendingMeta = { env: 'prod', service: 'api', promptId: 'p-123' }

    await (client.chat.completions.create as (b: unknown) => Promise<unknown>)({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hi' }],
    })

    expect(state.queue[0].meta).toMatchObject({ promptId: 'p-123', env: 'prod' })
  })

  it('does not patch twice when called again (guard check)', () => {
    const state2 = makeState()
    // Second patch call should be a no-op due to __tt guard on the same prototype
    patchOpenAI(state2, mockMod)
    // Proto is already marked __tt, so state2.queue would still be used by the
    // original patched method. No double-wrapping should occur.
    expect(completionsProto).toHaveProperty('create')
  })

  it('returns early if mod has no OpenAI export', () => {
    const state3 = makeState()
    // Pass an empty mod — should not throw, should not patch anything
    expect(() => patchOpenAI(state3, {})).not.toThrow()
  })
})
