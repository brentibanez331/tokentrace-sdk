import { describe, it, expect, vi, afterEach } from 'vitest'
import { isServerless } from '../serverless.js'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('isServerless', () => {
  it('returns false with no serverless env vars', () => {
    // Remove all serverless markers
    vi.stubEnv('VERCEL', '')
    vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', '')
    vi.stubEnv('NETLIFY', '')
    vi.stubEnv('FUNCTIONS_WORKER_RUNTIME', '')
    expect(isServerless()).toBe(false)
  })

  it('returns true when VERCEL is set', () => {
    vi.stubEnv('VERCEL', '1')
    expect(isServerless()).toBe(true)
  })

  it('returns true when AWS_LAMBDA_FUNCTION_NAME is set', () => {
    vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', 'my-function')
    expect(isServerless()).toBe(true)
  })

  it('returns true when NETLIFY is set', () => {
    vi.stubEnv('NETLIFY', 'true')
    expect(isServerless()).toBe(true)
  })

  it('returns true when FUNCTIONS_WORKER_RUNTIME is set', () => {
    vi.stubEnv('FUNCTIONS_WORKER_RUNTIME', 'node')
    expect(isServerless()).toBe(true)
  })
})
