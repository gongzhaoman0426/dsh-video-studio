/** Developer acceptance fixture; no LLM/provider request and no changes to a user's DSH profile. */
import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { StudioRuntime } from '../src/host/runtime.ts'
import { studioTools } from '../src/host/tools.ts'
import type { WorkState } from '../src/domain/types.ts'

const root = resolve('.test-output/demo')
const cwd = resolve(root, 'workspace')
await mkdir(cwd, { recursive: true })
const runtime = new StudioRuntime()
const tools = studioTools(runtime)
const exec = { agent: { session: { id: 'acceptance-demo', header: { cwd } } } }
async function call(name: string, args: object): Promise<any> {
  const tool = tools.find(item => item.name === `video_studio_${name}`)!
  return tool.execute(args, exec)
}
try {
  const created = await call('work', { action: 'create', title: '渡口 · 本地预演样例', style: '水墨写实；此工作区仅作插件验收', aspectRatio: '16:9' })
  const workspace = await runtime.workspace(created.workspaceId)
  let work: WorkState = created.work
  const source = await call('chapter', { workId: work.id, expectedRevision: work.revision, action: 'add', payload: { title: '第一章 · 雾中来客', text: '清晨，沈舟沿石阶走向渡口。雾遮住对岸，旧船系在木桩旁。\n\n他停下脚步，轻声说：“到了。”木门里传来脚步声。' } })
  const chapter = source.chapter
  const paragraphs = chapter.sources[0].paragraphs
  await call('draft', { workId: work.id, expectedRevision: source.work.revision, action: 'save', payload: {
    chapterId: chapter.id,
    draft: { summary: '沈舟到达雾中的渡口，门内脚步声引出下一章。', adaptationNotes: '验收用人工编写样例，不代表模型生成结果。',
      scenes: [{ id: 'scene_1', title: '渡口外', location: '渡口', time: '清晨', characterIds: [], beats: [
        { id: 'beat_1', kind: 'action', text: paragraphs[0].text, sourceParagraphIds: [paragraphs[0].id] },
        { id: 'beat_2', kind: 'narration', text: '到了。', sourceParagraphIds: [paragraphs[1].id] },
        { id: 'beat_3', kind: 'action', text: '木门里传来脚步声。', sourceParagraphIds: [paragraphs[1].id] },
      ] }],
      shots: [
        { id: 'shot_1', sceneId: 'scene_1', title: '雾中渡口', beatIds: ['beat_1'], description: '沈舟走下石阶，渡船隐在薄雾中。', prompt: '清晨水墨渡口，石阶与旧船，薄雾流动。', camera: '远景缓推', durationSec: 5, characterIds: [], assetIds: [], narration: '' },
        { id: 'shot_2', sceneId: 'scene_1', title: '门内脚步', beatIds: ['beat_2', 'beat_3'], description: '背对镜头的沈舟停在门前，门缝透出微光。', prompt: '旧木门前的人物背影，门缝一线微光，等待的气氛。', camera: '背影中景', durationSec: 5, characterIds: [], assetIds: [], narration: '到了。' },
      ],
    },
  } })
  work = await workspace.store.get(work.id)
  work = (await call('decision', { workId: work.id, expectedRevision: work.revision, chapterId: chapter.id, action: 'approve', note: '开发验收样例：明确采用该分镜做本地预演。' })).work
  await call('generate', { workId: work.id, expectedRevision: work.revision, chapterId: chapter.id, shotIds: ['shot_1', 'shot_2'], kind: 'image', mode: 'preview', operationId: 'demo-images' })
  await workspace.media.waitForIdle()
  work = await workspace.store.get(work.id)
  if (work.jobs.some(job => job.status !== 'succeeded')) throw new Error(JSON.stringify(work.jobs.map(job => ({ status: job.status, error: job.error }))))
  for (const take of work.takes) {
    work = (await call('take', { workId: work.id, expectedRevision: work.revision, chapterId: chapter.id, shotId: take.shotId, kind: take.kind, takeId: take.id })).work
  }
  await call('render', { workId: work.id, expectedRevision: work.revision, chapterId: chapter.id, voice: process.platform === 'darwin', subtitles: true })
  await workspace.media.waitForIdle()
  const delivery = await call('job', { workId: work.id, action: 'list' }) as {
    renders: WorkState['renders'];
    files: Array<{ renderId?: string; kind: string; path: string; available: boolean }>;
  }
  const render = delivery.renders.at(-1)!
  if (render.status !== 'completed') throw new Error(render.error ?? 'Render did not finish')
  const files = delivery.files.filter(file => file.renderId === render.id)
  if (files.length !== 3 || files.some(file => !file.available || !isAbsolute(file.path))) throw new Error('The conversation tool did not return all three available local deliverables')
  const delivered = (kind: string): string => {
    const file = files.find(item => item.kind === kind)
    if (!file) throw new Error(`Missing ${kind} deliverable`)
    return file.path
  }
  const receipt = { workspaceId: created.workspaceId, workId: work.id, chapterId: chapter.id, video: delivered('video'), subtitle: delivered('subtitle'), timeline: delivered('timeline'), durationSec: render.durationSec }
  await writeFile(resolve(root, 'receipt.json'), JSON.stringify(receipt, null, 2))
  console.log(JSON.stringify(receipt, null, 2))
} finally { await runtime.dispose() }
