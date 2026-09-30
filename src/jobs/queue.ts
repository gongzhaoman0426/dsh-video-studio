import { open, readFile, unlink, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

/** One worker per persisted job across processes; a live owner's lock is never stolen. */
export async function acquireJobLock(path: string): Promise<(() => Promise<void>) | undefined> {
  await mkdir(dirname(path), { recursive: true })
  for (let attempt = 0; attempt < 1; attempt++) {
    try {
      const file = await open(path, 'wx', 0o600)
      await file.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
      await file.close()
      return async () => { await unlink(path).catch(() => {}) }
    } catch (error: any) {
      if (error.code !== 'EEXIST') throw error
      try {
        const owner = JSON.parse(await readFile(path, 'utf8'))
        if (!Number.isInteger(owner.pid) || owner.pid <= 0) return undefined
        try { process.kill(owner.pid, 0); return undefined } catch (probe: any) { if (probe.code !== 'ESRCH') return undefined }
        // Automatically unlinking a stale path races another process acquiring the new lock.
        // Fail closed; recovery may remove it only after verifying no worker still owns this job.
        throw new Error(`Abandoned media worker lock (${path}); verify the old process is stopped and remove this lock before resuming`)
      } catch (error) { if (error instanceof Error && error.message.startsWith('Abandoned media worker lock')) throw error; return undefined }
    }
  }
  return undefined
}

export class TaskQueue {
  private tasks = new Map<string, { run: (signal: AbortSignal) => Promise<void>; controller: AbortController }>()
  private active = new Set<string>()
  private idle: Array<() => void> = []
  private disposed = false
  constructor(private concurrency = 2, private onError: (error: unknown) => void = () => {}) {}
  add(key: string, run: (signal: AbortSignal) => Promise<void>): void {
    if (this.disposed || this.tasks.has(key)) return
    this.tasks.set(key, { run, controller: new AbortController() })
    setImmediate(() => this.pump())
  }
  private pump(): void {
    for (const [key, task] of this.tasks) {
      if (this.active.size >= this.concurrency) break
      if (this.active.has(key)) continue
      this.active.add(key)
      task.run(task.controller.signal).catch(this.onError).finally(() => {
        this.active.delete(key); this.tasks.delete(key)
        if (!this.tasks.size) { this.idle.splice(0).forEach((resolve) => resolve()) }
        if (!this.disposed) this.pump()
      })
    }
  }
  interrupt(key: string): void { this.tasks.get(key)?.controller.abort() }
  async waitForIdle(): Promise<void> { if (!this.tasks.size) return; await new Promise<void>((resolve) => this.idle.push(resolve)) }
  dispose(): void {
    this.disposed = true
    for (const [key, task] of this.tasks) { task.controller.abort(); if (!this.active.has(key)) this.tasks.delete(key) }
    if (!this.tasks.size) this.idle.splice(0).forEach((resolve) => resolve())
  }
}

export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('Worker interrupted'))
    const stop = () => { clearTimeout(timer); reject(new Error('Worker interrupted')) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve() }, ms)
    signal.addEventListener('abort', stop, { once: true })
  })
}
