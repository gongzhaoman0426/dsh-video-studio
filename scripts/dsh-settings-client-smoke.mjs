#!/usr/bin/env node
/** Built client integration with real DSH Modules, Slots and ConfigForms; Remote is an in-memory test transport. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runInThisContext } from 'node:vm'

const harnessRoot = process.argv[2]
if (!harnessRoot) throw new Error('Usage: node scripts/dsh-settings-client-smoke.mjs /absolute/path/to/built/deepseek-harness')
const root = resolve(harnessRoot)
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const importHarness = path => import(pathToFileURL(join(root, path)).href)
const requireHarness = createRequire(join(root, 'package.json'))
const requireRenderer = createRequire(join(root, 'packages/client/ui-renderer/package.json'))
const { JSDOM } = requireHarness('jsdom')
const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost/' })
const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT }
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.IS_REACT_ACT_ENVIRONMENT = true
let ctx
let rendered
try {
  const [cordis, store, uiSlots, { Config }] = await Promise.all([
    importHarness('vendor/cordis/lib/index.js'),
    importHarness('packages/client/store/lib/index.js'),
    importHarness('packages/client/ui-slots/lib/index.js'),
    import(pathToFileURL(join(projectRoot, 'lib/index.js')).href),
  ])
  const staticModules = {
    '@deepseek-ai/cordis': cordis,
    '@deepseek-ai/dsh-client-store': store,
    '@deepseek-ai/dsh-client-ui-slots': uiSlots,
    react: requireRenderer('react'),
    'react-dom': requireRenderer('react-dom'),
    'react-dom/client': requireRenderer('react-dom/client'),
    'react/jsx-runtime': requireRenderer('react/jsx-runtime'),
  }
  const registrations = []
  const target = { mode: 'queue', pendingQueue: registrations, load: registration => { registrations.push(registration) } }
  dom.window.__ModuleLoader__ = target
  const execute = async path => runInThisContext(await readFile(path, 'utf8'), { filename: path })
  const moduleId = '@deepseek-ai/dsh-client-modules'
  const settingsId = '@deepseek-ai/dsh-client-ui-settings'
  const rendererId = '@deepseek-ai/dsh-client-ui-renderer'
  const pluginId = 'dsh-chapter-video-studio'
  await execute(join(root, 'packages/client/modules/lib/client.js'))
  const bootstrap = registrations.shift()
  assert.equal(bootstrap.id, moduleId)
  const moduleExports = bootstrap.factory(name => {
    assert.ok(name in staticModules, `Known bootstrap external ${name}`)
    return staticModules[name]
  })
  await execute(join(root, 'packages/client/ui-settings/lib/client.js'))
  await execute(join(root, 'packages/client/ui-renderer/lib/client.js'))
  await execute(join(projectRoot, 'lib/client.js'))
  const ids = [moduleId, settingsId, rendererId, pluginId]
  for (const id of ids.slice(1)) assert.ok(registrations.some(row => row.id === id), `Built bundle registers ${id}`)
  const moduleSystem = moduleExports.createClientModuleSystem(target, { id: moduleId, exports: moduleExports }, {
    boot: {
      rev: 'settings-smoke',
      entries: ids.map(id => ({ id, url: `plugins/??${id}/client.js&rev=smoke`, rev: 'smoke' })),
      batches: [{ phase: 'application', url: 'plugins/??settings-smoke&rev=smoke', rev: 'smoke', entries: ids }],
    },
    staticModules,
    loadBundle: () => Promise.reject(new Error('The smoke loads only local built bundles')),
  })
  const [settingsClient, renderer, pluginClient] = await Promise.all([settingsId, rendererId, pluginId].map(id => moduleSystem.import(id, '', {})))
  assert.equal(typeof pluginClient.apply, 'function')
  assert.ok(pluginClient.inject.includes('configForms'))
  assert.ok(!pluginClient.inject.includes('sessions'), 'Configuration UI does not introduce a conversation editor')

  // Host integration is exercised by dsh-settings-smoke. This fixture supplies
  // that wire shape to the unmodified browser ConfigForms/Slots implementation.
  const unwrap = value => value && typeof value.get === 'function' ? value.get() : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, unwrap(child)])) : value
  const defaults = unwrap(Config({}))
  delete defaults.ark.apiKey
  delete defaults.tts.apiKey
  let descriptor = {
    ns: pluginId, schema: JSON.parse(JSON.stringify(Config.toJSON(), (key, value) => key === 'volatile' ? undefined : value)),
    value: defaults, base: structuredClone(defaults), user: {}, revision: 1, applies: 'live', autoGenerate: false,
    secrets: [{ path: ['ark', 'apiKey'], set: false }, { path: ['tts', 'apiKey'], set: false }],
  }
  let served = true
  const events = new Map()
  let reads = 0
  const mutations = []
  const remote = {
    $host: { home: undefined, isLoopback: true },
    $on: (event, listener) => { const set = events.get(event) ?? new Set(); set.add(listener); events.set(event, set); return () => set.delete(listener) },
    settings: {
      describe: async () => { reads += 1; return { ok: true, value: { writable: true, hasDocument: true, namespaces: served ? [structuredClone(descriptor)] : [] } } },
      mutate: async (namespace, ops, expectedRevision) => {
        assert.equal(namespace, pluginId)
        if (expectedRevision !== descriptor.revision) return { ok: false, error: { code: 'settings/conflict', message: 'stale settings' } }
        mutations.push(structuredClone(ops))
        for (const op of ops) {
          assert.equal(op.op, 'set')
          const secret = descriptor.secrets.find(item => item.path.join('.') === op.path.join('.'))
          if (secret) { secret.set = true; continue }
          let value = descriptor.value
          for (const key of op.path.slice(0, -1)) value = value[key]
          value[op.path.at(-1)] = op.value
        }
        descriptor = { ...descriptor, revision: descriptor.revision + 1 }
        return { ok: true, value: structuredClone(descriptor) }
      },
    },
  }
  ctx = new cordis.Context()
  ctx.provide('remote', remote)
  ctx.provide('remote.settings', remote.settings)
  await ctx.plugin(renderer.SlotRegistry).await()
  const slots = ctx.get('slots')
  slots.register({ name: 'root', children: { 'settings.plugins.tab': { kind: 'list', scope: 'root' } } }, () => null)
  await ctx.plugin(settingsClient).await()
  await ctx.configForms.describe().ensure()
  const pluginFiber = ctx.plugin(pluginClient)
  await pluginFiber.await()
  const settle = async () => { for (let step = 0; step < 6; step += 1) await new Promise(resolve => setImmediate(resolve)) }
  await settle()
  assert.equal(slots.entries('settings.plugins.tab').length, 1, 'The client contributes exactly one DSH configuration tab')
  const form = ctx.configForms.get(pluginId)
  assert.equal(form.getSnapshot().status, 'ready', 'Real ConfigForms accepts the serialized Config schema')
  assert.equal(form.getSnapshot().value.source, 'settings')
  const initial = ctx.configForms.describe().getSnapshot().view.namespaces.find(row => row.ns === pluginId)
  assert.equal(initial.secrets.find(row => row.path.join('.') === 'ark.apiKey').set, false)
  const accepted = await form.mutate([
    { op: 'set', path: ['ark', 'apiKey'], value: 'fake-client-smoke-key' },
    { op: 'set', path: ['ark', 'videoModel'], value: 'client-smoke-video' },
  ], initial.revision)
  assert.equal(accepted, true)
  assert.equal(mutations.length, 1, 'One atomic write carries key and model changes')
  assert.equal(form.getSnapshot().value.ark.videoModel, 'client-smoke-video')
  const updated = ctx.configForms.describe().getSnapshot().view.namespaces.find(row => row.ns === pluginId)
  assert.equal(updated.secrets.find(row => row.path.join('.') === 'ark.apiKey').set, true)
  assert.ok(!JSON.stringify(updated).includes('fake-client-smoke-key'), 'The shared mirror receives secret presence without its value')
  assert.equal(await form.mutate([{ op: 'set', path: ['ark', 'videoModel'], value: 'stale' }], initial.revision), false)
  assert.equal(form.getSnapshot().value.ark.videoModel, 'client-smoke-video')

  const requireTestRuntime = createRequire(join(root, 'packages/test-support/client-runtime/package.json'))
  const { act, fireEvent, render } = requireTestRuntime('@testing-library/react')
  const tab = slots.entries('settings.plugins.tab')[0]
  rendered = render(staticModules.react.createElement(tab.component, tab.inject()))
  assert.ok(rendered.getByRole('heading', { name: /模型设置/ }))
  assert.equal(rendered.getByLabelText('Ark API Key').type, 'password')
  assert.equal(rendered.getByLabelText('Ark API Key').value, '', 'A stored secret is never populated into the password field')
  fireEvent.change(rendered.getByLabelText('Ark API Key'), { target: { value: 'fake-rendered-smoke-key' } })
  fireEvent.change(rendered.getByLabelText('视频模型 / 接入点 ID'), { target: { value: 'rendered-model-smoke' } })
  await act(async () => { fireEvent.click(rendered.getByRole('button', { name: '保存设置' })); await settle() })
  assert.equal(form.getSnapshot().value.ark.videoModel, 'rendered-model-smoke', 'The rendered Save button writes through native ConfigForms')
  assert.equal(rendered.getByLabelText('Ark API Key').value, '', 'A successful Save clears the just-entered key from component state')
  fireEvent.change(rendered.getByLabelText('视频模型 / 接入点 ID'), { target: { value: 'blank-key-model-smoke' } })
  await act(async () => { fireEvent.click(rendered.getByRole('button', { name: '保存设置' })); await settle() })
  assert.equal(form.getSnapshot().value.ark.videoModel, 'blank-key-model-smoke')
  assert.ok(mutations.at(-1).every(op => op.path.at(-1) !== 'apiKey'), 'Saving a model with blank password fields preserves both keys')
  fireEvent.click(rendered.getAllByRole('button', { name: '清空此密钥' })[0])
  assert.equal(rendered.getByLabelText('Ark API Key').disabled, true, 'Explicit clear is staged until Save')
  await act(async () => { fireEvent.click(rendered.getByRole('button', { name: '保存设置' })); await settle() })
  assert.deepEqual(mutations.at(-1), [{ op: 'set', path: ['ark', 'apiKey'], value: '' }], 'Only an explicit clear writes an empty credential')
  assert.ok(!dom.window.localStorage.length, 'The settings panel does not persist credentials in browser storage')
  rendered.unmount()
  rendered = undefined

  served = false
  for (const listener of events.get('settings/document-updated') ?? []) listener(pluginId, descriptor.revision + 1)
  await ctx.configForms.describe().ensure()
  await settle()
  assert.equal(slots.entries('settings.plugins.tab').length, 0, 'A removed Host namespace withdraws its configuration tab')
  served = true
  for (const listener of events.get('settings/document-updated') ?? []) listener(pluginId, descriptor.revision + 2)
  await ctx.configForms.describe().ensure()
  await settle()
  assert.equal(slots.entries('settings.plugins.tab').length, 1)
  await pluginFiber.dispose()
  assert.equal(slots.entries('settings.plugins.tab').length, 0, 'Plugin disposal removes its configuration UI')
  console.log(JSON.stringify({ ok: true, builtModuleLoader: true, nativeConfigForms: true, settingsTabOnly: true, renderedSave: true, secretMarkers: true, passwordClearedAfterSave: true, blankPasswordPreservesKey: true, explicitClear: true, atomicWrite: true, staleRevision: true, namespaceLifecycle: true, disposal: true, describeReads: reads, remoteTransport: 'in-memory test double; no business Host or network' }, null, 2))
} finally {
  rendered?.unmount()
  await ctx?.fiber.dispose()
  dom.window.close()
  if (previous.window === undefined) delete globalThis.window
  else globalThis.window = previous.window
  if (previous.document === undefined) delete globalThis.document
  else globalThis.document = previous.document
  if (previous.act === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT
  else globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act
}
