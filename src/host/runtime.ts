import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { basename } from 'node:path'
import { WorkStore } from '../domain/store.ts'
import { MediaService } from '../media/service.ts'
import type { MediaProvider } from '../providers/types.ts'

export interface WorkspaceEntry { id: string; path: string; label: string }
export interface WorkspaceRuntime { entry: WorkspaceEntry; store: WorkStore; media: MediaService }
export interface StudioRuntimeOptions { providers?: () => MediaProvider[] }

/** Call-scoped workspace discovery; durable works and session bindings belong only to WorkStore. */
export class StudioRuntime {
  private readonly instances = new Map<string, WorkspaceRuntime>()
  private closed = false
  private disposal?: Promise<void>

  constructor(private readonly options: StudioRuntimeOptions = {}) {}

  async register(cwd: string): Promise<WorkspaceRuntime> {
    if (this.closed) throw new Error('工作室已停止')
    const path = await realpath(cwd)
    if (this.closed) throw new Error('工作室已停止')
    const id = createHash('sha256').update(path).digest('hex').slice(0, 24)
    let workspace = this.instances.get(id)
    if (!workspace) {
      const store = new WorkStore(path)
      workspace = { entry: { id, path, label: basename(path) || path }, store, media: new MediaService(store, { providers: this.options.providers }) }
      this.instances.set(id, workspace)
    }
    return workspace
  }

  async workspace(id: string): Promise<WorkspaceRuntime> {
    if (this.closed) throw new Error('工作室已停止')
    const workspace = this.instances.get(id)
    if (!workspace) throw new Error('未知工作区：请先在 DSH 会话中创建或打开作品')
    return workspace
  }

  async dispose(): Promise<void> {
    this.closed = true
    this.disposal ??= Promise.all([...this.instances.values()].map(workspace => workspace.media.dispose())).then(() => { this.instances.clear() })
    return this.disposal
  }
}
