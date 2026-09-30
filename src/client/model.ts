import type { StudioSettings } from '../config.ts'
import type { DescribeSnapshot, FormSnapshot, SettingsForm, SettingsOperation } from './contracts.ts'

export const SETTINGS_NS = 'dsh-chapter-video-studio'
export type SecretEdit = { value: string; clear: boolean }
export interface SettingsDraft {
  source: StudioSettings['source']
  ark: Omit<StudioSettings['ark'], 'apiKey' | 'videoDurations'> & { videoDurations: string }
  tts: Omit<StudioSettings['tts'], 'apiKey'>
  secrets: { ark: SecretEdit; tts: SecretEdit }
}
export interface SettingsEditor { baseline: SettingsDraft; draft: SettingsDraft; revision: number; dirty: boolean }

/** Deliberately copy only public fields, even if a faulty transport returned a secret. */
export function createEditor(snapshot: FormSnapshot): SettingsEditor | undefined {
  if (snapshot.status !== 'ready' || !snapshot.value || snapshot.revision === undefined) return undefined
  const { source, ark, tts } = snapshot.value
  const draft: SettingsDraft = {
    source,
    ark: { baseUrl: ark.baseUrl, imageModel: ark.imageModel, videoModel: ark.videoModel,
      imageReferences: ark.imageReferences, videoReferences: ark.videoReferences,
      videoDurations: ark.videoDurations.join(', '), imageSize: ark.imageSize },
    tts: { baseUrl: tts.baseUrl, model: tts.model, voice: tts.voice },
    secrets: { ark: { value: '', clear: false }, tts: { value: '', clear: false } },
  }
  return { baseline: structuredClone(draft), draft, revision: snapshot.revision, dirty: false }
}

export function secretIsSaved(snapshot: DescribeSnapshot, provider: 'ark' | 'tts'): boolean {
  return snapshot.view?.namespaces.find(item => item.ns === SETTINGS_NS)?.secrets.some(
    item => item.path.length === 2 && item.path[0] === provider && item.path[1] === 'apiKey' && item.set,
  ) ?? false
}

export function buildOperations(editor: SettingsEditor): SettingsOperation[] {
  const { baseline, draft } = editor
  const operations: SettingsOperation[] = []
  const changed = (path: string[], before: unknown, after: SettingsOperation['value']) => {
    if (JSON.stringify(before) !== JSON.stringify(after)) operations.push({ op: 'set', path, value: after })
  }
  changed(['source'], baseline.source, draft.source)
  // Switching source does not save hidden, unfinished credential edits.
  if (draft.source === 'environment') return operations
  const durationParts = draft.ark.videoDurations.trim().split(/[,，\s]+/)
  const durations = durationParts.map(Number)
  if (durationParts.some(part => part === '') || durations.length > 120 || durations.some(value => !Number.isInteger(value) || value < 1 || value > 120)) {
    throw new Error('视频时长请填写 1–120 的整数，用逗号分隔。')
  }
  for (const key of ['baseUrl', 'imageModel', 'videoModel', 'imageReferences', 'videoReferences', 'imageSize'] as const) {
    changed(['ark', key], baseline.ark[key], draft.ark[key])
  }
  changed(['ark', 'videoDurations'], baseline.ark.videoDurations.split(/[,，\s]+/).map(Number), [...new Set(durations)])
  for (const key of ['baseUrl', 'model', 'voice'] as const) changed(['tts', key], baseline.tts[key], draft.tts[key])
  for (const provider of ['ark', 'tts'] as const) {
    const secret = draft.secrets[provider]
    if (secret.clear) operations.push({ op: 'set', path: [provider, 'apiKey'], value: '' })
    else if (secret.value.trim()) operations.push({ op: 'set', path: [provider, 'apiKey'], value: secret.value.trim() })
  }
  return operations
}

/** One revision-fenced transaction; refused writes never retry over somebody else's changes. */
export async function saveEditor(form: SettingsForm, editor: SettingsEditor): Promise<'saved' | 'unchanged' | 'refused'> {
  const snapshot = form.getSnapshot()
  if (!snapshot.writable || snapshot.mode !== 'host' || snapshot.status !== 'ready') return 'refused'
  const operations = buildOperations(editor)
  if (!operations.length) return 'unchanged'
  return await form.mutate(operations, editor.revision) ? 'saved' : 'refused'
}
