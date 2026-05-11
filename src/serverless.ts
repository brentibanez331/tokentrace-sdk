// Serverless runtimes freeze or kill the process after the response is sent.
// Background timers never fire, so batched events would be silently lost.
// Detection: check well-known env vars set by major platforms.
export function isServerless(): boolean {
  if (typeof process === 'undefined') return false
  const e = process.env
  return !!(
    e.VERCEL ||
    e.AWS_LAMBDA_FUNCTION_NAME ||
    e.NETLIFY ||
    e.FUNCTIONS_WORKER_RUNTIME // Azure Functions
  )
}
