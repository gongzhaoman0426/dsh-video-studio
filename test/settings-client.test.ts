import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, inject, type SettingsClientContext } from '../src/client/index.ts'
import { buildOperations, createEditor, saveEditor, secretIsSaved, SETTINGS_NS } from '../src/client/model.ts'
import type { FormSnapshot, SettingsForm, SettingsOperation } from '../src/client/contracts.ts'

function snapshot(): FormSnapshot {
  return { status: 'ready', revision: 7, mode: 'host', writable: true, value: {
    source: 'settings',
    ark: { apiKey: 'must-never-prefill', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', imageModel: 'image', videoModel: 'video', imageReferences: false, videoReferences: false, videoDurations: [5, 10], imageSize: '' },
    tts: { apiKey: 'must-never-prefill-either', baseUrl: 'https://api.openai.com/v1', model: '', voice: '' },
  } }
}

test('settings drafts never copy API keys and blank password inputs preserve current keys', () => {
  const editor = createEditor(snapshot())!
  assert.equal(JSON.stringify(editor).includes('must-never-prefill'), false)
  assert.deepEqual(buildOperations(editor), [])
  editor.draft.ark.videoModel = 'new-video'
  editor.draft.secrets.ark.value = '   '
  assert.deepEqual(buildOperations(editor), [{ op: 'set', path: ['ark', 'videoModel'], value: 'new-video' }])
})

test('explicit key clearing writes empty string rather than restoring inherited keys', () => {
  const editor = createEditor(snapshot())!
  editor.draft.secrets.ark.clear = true
  editor.draft.secrets.tts.value = ' new-key '
  assert.deepEqual(buildOperations(editor), [
    { op: 'set', path: ['ark', 'apiKey'], value: '' },
    { op: 'set', path: ['tts', 'apiKey'], value: 'new-key' },
  ])
})

test('one atomic save keeps the editor revision even after the shared mirror changes', async () => {
  const editor = createEditor(snapshot())!
  editor.draft.ark.videoModel = 'new-video'
  editor.draft.secrets.ark.value = 'new-key'
  const calls: { ops: readonly SettingsOperation[]; revision?: number }[] = []
  const form: SettingsForm = {
    getSnapshot: () => ({ ...snapshot(), revision: 8 }), subscribe: () => () => {},
    mutate: async (ops, revision) => { calls.push({ ops, revision }); return false },
  }
  assert.equal(await saveEditor(form, editor), 'refused')
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.revision, 7)
  assert.deepEqual(calls[0]!.ops.map(op => op.path), [['ark', 'videoModel'], ['ark', 'apiKey']])
})

test('read-only and memory connections do not attempt settings writes', async () => {
  const editor = createEditor(snapshot())!
  editor.draft.ark.videoModel = 'new-video'
  for (const change of [{ writable: false }, { mode: 'memory' as const }]) {
    const form: SettingsForm = {
      getSnapshot: () => ({ ...snapshot(), ...change }), subscribe: () => () => {},
      mutate: async () => { assert.fail('must not write'); return true },
    }
    assert.equal(await saveEditor(form, editor), 'refused')
  }
})

test('switching to environment mode does not save hidden unfinished edits', () => {
  const editor = createEditor(snapshot())!
  editor.draft.source = 'environment'
  editor.draft.ark.videoModel = 'unfinished'
  editor.draft.ark.videoDurations = 'invalid'
  editor.draft.secrets.ark.value = 'unfinished-key'
  assert.deepEqual(buildOperations(editor), [{ op: 'set', path: ['source'], value: 'environment' }])
})

test('durations reject empty or invalid values before any mutation', () => {
  for (const invalid of ['', '0', '-1', '5.5', 'NaN', '121', '5,']) {
    const editor = createEditor(snapshot())!
    editor.draft.ark.videoDurations = invalid
    assert.throws(() => buildOperations(editor), /视频时长/)
  }
  const editor = createEditor(snapshot())!
  editor.draft.ark.videoDurations = '5，10 15'
  assert.deepEqual(buildOperations(editor), [{ op: 'set', path: ['ark', 'videoDurations'], value: [5, 10, 15] }])
})

test('secret presence comes only from the matching native describe namespace and path', () => {
  const view = { status: 'ready' as const, view: { namespaces: [
    { ns: 'unrelated', secrets: [{ path: ['tts', 'apiKey'], set: true }] },
    { ns: SETTINGS_NS, secrets: [{ path: ['ark', 'apiKey'], set: true }, { path: ['tts', 'apiKey'], set: false }] },
  ] } }
  assert.equal(secretIsSaved(view, 'ark'), true)
  assert.equal(secretIsSaved(view, 'tts'), false)
})

test('client only contributes the native settings tab while its namespace is served', () => {
  const registered: string[] = []
  const requested: string[] = []
  let stopped = false
  let cleanup: (() => void) | undefined
  const ctx: SettingsClientContext = {
    effect(effect) { cleanup = effect() },
    configForms: {
      get(ns) { requested.push(ns); return {} as SettingsForm }, describe() { return {} as ReturnType<SettingsClientContext['configForms']['describe']> },
      whileServed(namespaces, register) { assert.deepEqual(namespaces, [SETTINGS_NS]); return register() },
    },
    slots: {
      inject(name, register) { assert.equal(name, 'settings.plugins.tab'); return register() },
      register(options) { registered.push(options.name); assert.equal(options.id, SETTINGS_NS); options.inject(); return () => { stopped = true } },
    },
  }
  apply(ctx)
  assert.deepEqual(inject, ['slots', 'configForms'])
  assert.deepEqual(registered, ['settings.plugins.tab'])
  assert.deepEqual(requested, [SETTINGS_NS])
  cleanup!()
  assert.equal(stopped, true)
})
