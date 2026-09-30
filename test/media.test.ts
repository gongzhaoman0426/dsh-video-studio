import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { WorkStore } from '../src/domain/store.ts'
import { MediaService } from '../src/media/service.ts'
import { available, probe, run } from '../src/media/process.ts'
import { ProviderError, type MediaProvider, type MediaRequest } from '../src/providers/types.ts'
import { createArkProvider } from '../src/providers/official.ts'
import { StudioRuntime } from '../src/host/runtime.ts'
import type { ChapterDraft } from '../src/domain/types.ts'

const hasFfmpeg = await available('ffmpeg') && await available('ffprobe')
async function fixture(t: { after(fn: () => unknown): void }) {
  const cwd = await mkdtemp(join(tmpdir(), 'chapter-media-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const store = new WorkStore(cwd)
  let work = await store.create({ title: '渡口', aspectRatio: '16:9' })
  work = await store.command(work.id, work.revision, 'chapter.add', { title: '第一章', text: '木门打开了。' })
  const chapter = work.chapters[0]!
  const draft: ChapterDraft = { summary: '开门', adaptationNotes: '', scenes: [{ id: 'scene1', title: '门口', location: '渡口', time: '清晨', characterIds: [], beats: [{ id: 'beat1', kind: 'action', text: '门打开', sourceParagraphIds: [chapter.sources[0]!.paragraphs[0]!.id] }] }], shots: [{ id: 'shot1', sceneId: 'scene1', title: '开门', beatIds: ['beat1'], description: '木门缓缓打开', prompt: '晨光中的木门', camera: '静止中景', durationSec: 0.5, characterIds: [], assetIds: [], narration: '' }] }
  work = await store.command(work.id, work.revision, 'draft.save', { chapterId: chapter.id, draft })
  work = await store.command(work.id, work.revision, 'chapter.approve', { chapterId: chapter.id, note: '制作此版' })
  const image = join(cwd, 'fixture.png')
  if (hasFfmpeg) await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=blue:s=64x64', '-frames:v', '1', '-update', '1', image])
  return { cwd, store, work, chapterId: chapter.id, image, draft }
}
function provider(overrides: Partial<MediaProvider> = {}): MediaProvider {
  return { id: 'test-provider', configId: 'test-config-v1', label: 'Local test only', mode: 'production', configured: true, kinds: ['image', 'video', 'audio'], models: { image: 'test-image', video: 'test-video', audio: 'test-audio' }, validate() {}, async submit() { throw new Error('Test must provide submit') }, ...overrides }
}

test('real preview media persists, duplicate operations reuse jobs, new operations create candidates without adopting', { skip: !hasFfmpeg }, async t => {
  const { store, work, chapterId } = await fixture(t)
  const service = new MediaService(store, { providers: [] }); t.after(() => service.dispose())
  const input = { chapterId, shotIds: ['shot1'], kind: 'image' as const, mode: 'preview' as const, operationId: 'first-preview' }
  const queued = await service.generate(work.id, input, work.revision)
  assert.equal(queued.jobs[0]!.status, 'queued')
  await service.waitForIdle()
  let state = await store.get(work.id)
  assert.equal(state.jobs[0]!.status, 'succeeded', state.jobs[0]!.error)
  assert.equal(state.takes.length, 1)
  assert.deepEqual(state.chapters[0]!.selections, {})
  assert.equal((await probe(store.filePath(work.id, state.assets[0]!.path))).width, 640)
  await service.generate(work.id, input, work.revision)
  assert.equal((await store.get(work.id)).jobs.length, 1)
  await service.generate(work.id, { ...input, operationId: 'second-preview' }, state.revision)
  await service.waitForIdle(); state = await store.get(work.id)
  assert.equal(state.takes.length, 2)
  await assert.rejects(service.generate(work.id, { ...input, kind: 'video' }, state.revision), /different request/)
  await service.generate(work.id, { ...input, kind: 'video', operationId: 'preview-video' }, state.revision)
  await service.waitForIdle(); state = await store.get(work.id)
  const video = state.takes.find(take => take.kind === 'video')!
  assert.ok(video, state.jobs.find(job => job.kind === 'video')?.error)
  state = await store.command(work.id, state.revision, 'take.select', { chapterId, shotId: 'shot1', kind: 'video', takeId: video.id })
  await service.render(work.id, { chapterId }, state.revision); await service.waitForIdle()
  state = await store.get(work.id)
  assert.equal(state.renders[0]!.status, 'completed', state.renders[0]!.error)
  assert.equal(state.renders[0]!.mode, 'preview')
})

test('unknown paid submission is never automatically retried; known remote ID resumes without submitting', { skip: !hasFfmpeg }, async t => {
  const { store, work, chapterId, image, cwd } = await fixture(t)
  let submits = 0
  const unknown = new MediaService(store, { providers: [provider({ async submit() { submits++; throw new ProviderError('response lost', true) } })] })
  const request = { chapterId, shotIds: ['shot1'], kind: 'image' as const, mode: 'production' as const, operationId: 'unknown-request' }
  await unknown.generate(work.id, request, work.revision); await unknown.waitForIdle()
  assert.equal((await store.get(work.id)).jobs[0]!.status, 'unknown')
  await unknown.resume(work.id); await unknown.waitForIdle(); assert.equal(submits, 1)
  await unknown.cancel(work.id, (await store.get(work.id)).jobs[0]!.id); await unknown.waitForIdle()
  assert.equal((await store.get(work.id)).jobs[0]!.status, 'unknown', 'cancel must not pretend an ambiguous remote job was cancelled')
  await unknown.dispose()
  let state = await store.get(work.id)
  const first = new MediaService(store, { pollIntervalMs: 1, providers: [provider({ async submit() { submits++; return { remoteId: 'remote-123' } }, async poll() { throw new Error('offline') } })] })
  await first.generate(work.id, { ...request, operationId: 'known-request' }, state.revision); await first.waitForIdle(); first.dispose()
  const before = submits
  const changed = new MediaService(store, { providers: [provider({ configId: 'changed-account', async poll() { assert.fail('changed account must not query original job') } })] })
  await changed.resume(work.id); await changed.waitForIdle(); changed.dispose()
  const second = new MediaService(new WorkStore(cwd), { providers: [provider({ async submit() { assert.fail('must not submit again') }, async poll(id) { assert.equal(id, 'remote-123'); return { state: 'succeeded', artifact: { bytes: await readFile(image) } } } })] })
  t.after(() => second.dispose())
  await second.resume(work.id); await second.waitForIdle(); state = await store.get(work.id)
  assert.equal(state.jobs.find(job => job.operationId === 'known-request')!.status, 'succeeded')
  assert.equal(submits, before)
})

test('cancellation while remote submission is in flight retains remote ID and never adopts a late success', { skip: !hasFfmpeg }, async t => {
  const { store, work, chapterId, image } = await fixture(t)
  let accepted!: () => void, finish!: () => void
  const started = new Promise<void>(resolve => { accepted = resolve })
  const released = new Promise<void>(resolve => { finish = resolve })
  const service = new MediaService(store, { providers: [provider({ async submit() { accepted(); await released; return { remoteId: 'late-remote' } }, async poll() { return { state: 'succeeded', artifact: { bytes: await readFile(image) } } } })] })
  t.after(() => service.dispose())
  const queued = await service.generate(work.id, { chapterId, shotIds: ['shot1'], kind: 'image', mode: 'production', operationId: 'late-job' }, work.revision)
  await started
  await service.cancel(work.id, queued.jobs[0]!.id)
  finish(); await service.waitForIdle()
  const state = await store.get(work.id)
  assert.equal(state.jobs[0]!.remoteId, 'late-remote')
  assert.equal(state.jobs[0]!.remoteStatus, 'succeeded')
  assert.equal(state.jobs[0]!.status, 'cancelled')
  assert.equal(state.takes.length, 0)
})

test('approval revoked before worker submission prevents provider invocation', { skip: !hasFfmpeg }, async t => {
  const { store, work, chapterId } = await fixture(t)
  let calls = 0
  let started!: () => void, unblock!: () => void
  const active = new Promise<void>(resolve => { started = resolve }), gate = new Promise<void>(resolve => { unblock = resolve })
  const service = new MediaService(store, { concurrency: 1, providers: [provider({ async submit() { calls++; started(); await gate; throw new ProviderError('test rejection') } })] }); t.after(() => service.dispose())
  // Keep the queue occupied while the second job's approval is revoked.
  const input = { chapterId, shotIds: ['shot1'], kind: 'image' as const, mode: 'production' as const, operationId: 'revoked' }
  await service.generate(work.id, { ...input, operationId: 'blocking' }, work.revision)
  await active
  const queued = await service.generate(work.id, input, (await store.get(work.id)).revision)
  await store.command(work.id, queued.revision, 'chapter.revoke', { chapterId })
  unblock()
  await service.waitForIdle()
  assert.equal(calls, 1)
  assert.equal((await store.get(work.id)).jobs[1]!.status, 'failed')
})

test('selected image renders real MP4/SRT/timeline; re-render never invokes provider and changed source is rejected', { skip: !hasFfmpeg }, async t => {
  const { store, work, chapterId, image } = await fixture(t)
  let submissions = 0
  const service = new MediaService(store, { providers: [provider({ async submit() { submissions++; return { artifact: { bytes: await readFile(image) } } } })] }); t.after(() => service.dispose())
  await service.generate(work.id, { chapterId, shotIds: ['shot1'], kind: 'image', mode: 'production', operationId: 'render-image' }, work.revision)
  await service.waitForIdle(); let state = await store.get(work.id)
  state = await store.command(work.id, state.revision, 'take.select', { chapterId, shotId: 'shot1', kind: 'image', takeId: state.takes[0]!.id })
  await service.render(work.id, { chapterId, voice: false, subtitles: true }, state.revision); await service.waitForIdle()
  state = await store.get(work.id)
  assert.equal(state.renders[0]!.status, 'completed', state.renders[0]!.error)
  const info = await probe(store.filePath(work.id, state.renders[0]!.videoPath!))
  assert.equal(info.hasAudio, true); assert.equal(info.hasVideo, true)
  assert.match(await readFile(store.filePath(work.id, state.renders[0]!.timelinePath!), 'utf8'), /still-image-pan/)
  await service.render(work.id, { chapterId, voice: false, subtitles: false }, state.revision); await service.waitForIdle()
  assert.equal(submissions, 1)
  state = await store.get(work.id)
  await writeFile(store.filePath(work.id, state.assets[0]!.path), 'tampered')
  await service.render(work.id, { chapterId }, state.revision); await service.waitForIdle()
  state = await store.get(work.id)
  assert.equal(state.renders[2]!.status, 'failed')
  assert.match(state.renders[2]!.error!, /Source media changed/)
})

test('Ark adapter sends actual image data fields, preserves duration, rejects unsupported capabilities and redacts failures', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ark-contract-')); t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'reference.png'); await writeFile(path, 'sample-reference')
  const bodies: any[] = []
  const fetcher: typeof fetch = async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify(bodies.length === 1 ? { data: [{ url: 'https://example.invalid/result.png' }] } : { id: 'video-1' }), { status: 200, headers: { 'content-type': 'application/json' } }) }
  const ark = createArkProvider({ apiKey: 'secret', imageModel: 'test-image', videoModel: 'test-video', imageReferences: true, videoReferences: true, fetchImpl: fetcher })
  const request: MediaRequest = { kind: 'image', model: 'test-image', prompt: 'test', durationSec: 5, aspectRatio: '16:9', references: [{ path, mimeType: 'image/png' }], outputDirectory: directory, requestKey: 'request', signal: new AbortController().signal }
  ark.validate(request); await ark.submit(request)
  assert.match(bodies[0].image, /^data:image\/png;base64,/)
  request.kind = 'video'; request.model = 'test-video'; ark.validate(request); await ark.submit(request)
  assert.equal(bodies[1].duration, 5)
  assert.match(bodies[1].content[1].image_url.url, /^data:image\/png;base64,/)
  assert.equal(bodies[1].content[1].role, 'first_frame')
  const unsupported = createArkProvider({ apiKey: 'secret', imageModel: 'test-image' })
  assert.throws(() => unsupported.validate({ ...request, kind: 'image', model: 'test-image' }), /Reference input is not enabled/)
  assert.throws(() => ark.validate({ ...request, durationSec: 6 }), /never rounded/)
  const failed = createArkProvider({ apiKey: 'secret', videoModel: 'test-video', fetchImpl: async () => new Response('server echoes secret and https://private.invalid/?token=secret', { status: 500 }) })
  await assert.rejects(failed.submit({ ...request, references: [] }), error => error instanceof ProviderError && error.ambiguous && !error.message.includes('secret'))
})

