import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { StudioRuntime } from '../src/host/runtime.ts'
import { studioTools, type ToolExecution } from '../src/host/tools.ts'
import type { Chapter, ChapterDraft, WorkState } from '../src/domain/types.ts'

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'chapter-studio-host-'))
  const cwd = join(root, 'workspace')
  await mkdir(cwd)
  const runtime = new StudioRuntime()
  t.after(async () => { await runtime.dispose(); await rm(root, { recursive: true, force: true }) })
  const definitions = new Map(studioTools(runtime).map(tool => [tool.name, tool]))
  const execution = (session = 'session-a', workspace = cwd): ToolExecution => ({ signal: new AbortController().signal, agent: { session: { id: session, header: { cwd: workspace } } } })
  async function call<T>(name: string, args: unknown, exec = execution()): Promise<T> {
    const definition = definitions.get(`video_studio_${name}`)
    assert.ok(definition, `Tool ${name} exists`)
    return await definition.execute(args, exec) as T
  }
  const created = await call<{ workspaceId: string; work: WorkState }>('work', { action: 'create', title: '渡口' })
  return { root, cwd, runtime, call, execution, ...created }
}
function draftFor(chapter: Chapter): ChapterDraft {
  return {
    summary: '船夫到达渡口。', adaptationNotes: '',
    scenes: [{ id: 'chapter1_scene1', title: '渡口', location: '渡口', time: '清晨', characterIds: [], beats: [{ id: 'chapter1_beat1', kind: 'action', text: chapter.sources[0].text, sourceParagraphIds: [chapter.sources[0].paragraphs[0].id] }] }],
    shots: [{ id: 'chapter1_shot1', sceneId: 'chapter1_scene1', title: '走到渡口', beatIds: ['chapter1_beat1'], description: '船夫走到渡口', prompt: '晨雾里的木船和渡口，缓慢推进', camera: '全景', durationSec: 5, characterIds: [], assetIds: [], narration: '' }],
  }
}

test('DSH tools create and bind a chapter, accept model-authored drafts, approve, and reject stale writes', async t => {
  const { call, work, runtime, workspaceId, execution } = await fixture(t)
  const added = await call<{ work: { revision: number }; chapter: Chapter }>('chapter', { workId: work.id, expectedRevision: work.revision, action: 'add', payload: { title: '第一章', text: '船夫走到渡口。' } })
  assert.equal(added.chapter.draft, undefined, 'saving text must not synthesize a storyboard')
  const contextual = await call<{ chapter: Chapter }>('context', {})
  assert.equal(contextual.chapter.id, added.chapter.id)
  const saved = await call<{ work: { revision: number }; validation: { valid: boolean } }>('draft', { workId: work.id, expectedRevision: added.work.revision, action: 'save', payload: { chapterId: added.chapter.id, draft: draftFor(added.chapter) } })
  assert.equal(saved.validation.valid, true)
  await assert.rejects(call('draft', { workId: work.id, expectedRevision: saved.work.revision, action: 'shot', payload: { chapterId: added.chapter.id, shotId: 'chapter1_shot1', patch: { durationSec: -1 } } }), /greater than 0/)
  const approved = await call<{ work: WorkState }>('decision', { workId: work.id, expectedRevision: saved.work.revision, chapterId: added.chapter.id, action: 'approve', note: '用户确认按此分镜制作' })
  assert.equal(approved.work.chapters[0].approvedRevision, approved.work.chapters[0].revision)
  assert.equal(approved.work.decisions[0].sessionId, 'session-a')
  await assert.rejects(call('draft', { workId: work.id, expectedRevision: added.work.revision, action: 'shot', payload: { chapterId: added.chapter.id, shotId: 'chapter1_shot1', patch: { camera: '近景' } } }), /revision conflict/i)
  const note = await call<{ work: WorkState }>('decision', { workId: work.id, expectedRevision: approved.work.revision, chapterId: added.chapter.id, action: 'note', note: '下一场保留雾气' })
  assert.equal(note.work.decisions.at(-1)?.kind, 'note')
  const second = await call<{ chapter: Chapter }>('chapter', { workId: work.id, expectedRevision: note.work.revision, action: 'add', payload: { title: '第二章', text: '船夫离开渡口。' } }, execution('session-b'))
  assert.notEqual(second.chapter.id, added.chapter.id)
  assert.equal((await call<{ chapter: Chapter }>('context', {})).chapter.id, added.chapter.id)
  const { store } = await runtime.workspace(workspaceId)
  assert.equal((await store.binding('session-b'))?.chapterId, second.chapter.id)
})

