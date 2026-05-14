import { describe, it, expect } from 'vitest'
import { hashPrompt } from '../hash.js'

describe('hashPrompt', () => {
  it('returns 8-char hex string', () => {
    const result = hashPrompt([{ role: 'system', content: 'You are helpful.' }])
    expect(result).toMatch(/^[0-9a-f]{8}$/)
  })

  it('is deterministic — same input, same hash', () => {
    const input = [{ role: 'system', content: 'You are helpful.' }]
    expect(hashPrompt(input)).toBe(hashPrompt(input))
  })

  it('produces different hashes for different system messages', () => {
    const a = hashPrompt([{ role: 'system', content: 'You are helpful.' }])
    const b = hashPrompt([{ role: 'system', content: 'You are a pirate.' }])
    expect(a).not.toBe(b)
  })

  it('concatenates multiple system messages before hashing', () => {
    const combined = hashPrompt([
      { role: 'system', content: 'Part one.' },
      { role: 'user', content: 'ignored' },
      { role: 'system', content: 'Part two.' },
    ])
    const single = hashPrompt([{ role: 'system', content: 'Part one.\nPart two.' }])
    expect(combined).toBe(single)
  })

  it('ignores non-system messages when system messages exist', () => {
    const withUser = hashPrompt([
      { role: 'system', content: 'System prompt.' },
      { role: 'user', content: 'User message A' },
    ])
    const differentUser = hashPrompt([
      { role: 'system', content: 'System prompt.' },
      { role: 'user', content: 'User message B' },
    ])
    expect(withUser).toBe(differentUser)
  })

  it('falls back to role names when no system message present', () => {
    const result = hashPrompt([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ])
    expect(result).toMatch(/^[0-9a-f]{8}$/)
    // Same roles, different content → same hash (roles-only fallback)
    const result2 = hashPrompt([
      { role: 'user', content: 'Different' },
      { role: 'assistant', content: 'Also different' },
    ])
    expect(result).toBe(result2)
  })

  it('JSON.stringify non-string system content', () => {
    const result = hashPrompt([{ role: 'system', content: { text: 'complex' } }])
    expect(result).toMatch(/^[0-9a-f]{8}$/)
    // Should differ from plain string version
    const stringVersion = hashPrompt([{ role: 'system', content: '{"text":"complex"}' }])
    expect(result).toBe(stringVersion)
  })
})