test('download failures retry the existing result URL without another paid submission; corrupt media is terminal', { skip: !hasFfmpeg }, async t => {
  const { store, work, chapterId, image } = await fixture(t)
  const bytes = await readFile(image)
  let downloads = 0, submits = 0
  const server = createServer((_request, response) => { downloads++; response.writeHead(downloads === 1 ? 503 : 200, { 'content-type': 'image/png' }); response.end(downloads === 1 ? 'temporarily unavailable' : bytes) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const address = server.address() as { port: number }
  const service = new MediaService(store, { providers: [provider({ async submit() { submits++; return { artifact: { url: `http://127.0.0.1:${address.port}/result` } } } })] }); t.after(() => service.dispose())
  await service.generate(work.id, { chapterId, shotIds: ['shot1'], kind: 'image', mode: 'production', operationId: 'download-resume' }, work.revision)
  await service.waitForIdle()
  let state = await store.get(work.id)
  assert.equal(state.jobs[0]!.status, 'downloading')
  await service.resume(work.id); await service.waitForIdle(); state = await store.get(work.id)
  assert.equal(state.jobs[0]!.status, 'succeeded'); assert.equal(submits, 1); assert.equal(downloads, 2)
  const corrupt = new MediaService(store, { providers: [provider({ async submit() { return { artifact: { bytes: Buffer.from('not media') } } } })] }); t.after(() => corrupt.dispose())
  await corrupt.generate(work.id, { chapterId, shotIds: ['shot1'], kind: 'image', mode: 'production', operationId: 'invalid-file' }, state.revision)
  await corrupt.waitForIdle(); state = await store.get(work.id)
  assert.equal(state.jobs[1]!.status, 'failed')
  const revision = state.revision
  await corrupt.resume(work.id); await corrupt.waitForIdle()
  assert.equal((await store.get(work.id)).revision, revision)
})

test('voice=false still uses a selected audio take and Chinese captions survive without libass', { skip: !hasFfmpeg }, async t => {
  let { store, work, chapterId, image, draft, cwd } = await fixture(t)
  draft.scenes[0]!.beats[0]!.kind = 'narration'; draft.scenes[0]!.beats[0]!.text = '门开了。'; draft.shots[0]!.narration = '门开了。'
  work = await store.command(work.id, work.revision, 'draft.save', { chapterId, draft })
  work = await store.command(work.id, work.revision, 'chapter.approve', { chapterId })
  const audio = join(cwd, 'speech.wav')
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.3', audio])
  const service = new MediaService(store, { providers: [provider({ async submit(request) { return { artifact: { bytes: await readFile(request.kind === 'audio' ? audio : image) } } } })] }); t.after(() => service.dispose())
  for (const kind of ['image', 'audio'] as const) {
    await service.generate(work.id, { chapterId, shotIds: ['shot1'], kind, mode: 'production', operationId: `caption-${kind}` }, work.revision)
    await service.waitForIdle(); work = await store.get(work.id)
    work = await store.command(work.id, work.revision, 'take.select', { chapterId, shotId: 'shot1', kind, takeId: work.takes.find(take => take.kind === kind)!.id })
  }
  await service.render(work.id, { chapterId, voice: false, subtitles: true }, work.revision); await service.waitForIdle()
  work = await store.get(work.id)
  const result = work.renders[0]!
  assert.equal(result.status, 'completed', result.error)
  const timeline = JSON.parse(await readFile(store.filePath(work.id, result.timelinePath!), 'utf8'))
  assert.equal(typeof timeline.clips[0].audio, 'string')
  assert.equal(timeline.clips[0].localPreviewVoice, false)
  assert.match(await readFile(store.filePath(work.id, result.subtitlePath!), 'utf8'), /门开了。/)
  if (timeline.subtitleDelivery === 'mp4-text-track-and-srt') {
    const tracks = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', store.filePath(work.id, result.videoPath!)]))
    assert.equal(tracks.streams.some((stream: any) => stream.codec_name === 'mov_text'), true)
  }
})

test('dispose waits for workers to persist interrupted submit state and release locks', { skip: !hasFfmpeg }, async t => {
  const { store, work, chapterId } = await fixture(t)
  let announce!: () => void
  const started = new Promise<void>(resolve => { announce = resolve })
  const service = new MediaService(store, { providers: [provider({ async submit(request) { announce(); await new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true })); throw new ProviderError('request interrupted', true) } })] })
  const queued = await service.generate(work.id, { chapterId, shotIds: ['shot1'], kind: 'image', mode: 'production', operationId: 'dispose-submit' }, work.revision)
  await started; await service.dispose()
  const saved = await store.get(work.id)
  assert.equal(saved.jobs[0]!.status, 'unknown')
  await assert.rejects(readFile(store.filePath(work.id, `media/jobs/${queued.jobs[0]!.id}/worker.lock`)), { code: 'ENOENT' })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal((await store.get(work.id)).revision, saved.revision)
})