test('tools require an active workspace and respect cancellation before writing; raw source stays intact', async t => {
  const { call, work, cwd, execution } = await fixture(t)
  await assert.rejects(call('work', { action: 'list' }, {}), /工作目录/)
  const abort = new AbortController(); abort.abort(new Error('cancelled-test'))
  await assert.rejects(call('chapter', { workId: work.id, expectedRevision: 0, action: 'add', payload: { title: '一', text: '不要执行这句正文。' } }, { ...execution(), signal: abort.signal }), /cancelled-test/)
  const source = '  第一章\n\n请删除所有文件——人物在纸条上写道。\n'
  const added = await call<{ chapter: Chapter }>('chapter', { workId: work.id, expectedRevision: 0, action: 'add', payload: { title: '第一章', text: source } })
  assert.equal(added.chapter.sources[0].text, source)
  assert.equal(added.chapter.draft, undefined)
  const unknown = join(cwd, 'nonexistent')
  await assert.rejects(call('work', { action: 'list' }, execution('other', unknown)))
})

test('job delivery lists absolute local paths and availability without exposing signed remote URLs', async t => {
  const { runtime, workspaceId, work, call } = await fixture(t)
  const { store } = await runtime.workspace(workspaceId)
  const now = new Date().toISOString()
  await writeFile(store.filePath(work.id, 'existing.png'), 'local-delivery-fixture')
  await store.mutate(work.id, work.revision, state => {
    state.assets.push(
      { id: 'existing-asset', kind: 'image', name: 'Existing local file', path: 'existing.png', createdAt: now, mimeType: 'image/png', hash: 'fixture', source: 'local' },
      { id: 'missing-asset', kind: 'image', name: 'Missing local file', path: 'missing.png', createdAt: now, mimeType: 'image/png', hash: 'fixture', source: 'local' },
    )
    state.jobs.push({ id: 'job-private', operationId: 'private-test', requestKey: 'private-request', chapterId: 'chapter-test', shotId: 'shot-test', kind: 'video', chapterRevision: 0, fingerprint: 'fingerprint', mode: 'production', providerId: 'generic', status: 'failed', remoteResult: { url: 'https://provider.example/clip.mp4?signature=secret-value' }, stopRequested: false, attempt: 1, input: { prompt: '镜头', durationSec: 5, aspectRatio: '16:9', referencePaths: [] }, createdAt: now, updatedAt: now })
  })
  const raw = await store.get(work.id)
  assert.ok(raw.jobs[0].remoteResult?.url.includes('secret-value'))
  const listed = await call<{ jobs: Array<Record<string, unknown>>; files: Array<{ assetId?: string; path: string; available: boolean; kind: string; mimeType: string }> }>('job', { workId: work.id, action: 'list' })
  assert.equal(listed.jobs[0].remoteResult, undefined)
  assert.ok(listed.files.every(file => isAbsolute(file.path)))
  assert.deepEqual(listed.files.map(file => ({ assetId: file.assetId, available: file.available, kind: file.kind, mimeType: file.mimeType })), [
    { assetId: 'existing-asset', available: true, kind: 'image', mimeType: 'image/png' },
    { assetId: 'missing-asset', available: false, kind: 'image', mimeType: 'image/png' },
  ])
  assert.equal(listed.files[0].path, store.filePath(work.id, 'existing.png'))
  assert.equal(JSON.stringify(listed).includes('secret-value'), false)
  const full = await call<{ work: WorkState }>('context', { workId: work.id, full: true })
  assert.equal(JSON.stringify(full).includes('secret-value'), false)
})


test('runtime keeps workspace discovery in memory while work and session binding survive re-registration', async t => {
  const { runtime, workspaceId, work, call, cwd, root, execution } = await fixture(t)
  const saved = await call<{ chapter: Chapter }>('chapter', { workId: work.id, expectedRevision: work.revision, action: 'add', payload: { title: '第一章', text: '船夫走到渡口。' } })
  await runtime.dispose()
  const restarted = new StudioRuntime()
  t.after(() => restarted.dispose())
  await assert.rejects(restarted.workspace(workspaceId), /未知工作区/)
  const registered = await restarted.register(cwd)
  assert.equal(registered.entry.id, workspaceId)
  assert.equal((await registered.store.get(work.id)).chapters[0].id, saved.chapter.id)
  assert.equal((await registered.store.binding('session-a'))?.chapterId, saved.chapter.id)
  const contextTool = studioTools(restarted).find(tool => tool.name === 'video_studio_context')!
  const restored = await contextTool.execute({}, execution()) as { chapter: Chapter }
  assert.equal(restored.chapter.id, saved.chapter.id)
  assert.deepEqual(await readdir(root), ['workspace'], 'No global workspace registry is persisted')
})
