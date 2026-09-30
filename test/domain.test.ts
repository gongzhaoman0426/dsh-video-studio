import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkStore, DomainError } from '../src/domain/store.js'
import { contextFor, shotFingerprint, validateChapter } from '../src/domain/validate.js'
import type { ChapterDraft, WorkState } from '../src/domain/types.js'

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const cwd = await mkdtemp(join(tmpdir(), 'chapter-studio-domain-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const store = new WorkStore(cwd)
  let work = await store.create({ title: '渡口', style: '水墨', aspectRatio: '16:9' })
  work = await store.command(work.id, work.revision, 'chapter.add', { title: '第一章', text: '沈舟走到渡口。\n\n他推开门。' })
  const chapterId = work.chapters[0].id
  const draft: ChapterDraft = {
    summary: '沈舟抵达渡口。', adaptationNotes: '',
    scenes: [{ id: 'c1_scene1', title: '渡口', location: '渡口', time: '清晨', characterIds: [], beats: work.chapters[0].sources[0].paragraphs.map((p, index) => ({ id: `c1_beat${index + 1}`, kind: 'action', text: p.text, sourceParagraphIds: [p.id] })) }],
    shots: [1, 2].map(index => ({ id: `c1_shot${index}`, sceneId: 'c1_scene1', title: `镜头 ${index}`, beatIds: [`c1_beat${index}`], description: index === 1 ? '走近渡口' : '推门', prompt: index === 1 ? '晨雾中的渡口' : '木门缓缓打开', camera: '中景', durationSec: 5, characterIds: [], assetIds: [], narration: '' })),
  }
  work = await store.command(work.id, work.revision, 'draft.save', { chapterId, draft })
  return { store, work, chapterId, draft, cwd }
}
const hasCode = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code

test('state is durable, history precedes commits, conflicts do not overwrite; two writers serialize', async t => {
  const { store, work, cwd } = await fixture(t)
  const second = new WorkStore(cwd)
  assert.deepEqual(await second.get(work.id), work)
  const before = JSON.parse(await readFile(store.filePath(work.id, 'history/0000000001.json'), 'utf8')) as WorkState
  assert.equal(before.revision, 1)
  assert.equal(before.chapters[0].draft, undefined)
  const results = await Promise.allSettled([
    store.mutate(work.id, work.revision, async state => { await new Promise(done => setTimeout(done, 30)); state.title = '版本甲' }),
    second.mutate(work.id, work.revision, state => { state.title = '版本乙' }),
  ])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult
  assert.equal(rejected.reason.code, 'revision_conflict')
  const saved = await second.get(work.id)
  assert.equal(saved.revision, work.revision + 1)
  const winner = results.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<WorkState>
  assert.deepEqual(saved, winner.value)
  await assert.rejects(store.command(work.id, undefined as unknown as number, 'chapter.add', { title: '不可写', text: '不应保存' }), hasCode('revision_required'))
})

test('approval binds to chapter content; local shot edits keep unrelated fingerprints and old decisions', async t => {
  let { store, work, chapterId } = await fixture(t)
  const oldChapter = work.chapters[0]
  const firstFingerprint = shotFingerprint(work, oldChapter, oldChapter.draft!.shots[0], 'video')
  const secondFingerprint = shotFingerprint(work, oldChapter, oldChapter.draft!.shots[1], 'video')
  assert.equal(validateChapter(work, oldChapter).valid, true)
  work = await store.command(work.id, work.revision, 'chapter.approve', { chapterId, note: '按此分镜制作' }, 'session-a')
  assert.equal(work.chapters[0].approvedRevision, work.chapters[0].revision)
  const approvedChapterRevision = work.chapters[0].revision
  work = await store.command(work.id, work.revision, 'note.add', { chapterId, text: '下一章继续这个画风' })
  assert.equal(work.chapters[0].approvedRevision, approvedChapterRevision)
  work = await store.command(work.id, work.revision, 'shot.update', { chapterId, shotId: 'c1_shot1', patch: { camera: '背影近景', prompt: '从人物背后拍渡口' } })
  assert.equal(work.chapters[0].approvedRevision, undefined)
  assert.equal(work.chapters[0].revision, approvedChapterRevision + 1)
  assert.notEqual(shotFingerprint(work, work.chapters[0], work.chapters[0].draft!.shots[0], 'video'), firstFingerprint)
  assert.equal(shotFingerprint(work, work.chapters[0], work.chapters[0].draft!.shots[1], 'video'), secondFingerprint)
  assert.equal(work.decisions.find(item => item.kind === 'approve')?.sessionId, 'session-a')
})

test('source edits retain old source and provenance; duplicates do not duplicate source or chapters', async t => {
  let { store, work, chapterId } = await fixture(t)
  const oldSource = structuredClone(work.chapters[0].sources[0])
  work = await store.command(work.id, work.revision, 'chapter.add', { title: '重复粘贴', text: oldSource.text })
  assert.equal(work.chapters.length, 1)
  work = await store.command(work.id, work.revision, 'chapter.source', { chapterId, text: '沈舟走到渡口。\n\n他敲了三次门。' })
  assert.equal(work.chapters[0].sources.length, 2)
  assert.deepEqual(work.chapters[0].sources[0], oldSource)
  assert.equal(work.chapters[0].draft?.sourceRevisionId, oldSource.id)
  assert.equal(validateChapter(work, work.chapters[0]).valid, false)
  await assert.rejects(store.command(work.id, work.revision, 'chapter.approve', { chapterId }), hasCode('chapter_invalid'))
  work = await store.command(work.id, work.revision, 'chapter.source', { chapterId, text: oldSource.text })
  assert.equal(work.chapters[0].sources.length, 2)
  assert.equal(validateChapter(work, work.chapters[0]).valid, true)
})

test('future canon and facts never leak into prior chapters; draft/approval stages do not control continuity visibility', async t => {
  let { store, work, chapterId } = await fixture(t)
  const source = work.chapters[0].sources[0]
  work = await store.command(work.id, work.revision, 'canon.save', { entry: { id: 'hero', kind: 'character', name: '沈舟', description: '未受伤的渡船人', aliases: [], knownFromChapter: 1 } })
  work = await store.command(work.id, work.revision, 'chapter.add', { title: '第二章', text: '沈舟的左手受伤了。' })
  const secondId = work.chapters[1].id
  work = await store.command(work.id, work.revision, 'canon.save', { entry: { id: 'hero', kind: 'character', name: '沈舟', description: '左手有伤的渡船人', aliases: [], knownFromChapter: 2 } })
  work = await store.command(work.id, work.revision, 'fact.save', { fact: { id: 'arrived', subjectId: 'hero', text: '已到达渡口', scope: 'source', origin: 'source', knownFromChapter: 1, storyTime: '第一天清晨', confirmed: true, sourceChapterId: chapterId, sourceParagraphIds: [source.paragraphs[0].id] } })
  work = await store.command(work.id, work.revision, 'fact.save', { fact: { id: 'injured', subjectId: 'hero', text: '左手受伤', scope: 'source', origin: 'source', knownFromChapter: 2, storyTime: '第一天夜晚', confirmed: true, sourceChapterId: secondId, sourceParagraphIds: [work.chapters[1].sources[0].paragraphs[0].id] } })
  const first = contextFor(work, chapterId)
  const second = contextFor(work, secondId)
  assert.equal(first.canon[0].description, '未受伤的渡船人')
  assert.equal(second.canon[0].description, '左手有伤的渡船人')
  assert.deepEqual(first.facts.map(fact => fact.id), ['arrived'])
  assert.deepEqual(second.facts.map(fact => fact.id), ['arrived', 'injured'])
  assert.equal(first.facts[0].sourceRevisionId, source.id)
  assert.equal(second.chapter?.draft, undefined)
  assert.equal(second.facts.length, 2)
  await store.bind('session/one', work.id, chapterId)
  await store.bind('session/two', work.id, secondId)
  assert.equal((await store.binding('session/one'))?.chapterId, chapterId)
  assert.equal((await store.binding('session/two'))?.chapterId, secondId)
})

test('runtime validation rejects malformed data; approval catches duplicate/omitted/reordered beats and missing speech', async t => {
  const { store, work, chapterId, draft } = await fixture(t)
  await assert.rejects(store.command(work.id, work.revision, 'shot.update', { chapterId, shotId: 'c1_shot1', patch: { durationSec: -1 } }), hasCode('invalid_input'))
  const malformed = structuredClone(draft)
  malformed.shots[1].beatIds = ['c1_beat1']
  const next = await store.command(work.id, work.revision, 'draft.save', { chapterId, draft: malformed })
  assert.equal(validateChapter(next, next.chapters[0]).valid, false)
  await assert.rejects(store.command(next.id, next.revision, 'chapter.approve', { chapterId }), hasCode('chapter_invalid'))
  const spoken = structuredClone(draft)
  spoken.scenes[0].beats[0].kind = 'narration'
  const speechWork = await store.command(next.id, next.revision, 'draft.save', { chapterId, draft: spoken })
  assert.ok(validateChapter(speechWork, speechWork.chapters[0]).issues.some(item => item.path.endsWith('.narration')))
  await writeFile(store.filePath(work.id, 'state.json'), '{broken')
  await assert.rejects(store.get(work.id), hasCode('invalid_state'))
  assert.equal(await readFile(store.filePath(work.id, 'state.json'), 'utf8'), '{broken')
})

test('paths are work-contained and reject symlink escape; missing work is distinguished', async t => {
  const { store, work, cwd } = await fixture(t)
  assert.equal(store.filePath(work.id, '.'), join(store.root, 'works', work.id))
  assert.throws(() => store.filePath(work.id, '../other/state.json'), hasCode('unsafe_path'))
  assert.throws(() => store.filePath(work.id, '/tmp/outside'), hasCode('unsafe_path'))
  const link = store.filePath(work.id, 'outside')
  await symlink(cwd, link)
  assert.throws(() => store.filePath(work.id, 'outside/secret'), hasCode('unsafe_path'))
  await assert.rejects(store.get('missing_work'), hasCode('work_not_found'))
})

test('revising a source withdraws old fact confirmation in later chapters without erasing its evidence', async t => {
  let { store, work, chapterId } = await fixture(t)
  const original = structuredClone(work.chapters[0].sources[0])
  work = await store.command(work.id, work.revision, 'canon.save', { entry: { id: 'hero', kind: 'character', name: '沈舟', description: '船夫', aliases: [], knownFromChapter: 1 } })
  work = await store.command(work.id, work.revision, 'fact.save', { fact: { id: 'opened-door', subjectId: 'hero', text: '沈舟已打开木门', scope: 'source', origin: 'source', knownFromChapter: 1, storyTime: '清晨', confirmed: true, sourceChapterId: chapterId, sourceParagraphIds: [original.paragraphs[1].id] } })
  work = await store.command(work.id, work.revision, 'chapter.add', { title: '第二章', text: '沈舟等待来人。' })
  const nextChapterId = work.chapters[1].id
  assert.equal(contextFor(work, nextChapterId).facts[0].confirmed, true)
  work = await store.command(work.id, work.revision, 'chapter.source', { chapterId, text: '沈舟走到渡口。\n\n他没有推开门。' })
  const persisted = await store.get(work.id)
  const priorFact = persisted.facts[0]
  assert.equal(priorFact.confirmed, false)
  assert.equal(priorFact.needsReview, true)
  assert.equal(priorFact.sourceRevisionId, original.id)
  assert.deepEqual(priorFact.sourceParagraphIds, [original.paragraphs[1].id])
  assert.deepEqual(persisted.chapters[0].sources[0], original)
  const context = contextFor(persisted, nextChapterId)
  assert.equal(context.facts[0].confirmed, false)
  assert.ok(context.next.some(step => step.includes('opened-door') && step.includes('Review')))
  // Re-saving a fact with obsolete evidence cannot accidentally reconfirm it.
  work = await store.command(work.id, work.revision, 'fact.save', { fact: { ...priorFact, confirmed: true, needsReview: false } })
  assert.equal(work.facts[0].confirmed, false)
  const source = work.chapters[0].sources.find(item => item.id === work.chapters[0].sourceRevisionId)!
  work = await store.command(work.id, work.revision, 'fact.save', { fact: { ...work.facts[0], text: '沈舟没有打开木门', confirmed: true, sourceRevisionId: source.id, sourceParagraphIds: [source.paragraphs[1].id] } })
  assert.equal(work.facts[0].confirmed, true)
  assert.equal(work.facts[0].needsReview, undefined)
  assert.ok(!contextFor(work, nextChapterId).next.some(step => step.includes('opened-door')))
})
