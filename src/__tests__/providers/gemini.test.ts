import { describe, it, expect, vi, beforeAll } from 'vitest'
import { patchGemini } from '../../providers/gemini.js'
import type { State } from '../../types.js'

// Mock GenerativeModel prototype — patchGemini wraps generateContent/generateContentStream on it
const mockGenerateContent = vi.fn()
const mockGenerateContentStream = vi.fn()
const modelProto = {
  generateContent: mockGenerateContent,
  generateContentStream: mockGenerateContentStream,
}

class MockGenerativeModel {
  model = 'gemini-pro'
  declare generateContent: (...args: unknown[]) => unknown
  declare generateContentStream: (...args: unknown[]) => unknown
  constructor() {
    Object.setPrototypeOf(this, modelProto)
  }
}

class MockGoogleGenerativeAI {
  getGenerativeModel(_opts: unknown) {
    return new MockGenerativeModel()
  }
}

const mockMod = { GoogleGenerativeAI: MockGoogleGenerativeAI }

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

describe('patchGemini', () => {
  let state: State

  beforeAll(() => {
    state = makeState()
    patchGemini(state, mockMod)
  })

  it('generateContent: pushes TraceEvent with correct shape', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => 'Generated text.',
        usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4 },
      },
    })

    const genAI = new MockGoogleGenerativeAI()
    const model = genAI.getGenerativeModel({ model: 'gemini-pro' })
    await model.generateContent('What is 2+2?')

    expect(state.queue).toHaveLength(1)
    const event = state.queue[0]
    expect(event.provider).toBe('gemini')
    expect(event.output).toBe('Generated text.')
    expect(event.inputTokens).toBe(8)
    expect(event.outputTokens).toBe(4)
    expect(event.promptHash).toBe('00000000')
    expect(event.meta).toMatchObject({ env: 'test', service: 'svc' })
  })

  it('generateContent: normalizes string input into array', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: { text: () => 'ok', usageMetadata: {} },
    })

    const genAI = new MockGoogleGenerativeAI()
    const model = genAI.getGenerativeModel({ model: 'gemini-pro' })
    state.queue.length = 0

    await model.generateContent('String prompt')

    expect(Array.isArray(state.queue[0].input)).toBe(true)
    expect(state.queue[0].input).toHaveLength(1)
  })

  it('generateContentStream: pushes event after stream is consumed', async () => {
    async function* fakeStream() {
      yield { text: () => 'chunk1', usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 } }
      yield { text: () => 'chunk2', usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 } }
    }
    mockGenerateContentStream.mockResolvedValueOnce({
      stream: fakeStream(),
      response: Promise.resolve({}),
    })

    const genAI = new MockGoogleGenerativeAI()
    const model = genAI.getGenerativeModel({ model: 'gemini-pro' })
    state.queue.length = 0

    const result = await (model.generateContentStream('Stream prompt') as Promise<{ stream: AsyncIterable<unknown> }>)

    expect(state.queue).toHaveLength(0) // not pushed until consumed

    for await (const _ of result.stream) { /* consume */ }

    expect(state.queue).toHaveLength(1)
    const event = state.queue[0]
    expect(event.output).toBe('chunk1chunk2')
    expect(event.inputTokens).toBe(5)
    expect(event.outputTokens).toBe(3)
  })

  it('metadata from pendingMeta attached to event', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: { text: () => 'ok', usageMetadata: {} },
    })

    const genAI = new MockGoogleGenerativeAI()
    const model = genAI.getGenerativeModel({ model: 'gemini-pro' })
    state.queue.length = 0
    state.pendingMeta = { env: 'prod', promptId: 'g-42' }

    await model.generateContent('hello')

    expect(state.queue[0].meta).toMatchObject({ promptId: 'g-42', env: 'prod' })
  })

  it('returns early if mod has no GoogleGenerativeAI export', () => {
    const state2 = makeState()
    expect(() => patchGemini(state2, {})).not.toThrow()
  })
})
