/**
 * Integration test — sends a real prompt to OpenAI and verifies the SDK
 * intercepts it and would POST the trace event to the tokentrace ingest endpoint.
 *
 * Requires: OPENAI_API_KEY env var
 * Run: npm run test:integration
 */

import { describe, it, expect, vi, beforeAll } from 'vitest'
import * as openaiMod from 'openai'
import { patchOpenAI } from '../../providers/openai.js'
import type { State } from '../../types.js'

const SKIP = !process.env.OPENAI_API_KEY

describe.skipIf(SKIP)('OpenAI SDK integration', () => {
  const state: State = {
    opts: {
      apiKey: 'tt-test-key',
      endpoint: 'https://api.tokentrace.app',
      batchSize: 1,
      flushInterval: 2000,
      flushMode: 'immediate', // flush after every event so we can capture it
      disabled: false,
      env: 'test',
      service: 'integration',
    },
    queue: [],
    timer: null,
    pendingMeta: { env: 'test', service: 'integration' },
    initialized: true,
  }

  let capturedIngest: { events: unknown[] } | null = null

  beforeAll(() => {
    // Patch the real OpenAI prototype via injection (avoids require() ESM issue)
    patchOpenAI(state, openaiMod)

    // Selective fetch interceptor:
    //   - tokentrace ingest calls → capture and return 200 (no real network needed)
    //   - everything else (openai.com) → real fetch passthrough
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = url.toString()
      if (urlStr.includes('tokentrace')) {
        capturedIngest = JSON.parse(init?.body as string) as { events: unknown[] }
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return realFetch(url, init)
    })
  })

  it('intercepts a real OpenAI call and queues a trace event', async () => {
    const client = new openaiMod.OpenAI({ apiKey: process.env.OPENAI_API_KEY! })

    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a test assistant.' },
        { role: 'user', content: 'Reply with the single word: hello' },
      ],
      max_tokens: 10,
    })

    // Wait for the immediate flush to fire and hit the mock ingest endpoint
    await vi.waitFor(() => expect(capturedIngest).not.toBeNull(), { timeout: 10000 })

    // The real response came through correctly
    expect(response.choices[0].message.content).toBeTruthy()

    // The SDK captured the event and would have sent it to tokentrace
    const events = capturedIngest!.events as Array<{
      provider: string
      model: string
      output: string
      inputTokens: number
      outputTokens: number
      promptHash: string
      meta: Record<string, string>
    }>
    expect(events).toHaveLength(1)

    const event = events[0]
    expect(event.provider).toBe('openai')
    expect(event.model).toContain('gpt-4o-mini')
    expect(event.output.length).toBeGreaterThan(0)
    expect(event.inputTokens).toBeGreaterThan(0)
    expect(event.outputTokens).toBeGreaterThan(0)
    expect(event.promptHash).toMatch(/^[0-9a-f]{8}$/)
    expect(event.meta).toMatchObject({ env: 'test', service: 'integration' })
  }, 30000) // 30s timeout for real API call

  it('streaming call: intercepts and aggregates output', async () => {
    capturedIngest = null
    const client = new openaiMod.OpenAI({ apiKey: process.env.OPENAI_API_KEY! })

    const stream = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Count to three, one word per line.' }],
      max_tokens: 20,
      stream: true,
    }) as unknown as AsyncIterable<unknown>

    // Consume the stream — event is pushed only after the stream is exhausted
    let chunkCount = 0
    for await (const _ of stream) {
      chunkCount++
    }
    expect(chunkCount).toBeGreaterThan(0)

    await vi.waitFor(() => expect(capturedIngest).not.toBeNull(), { timeout: 10000 })

    const events = capturedIngest!.events as Array<{
      provider: string
      output: string
      inputTokens: number
    }>
    expect(events[0].provider).toBe('openai')
    expect(events[0].output.length).toBeGreaterThan(0)
  }, 30000)
})

describe.skipIf(!SKIP)('OpenAI SDK integration (no API key)', () => {
  it('skipped — set OPENAI_API_KEY to run integration tests', () => {
    console.log('ℹ  Skipping integration tests: OPENAI_API_KEY not set')
  })
})
