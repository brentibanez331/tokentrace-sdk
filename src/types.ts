export type Provider = 'openai' | 'anthropic' | 'gemini'

export type TraceEvent = {
  id: string
  ts: number
  provider: Provider
  model: string
  input: unknown[]
  output: string
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  latencyMs: number
  promptHash: string
  meta: Record<string, string>
}

export type FlushMode = 'batch' | 'immediate'

export type InitOptions = {
  apiKey: string
  endpoint?: string
  batchSize?: number
  flushInterval?: number
  flushMode?: FlushMode
  disabled?: boolean
  env?: string
  service?: string
  onError?: (err: Error) => void
}

export type ResolvedOptions = Required<Omit<InitOptions, 'env' | 'service' | 'onError'>> & {
  env: string
  service: string
  onError?: (err: Error) => void
}

export type CallMeta = {
  promptId?: string
  promptVersion?: number
  env?: string
  service?: string
}

export type State = {
  opts: ResolvedOptions
  queue: TraceEvent[]
  timer: ReturnType<typeof setTimeout> | null
  pendingMeta: Record<string, string>
  initialized: boolean
}
