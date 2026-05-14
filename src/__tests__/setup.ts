import { vi, beforeEach, afterEach } from 'vitest'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200 }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
