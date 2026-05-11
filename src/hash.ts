// Hash system messages only — they're the prompt template.
// User messages are dynamic per-call so excluding them means the same
// system prompt always produces the same hash regardless of user input.
export function hashPrompt(input: unknown[]): string {
  const messages = input as Array<{ role: string; content: unknown }>
  const systemContent = messages
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n')

  // Fall back to first message role structure if no system message
  const toHash = systemContent || messages.map((m) => m.role).join(',')
  return fnv1a(toHash)
}

// FNV-1a 32-bit — no crypto dependency, deterministic across runtimes
function fnv1a(str: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
