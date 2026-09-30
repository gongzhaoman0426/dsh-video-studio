#!/usr/bin/env node
/** Real Loader + Settings integration; every profile, secret and work is temporary. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const harnessRoot = process.argv[2]
if (!harnessRoot) throw new Error('Usage: node scripts/dsh-settings-smoke.mjs /absolute/path/to/built/deepseek-harness')
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await realpath(await mkdtemp(join(tmpdir(), 'chapter-video-settings-smoke-')))
const home = join(temporary, 'home')
const cwd = join(temporary, 'workspace')
const namespace = 'dsh-chapter-video-studio'
const fakeArkSecret = 'settings-smoke-ark-secret-not-a-real-key'
const fakeTtsSecret = 'settings-smoke-tts-secret-not-a-real-key'
const environment = {
  DSH_HOME: home,
  DSH_VIDEO_ARK_API_KEY: 'settings-smoke-environment-key-not-a-real-key',
  DSH_VIDEO_ARK_BASE_URL: 'https://provider.example.invalid/v3',
  DSH_VIDEO_ARK_IMAGE_MODEL: 'environment-image-smoke',
  DSH_VIDEO_ARK_VIDEO_MODEL: 'environment-video-smoke',
  DSH_VIDEO_TTS_API_KEY: 'settings-smoke-environment-tts-not-a-real-key',
  DSH_VIDEO_TTS_BASE_URL: 'https://speech.example.invalid/v1',
  DSH_VIDEO_TTS_MODEL: 'environment-tts-smoke',
  DSH_VIDEO_TTS_VOICE: 'environment-voice-smoke',
}
const previousEnvironment = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]))
Object.assign(process.env, environment)
const originalFetch = globalThis.fetch
let networkCalls = 0
globalThis.fetch = async () => { networkCalls += 1; throw new Error('Settings smoke forbids network requests') }
let ctx
let executions = 0
try {
  await mkdir(cwd, { recursive: true })
  await mkdir(home, { recursive: true })
  const importHarness = path => import(pathToFileURL(join(resolve(harnessRoot), path)).href)
  const [{ boot, initProfile, readProfilePatches }, { default: ConfigEditor }, { default: Settings }, { default: SystemPrompt }, { default: Tools }, { default: Skills }, plugin] = await Promise.all([
    importHarness('packages/boot/app-boot/lib/index.js'),
    importHarness('packages/boot/config-editor/lib/index.js'),
    importHarness('packages/settings/settings/lib/index.js'),
    importHarness('packages/core/system-prompt/lib/index.js'),
    importHarness('packages/core/tools/lib/index.js'),
    importHarness('packages/skill/skill/lib/index.js'),
    import(pathToFileURL(join(projectRoot, 'lib/index.js')).href),
  ])
  assert.ok(plugin.Config, 'The plugin exports a native DSH Config schema')
  const dir = join(home, 'profiles', 'test')
  initProfile(dir, ['chapter-video-smoke-bundle'])
  const bundle = join(dir, 'node_modules', 'chapter-video-smoke-bundle')
  await mkdir(bundle, { recursive: true })
  await writeFile(join(home, 'package.json'), '{"name":"chapter-video-settings-smoke"}\n')
  await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'chapter-video-smoke-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  await writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'settings', name: 'cordis:settings' },
    { id: 'system-prompt', name: 'cordis:system-prompt' },
    { id: 'tools', name: 'cordis:tools', config: { mode: 'native' } },
    { id: 'skills', name: 'cordis:skills' },
    { id: namespace, name: 'cordis:chapter-video-studio' },
  ] }]))
  await writeFile(join(dir, 'cordis.yml'), '[]\n')
  const profile = {
    name: 'test', startedBundles: ['chapter-video-smoke-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'), cwd, home, overlays: [], telemetryDisabledEnv: undefined,
  }
  const start = () => boot('settings-smoke', join(dir, 'cordis.yml'), readProfilePatches('settings-smoke', profile), host => {
    host.provide('profileContext', profile)
    host.provide('appReady', { onReady: listener => { listener(); return () => {} } })
    Object.assign(host.loader.builtins, { editor: ConfigEditor, settings: Settings, 'system-prompt': SystemPrompt, tools: Tools, skills: Skills, 'chapter-video-studio': plugin })
  })
  const view = () => {
    const result = ctx.settings.describe({ redactSecrets: true }).find(row => row.ns === namespace)
    assert.ok(result, 'Settings discovers the active plugin by its Loader entry id')
    return result
  }
  const entry = () => [...ctx.loader.entries()].find(row => row.options.id === namespace)
  const call = async (name, args) => {
    const outcome = await ctx.tools.execute({ name: `video_studio_${name}`, arguments: args, agent: { session: { id: 'settings-smoke-session', header: { cwd } } }, callId: `settings_smoke_${++executions}`, signal: new AbortController().signal })
    assert.equal(outcome.isError, false, `Real DSH tool ${name} succeeds`)
    assert.ok(outcome.value && typeof outcome.value === 'object')
    return outcome.value
  }
  const provider = (context, id) => {
    const result = context.capabilities.providers.find(row => row.id === id)
    assert.ok(result, `Diagnostics exposes provider ${id}`)
    return result
  }
  const assertNoSecrets = value => {
    const rendered = JSON.stringify(value)
    for (const secret of [fakeArkSecret, fakeTtsSecret, environment.DSH_VIDEO_ARK_API_KEY, environment.DSH_VIDEO_TTS_API_KEY]) assert.ok(!rendered.includes(secret), 'Public data must not contain a credential')
  }

  ctx = await start()
  const initial = view()
  assert.equal(initial.value.source, 'settings')
  assert.ok(initial.secrets.some(item => item.path.join('.') === 'ark.apiKey' && item.set === false))
  assert.ok(initial.secrets.some(item => item.path.join('.') === 'tts.apiKey' && item.set === false))
  assert.equal(initial.value.ark.apiKey, undefined, 'Secret values are omitted, including their empty defaults')
  const originalFiber = entry().fiber
  const sourceRef = originalFiber.config.source
  const modelRef = originalFiber.config.ark.videoModel
  assert.equal(typeof modelRef.get, 'function', 'Loader supplies real live Volatile references')
  let updates = 0
  const stop = originalFiber.ctx.on('loader/volatile-update', () => { updates += 1 })
  const created = await call('work', { action: 'create', title: 'DSH settings smoke', style: 'preview', aspectRatio: '16:9' })
  const workId = created.work.id
  const unconfigured = await call('context', { workId })
  assert.equal(provider(unconfigured, 'ark').configured, false, 'Settings mode must not silently use environment secrets')

  await ctx.settings.mutate(namespace, [
    { op: 'set', path: ['ark', 'apiKey'], value: fakeArkSecret },
    { op: 'set', path: ['ark', 'imageModel'], value: 'settings-image-smoke' },
    { op: 'set', path: ['ark', 'videoModel'], value: 'settings-video-smoke' },
    { op: 'set', path: ['tts', 'apiKey'], value: fakeTtsSecret },
    { op: 'set', path: ['tts', 'model'], value: 'settings-tts-smoke' },
    { op: 'set', path: ['tts', 'voice'], value: 'settings-voice-smoke' },
  ], initial.revision)
  assert.equal(entry().fiber, originalFiber, 'A volatile-only settings edit must not remount the plugin')
  assert.equal(modelRef.get(), 'settings-video-smoke')
  assert.ok(updates > 0, 'Loader emits the volatile update notification')
  const edited = view()
  assert.ok(edited.revision > initial.revision)
  assert.ok(edited.secrets.some(item => item.path.join('.') === 'ark.apiKey' && item.set === true))
  assert.ok(edited.secrets.some(item => item.path.join('.') === 'tts.apiKey' && item.set === true))
  assertNoSecrets(edited)
  const configured = await call('context', { workId })
  assert.equal(provider(configured, 'ark').models.video, 'settings-video-smoke', 'Existing workspace diagnostics sees the committed model')
  assert.equal(provider(configured, 'ark').configured, true)
  assert.equal(provider(configured, 'compatible-tts').models.audio, 'settings-tts-smoke')
  assert.equal(provider(configured, 'compatible-tts').configured, true)
  assertNoSecrets(configured)
  const persisted = await readFile(profile.patchPath, 'utf8')
  assert.ok(persisted.includes('settings-video-smoke'), 'Native profile patch persists ordinary configuration')
  assert.ok(persisted.includes(fakeArkSecret), 'Secret role redacts clients; it does not encrypt native profile storage')

  await assert.rejects(ctx.settings.mutate(namespace, [{ op: 'set', path: ['ark', 'videoModel'], value: 'must-not-overwrite' }], initial.revision), /changed since it was read/)
  const beforeInvalid = await readFile(profile.patchPath, 'utf8')
  await assert.rejects(ctx.settings.mutate(namespace, [
    { op: 'set', path: ['ark', 'videoModel'], value: 'must-not-partially-commit' },
    { op: 'set', path: ['source'], value: 'invalid-source' },
  ], view().revision))
  assert.equal(await readFile(profile.patchPath, 'utf8'), beforeInvalid, 'Rejected atomic edits leave the profile unchanged')
  assert.equal(modelRef.get(), 'settings-video-smoke', 'Rejected edits leave live references unchanged')
  await ctx.settings.mutate(namespace, [{ op: 'set', path: ['ark', 'videoModel'], value: 'settings-video-updated' }], view().revision)
  const renamed = await call('context', { workId })
  assert.equal(provider(renamed, 'ark').models.video, 'settings-video-updated')
  assert.equal(entry().fiber.config.ark.apiKey.get(), fakeArkSecret, 'Editing a model preserves the omitted secret')
  assertNoSecrets(renamed)

  await ctx.settings.mutate(namespace, [{ op: 'set', path: ['source'], value: 'environment' }], view().revision)
  assert.equal(sourceRef.get(), 'environment')
  const fromEnvironment = await call('context', { workId })
  assert.equal(provider(fromEnvironment, 'ark').models.video, 'environment-video-smoke', 'Environment configuration requires explicit source selection')
  assertNoSecrets(fromEnvironment)
  await ctx.settings.mutate(namespace, [{ op: 'set', path: ['source'], value: 'settings' }], view().revision)
  stop()
  await ctx.fiber.dispose()
  ctx = await start()
  assert.equal(entry().fiber.config.source.get(), 'settings')
  assert.equal(entry().fiber.config.ark.videoModel.get(), 'settings-video-updated')
  assert.equal(entry().fiber.config.ark.apiKey.get(), fakeArkSecret)
  const restored = await call('context', { workId })
  assert.equal(provider(restored, 'ark').models.video, 'settings-video-updated', 'A fresh plugin runtime reads the persisted settings')
  assertNoSecrets(view())
  assertNoSecrets(restored)
  assert.equal(networkCalls, 0)
  console.log(JSON.stringify({ ok: true, harnessRoot: resolve(harnessRoot), nativeConfigDiscovery: true, secretRedaction: true, atomicMutation: true, liveWithoutRemount: true, existingWorkspaceRefresh: true, staleRevisionRejected: true, invalidMutationRejected: true, profileRestartRestore: true, explicitEnvironmentMode: true, networkCalls, executedToolCalls: executions }, null, 2))
} finally {
  await ctx?.fiber.dispose()
  globalThis.fetch = originalFetch
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await rm(temporary, { recursive: true, force: true })
}