test('live settings use new models for new jobs while active attempts retain their provider and queued jobs pause', async t => {
  const { store, work, chapterId } = await fixture(t)
  let announce!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { announce = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const submits: string[] = [], polls: string[] = []
  const oldProvider = provider({
    configId: 'account-old', models: { image: 'old-model' },
    async submit(request) {
      assert.equal(request.model, 'old-model'); submits.push('old')
      if (submits.length === 1) { announce(); await gate }
      return { remoteId: `old-${submits.length}` }
    },
    async poll(id) { assert.match(id, /^old-/); polls.push('old'); return { state: 'failed', error: 'Completed test query' } },
  })
  const newProvider = provider({
    configId: 'account-new', models: { image: 'new-model' },
    async submit(request) { assert.equal(request.model, 'new-model'); submits.push('new'); return { remoteId: 'new-remote' } },
    async poll(id) { assert.equal(id, 'new-remote'); polls.push('new'); return { state: 'failed', error: 'Completed test query' } },
  })
  let current = oldProvider
  const service = new MediaService(store, { concurrency: 1, providers: () => [current] })
  t.after(async () => { release(); await service.dispose() })
  const input = { chapterId, shotIds: ['shot1'], kind: 'image' as const, mode: 'production' as const, operationId: 'active-old' }
  await service.generate(work.id, input, work.revision); await started
  await service.generate(work.id, { ...input, operationId: 'queued-old' }, (await store.get(work.id)).revision)
  current = newProvider
  const diagnostics = await service.diagnostics() as { providers: Array<{ id: string; models: { image?: string } }> }
  assert.equal(diagnostics.providers.find(item => item.id === current.id)!.models.image, 'new-model')
  await service.generate(work.id, { ...input, operationId: 'queued-new' }, (await store.get(work.id)).revision)
  release(); await service.waitForIdle()
  let state = await store.get(work.id)
  const paused = state.jobs.find(job => job.operationId === 'queued-old')!
  assert.equal(paused.status, 'queued'); assert.equal(paused.attempt, 0)
  assert.match(paused.error!, /configuration is unavailable or changed/)
  assert.equal(state.jobs.find(job => job.operationId === 'queued-new')!.model, 'new-model')
  assert.deepEqual(submits, ['old', 'new']); assert.deepEqual(polls, ['old', 'new'])
  await service.resume(work.id); await service.waitForIdle()
  assert.deepEqual(submits, ['old', 'new'], 'resume with another account must not submit the original queued job')
  current = oldProvider
  await service.resume(work.id); await service.waitForIdle(); state = await store.get(work.id)
  assert.equal(state.jobs.find(job => job.id === paused.id)!.attempt, 1)
  assert.deepEqual(submits, ['old', 'new', 'old']); assert.deepEqual(polls, ['old', 'new', 'old'])
})

test('live account changes cannot query or cancel old remote jobs until their original configuration is restored', async t => {
  const { store, work, chapterId } = await fixture(t)
  let polls = 0, cancellations = 0, submissions = 0
  const original = provider({
    async submit() { submissions++; return { remoteId: 'original-remote' } },
    async poll() { polls++; throw new Error('Temporary query failure') },
    async cancel(id) { assert.equal(id, 'original-remote'); cancellations++; return true },
  })
  let current = original
  const service = new MediaService(store, { providers: () => [current], pollIntervalMs: 1 })
  t.after(() => service.dispose())
  const queued = await service.generate(work.id, { chapterId, shotIds: ['shot1'], kind: 'image', mode: 'production', operationId: 'original-remote-job' }, work.revision)
  await service.waitForIdle(); assert.equal(polls, 3)
  current = provider({
    configId: 'different-account',
    async submit() { assert.fail('new account must not resubmit an old job') },
    async poll() { assert.fail('new account must not query an old remote ID') },
    async cancel() { assert.fail('new account must not cancel an old remote ID') },
  })
  await service.resume(work.id); await service.waitForIdle()
  await service.cancel(work.id, queued.jobs[0]!.id); await service.waitForIdle()
  let job = (await store.get(work.id)).jobs[0]!
  assert.equal(job.stopRequested, true); assert.equal(job.remoteId, 'original-remote')
  assert.match(job.error!, /configuration is unavailable or changed/)
  assert.equal(polls, 3); assert.equal(cancellations, 0); assert.equal(submissions, 1)
  current = original
  await service.resume(work.id); await service.waitForIdle(); job = (await store.get(work.id)).jobs[0]!
  assert.equal(job.status, 'cancelled'); assert.equal(cancellations, 1); assert.equal(submissions, 1)
})

test('workspace runtimes keep their store and media queues while provider settings change', async t => {
  const { cwd } = await fixture(t)
  let current = provider({ models: { image: 'before-settings-edit' } })
  const runtime = new StudioRuntime({ providers: () => [current] }); t.after(() => runtime.dispose())
  const first = await runtime.register(cwd)
  current = provider({ configId: 'updated-config', models: { image: 'after-settings-edit' } })
  const second = await runtime.register(cwd)
  assert.equal(first, second)
  const diagnostics = await second.media.diagnostics() as { providers: Array<{ id: string; models: { image?: string } }> }
  assert.equal(diagnostics.providers.find(item => item.id === current.id)!.models.image, 'after-settings-edit')
})
