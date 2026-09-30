import type { StudioSettings } from '../config.ts'

/** Narrow faces of DSH's native configForms service; no private transport or storage. */
export interface FormSnapshot {
  status: 'loading' | 'ready' | 'unavailable'
  value: StudioSettings | undefined
  revision: number | undefined
  writable: boolean
  mode: 'host' | 'memory'
}
export interface SettingsOperation { op: 'set'; path: string[]; value: string | boolean | number[] }
export interface SettingsForm {
  getSnapshot(): FormSnapshot
  subscribe(listener: () => void): () => void
  mutate(ops: readonly SettingsOperation[], expectedRevision?: number): Promise<boolean>
}
export interface DescribeSnapshot {
  status: 'idle' | 'loading' | 'ready' | 'unavailable'
  view: { namespaces: readonly { ns: string; secrets: readonly { path: string[]; set: boolean }[] }[] } | undefined
}
export interface SettingsDescribe {
  getSnapshot(): DescribeSnapshot
  subscribe(listener: () => void): () => void
  ensure(): Promise<void>
}
export interface SettingsPanelProps { form: SettingsForm; describe: SettingsDescribe }
