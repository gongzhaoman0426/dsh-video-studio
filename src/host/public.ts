/** Signed result URLs stay in local task records, never in model-facing tool responses. */
export function publicJson(value: unknown): string {
  return JSON.stringify(value, (key, item: unknown) => key === 'remoteResult' ? undefined : item)
}
