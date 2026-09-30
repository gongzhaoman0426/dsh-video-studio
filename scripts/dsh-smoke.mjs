#!/usr/bin/env node
/** Integration test only: loads this plugin into built local DSH services, never changes the user's DSH. */
import assert from 'node:assert/strict'
import { access, mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const harnessRoot = process.argv[2]
if (!harnessRoot) throw new Error('Usage: node scripts/dsh-smoke.mjs /absolute/path/to/built/deepseek-harness')
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const importHarness = path => import(pathToFileURL(join(resolve(harnessRoot), path)).href)
const [{ Context }, { default: SystemPrompt }, { default: ToolRuntime }, { default: SkillRegistry }, plugin] = await Promise.all([
  importHarness('vendor/cordis/lib/index.js'),
  importHarness('packages/core/system-prompt/lib/index.js'),
  importHarness('packages/core/tools/lib/index.js'),
  importHarness('packages/skill/skill/lib/index.js'),
  import(pathToFileURL(join(projectRoot, 'lib/index.js')).href),
])
const temporary = await mkdtemp(join(tmpdir(), 'chapter-video-dsh-smoke-'))
const previousHome = process.env.DSH_HOME
const cwd = join(temporary, 'workspace')
await mkdir(cwd)
process.env.DSH_HOME = join(temporary, 'dsh-home')
const ctx = new Context()
let pluginFiber
try {
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  await ctx.plugin(SkillRegistry, {})
  pluginFiber = await ctx.plugin(plugin)
  const required = ['work', 'chapter', 'context', 'draft', 'canon', 'fact', 'decision', 'validate', 'generate', 'job', 'take', 'asset', 'render'].map(name => `video_studio_${name}`)
  for (const name of required) assert.ok(ctx.tools.get(name), `DSH registered ${name}`)
  const skills = await ctx.skills.list()
  assert.ok(skills.some(skill => skill.name === 'chapter-video-authoring'))
  assert.ok(skills.some(skill => skill.name === 'chapter-video-production'))
  const authoring = await ctx.skills.get('chapter-video-authoring')
  assert.ok(authoring?.content.includes('sourceParagraphIds'), 'The loaded authoring skill describes actual draft fields')
  assert.ok(!authoring.content.trimStart().startsWith('---'), 'Runtime skill content excludes YAML frontmatter')
  const production = await ctx.skills.get('chapter-video-production')
  assert.ok(production?.content && !production.content.trimStart().startsWith('---'), 'Production skill content excludes YAML frontmatter')
  const assembly = await ctx.systemPrompt.assemble({})
  assert.ok(assembly.sections.some(section => section.name === 'chapter-video-studio-workflow'))
  assert.ok(assembly.tools.some(tool => tool.name === 'video_studio_work'))
  const agent = { session: { id: 'smoke-session-1', header: { cwd } } }
  let callSequence = 0
  const run = async (name, args) => {
    const outcome = await ctx.tools.execute({ name: `video_studio_${name}`, arguments: args, agent, callId: `smoke_${++callSequence}`, signal: new AbortController().signal })
    assert.equal(outcome.isError, false, `${name} failed through real DSH ToolRuntime: ${JSON.stringify(outcome.error ?? outcome.content)}`)
    assert.ok(outcome.value && typeof outcome.value === 'object')
    assert.ok(outcome.content.some(block => block.type === 'text'))
    return outcome.value
  }
  const created = await run('work', { action: 'create', title: '渡口：DSH 集成验证', style: '水墨', aspectRatio: '16:9' })
  const workId = created.work.id
  const original = '船夫走到渡口。'
  const added = await run('chapter', { workId, expectedRevision: created.work.revision, action: 'add', payload: { title: '第一章', text: original } })
  assert.equal(added.chapter.sources[0].text, original)
  assert.equal(added.chapter.draft, undefined)
  const chapterId = added.chapter.id
  const paragraphId = added.chapter.sources[0].paragraphs[0].id
  const saved = await run('draft', { workId, expectedRevision: added.work.revision, action: 'save', payload: { chapterId, draft: {
    summary: '船夫抵达渡口。', adaptationNotes: '',
    scenes: [{ id: 'smoke_scene1', title: '抵达', location: '渡口', time: '清晨', characterIds: [], beats: [{ id: 'smoke_beat1', kind: 'action', text: original, sourceParagraphIds: [paragraphId] }] }],
    shots: [{ id: 'smoke_shot1', sceneId: 'smoke_scene1', title: '抵达渡口', beatIds: ['smoke_beat1'], description: '船夫走向木船', prompt: '晨雾中船夫走向木船，固定镜头', camera: '全景', durationSec: 5, characterIds: [], assetIds: [], narration: '' }],
  } } })
  assert.equal(saved.validation.valid, true)
  const approved = await run('decision', { workId, expectedRevision: saved.work.revision, chapterId, action: 'approve', note: '测试用户明确确认当前分镜' })
  assert.equal(approved.work.chapters[0].approvedRevision, approved.work.chapters[0].revision)
  const revised = await run('draft', { workId, expectedRevision: approved.work.revision, action: 'shot', payload: { chapterId, shotId: 'smoke_shot1', patch: { camera: '背影中景', prompt: '从船夫背后看木船，晨雾' } } })
  assert.equal(revised.chapter.approvedRevision, undefined)
  const stale = await ctx.tools.execute({ name: 'video_studio_draft', arguments: { workId, expectedRevision: saved.work.revision, action: 'shot', payload: { chapterId, shotId: 'smoke_shot1', patch: { camera: '不可覆盖' } } }, agent, callId: `smoke_${++callSequence}`, signal: new AbortController().signal })
  assert.equal(stale.isError, true, 'DSH surfaces optimistic concurrency rejection as a tool failure')
  const restored = await run('context', {})
  assert.equal(restored.chapter.id, chapterId)
  assert.equal(restored.chapter.draft.shots[0].camera, '背影中景')
  const beforeTeardown = { tools: required.length, skills: skills.filter(skill => skill.provider === 'dsh-chapter-video-studio').length, executedCalls: callSequence, chapterRoundTrip: true, optimisticConflict: true, providerCalls: 0 }
  await pluginFiber.dispose(); pluginFiber = undefined
  for (const name of required) assert.equal(ctx.tools.get(name), undefined, `Plugin disposal removes ${name}`)
  assert.equal(await ctx.skills.get('chapter-video-authoring'), undefined)
  await assert.rejects(access(join(temporary, 'dsh-home')), { code: 'ENOENT' }, 'Conversation tools must not create a global workspace registry')
  console.log(JSON.stringify({ ok: true, harnessRoot: resolve(harnessRoot), ...beforeTeardown, teardown: true }, null, 2))
} finally {
  if (pluginFiber) await pluginFiber.dispose()
  await ctx.fiber.dispose()
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  await rm(temporary, { recursive: true, force: true })
}
