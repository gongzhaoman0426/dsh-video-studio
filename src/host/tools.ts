import { z } from 'zod'
import { stat } from 'node:fs/promises'
import { contextFor, validateChapter } from '../domain/validate.ts'
import type { WorkState } from '../domain/types.ts'
import type { StudioRuntime, WorkspaceRuntime } from './runtime.ts'
import { publicJson } from './public.ts'

export interface ToolExecution { signal?: AbortSignal; agent?: { session?: { id?: string; header?: { id?: string; cwd?: string } } } }
export interface ToolDefinition {
  name: string; description: string; parameters: Record<string, unknown>;
  output: { schema: Record<string, unknown>; render(args: unknown, value: unknown): Array<{ type: 'text'; text: string }> };
  execute(args: unknown, execution: ToolExecution): Promise<unknown>;
}
const text = (description: string) => ({ type: 'string', description })
const integer = (description: string) => ({ type: 'integer', description })
const choice = (values: string[], description: string) => ({ type: 'string', enum: values, description })
const data = (description: string) => ({ type: 'object', additionalProperties: true, description })
const object = z.record(z.unknown())
const workInput = z.object({ workId: z.string().min(1) })
const writeInput = workInput.extend({ expectedRevision: z.number().int().nonnegative() })

/** Local paths let DSH deliver artifacts using its existing conversation/file capabilities. */
async function artifactFiles(store: WorkspaceRuntime['store'], work: WorkState) {
  const entries = [
    ...work.assets.map(asset => ({ assetId: asset.id, name: asset.name, kind: asset.kind as string, mimeType: asset.mimeType, path: asset.path })),
    ...work.renders.filter(render => render.status === 'completed').flatMap(render => [
      { renderId: render.id, chapterId: render.chapterId, name: '章节视频', kind: 'video', mimeType: 'video/mp4', path: render.videoPath },
      { renderId: render.id, chapterId: render.chapterId, name: '章节字幕', kind: 'subtitle', mimeType: 'text/plain', path: render.subtitlePath },
      { renderId: render.id, chapterId: render.chapterId, name: '时间线记录', kind: 'timeline', mimeType: 'application/json', path: render.timelinePath },
    ].filter((file): file is typeof file & { path: string } => Boolean(file.path))),
  ]
  return Promise.all(entries.map(async file => {
    const path = store.filePath(work.id, file.path)
    const available = await stat(path).then(info => info.isFile(), () => false)
    return { ...file, path, available }
  }))
}

async function environment(runtime: StudioRuntime, exec: ToolExecution): Promise<WorkspaceRuntime & { sessionId: string }> {
  exec.signal?.throwIfAborted()
  const session = exec.agent?.session
  const cwd = session?.header?.cwd
  if (!cwd) throw new Error('缺少 DSH 会话工作目录。请在有工作区的会话中使用小说工作室。')
  const sessionId = session?.id ?? session?.header?.id
  if (!sessionId) throw new Error('缺少 DSH sessionId，无法可靠绑定当前章节')
  return { ...await runtime.register(cwd), sessionId }
}

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[], execute: ToolDefinition['execute']): ToolDefinition {
  return {
    name: `video_studio_${name}`, description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    async execute(args, exec) { return JSON.parse(publicJson(await execute(object.parse(args), exec))) as object },
  }
}

/** Tools persist model-authored drafts. No deterministic sentence splitting is used as a planner. */
export function studioTools(runtime: StudioRuntime): ToolDefinition[] {
  const common = { workId: text('作品 ID；使用 work 工具建立或查看'), expectedRevision: integer('最近读取的作品 revision；冲突时重读，不盲目覆盖') }
  const tools: ToolDefinition[] = []
  tools.push(tool('work', '建立、列出或打开章节视频作品。open 绑定当前 DSH 会话；不要求整本小说或总集数。', {
    action: choice(['create', 'list', 'open'], '操作'), workId: common.workId, title: text('作品标题'), style: text('视觉风格约束'), aspectRatio: choice(['16:9', '9:16', '1:1'], '默认 16:9'),
  }, ['action'], async (raw, exec) => {
    const args = z.object({ action: z.enum(['create', 'list', 'open']), workId: z.string().optional(), title: z.string().optional(), style: z.string().optional(), aspectRatio: z.enum(['16:9', '9:16', '1:1']).optional() }).parse(raw)
    const { store, entry, sessionId } = await environment(runtime, exec)
    if (args.action === 'list') return { workspaceId: entry.id, works: await store.list(), binding: await store.binding(sessionId) }
    const work = args.action === 'create' ? await store.create({ title: z.string().min(1).parse(args.title), style: args.style, aspectRatio: args.aspectRatio }) : await store.get(z.string().min(1).parse(args.workId))
    await store.bind(sessionId, work.id)
    return { workspaceId: entry.id, work, next: '将本章正文原样交给 video_studio_chapter add，再读取 chapter-video-authoring 技能进行创作。' }
  }))
  tools.push(tool('chapter', '保存用户贴入的一章原文或原文修订；不改写正文、不自动拆镜。', { ...common, action: choice(['add', 'source'], '新增章节或更新来源'), payload: data('add: {title,text,order?}；source: {chapterId,text}') }, ['workId', 'expectedRevision', 'action', 'payload'], async (raw, exec) => {
    const args = writeInput.extend({ action: z.enum(['add', 'source']), payload: object }).parse(raw)
    const { store, entry, sessionId } = await environment(runtime, exec)
    const work = await store.command(args.workId, args.expectedRevision, `chapter.${args.action}`, args.payload, sessionId)
    const chapter = args.action === 'source' ? work.chapters.find(c => c.id === args.payload.chapterId) : work.chapters.find(c => c.sources.some(s => s.text === args.payload.text))
    if (chapter) await store.bind(sessionId, work.id, chapter.id)
    return { workspaceId: entry.id, ...contextFor(work, chapter?.id) }
  }))
  tools.push(tool('context', '读取当前章节、原文段落 ID、已知设定、剧情事实、决定和待办。续作先读此工具。', { workId: common.workId, chapterId: text('不提供时使用当前会话绑定'), full: { type: 'boolean', description: 'true 返回完整作品及素材任务；通常使用默认的本章上下文' } }, [], async (raw, exec) => {
    const args = z.object({ workId: z.string().optional(), chapterId: z.string().optional(), full: z.boolean().optional() }).parse(raw)
    const { store, media, entry, sessionId } = await environment(runtime, exec)
    const binding = await store.binding(sessionId)
    const id = args.workId ?? binding?.workId
    if (!id) return { workspaceId: entry.id, works: await store.list(), next: '先使用 video_studio_work create/open' }
    const chapterId = args.chapterId ?? (binding?.workId === id ? binding.chapterId : undefined)
    const work = await store.get(id)
    if (chapterId) await store.bind(sessionId, id, chapterId)
    return { workspaceId: entry.id, ...(args.full ? { work } : contextFor(work, chapterId)), capabilities: await media.diagnostics() }
  }))
  tools.push(tool('draft', '保存 DeepSeek 创作的结构化剧本/分镜，或只改指定镜头。正文→场次→动作/台词→镜头必须可追溯。先读 chapter-video-authoring 技能了解字段。', { ...common, action: choice(['save', 'shot'], '保存整章草案或局部修改'), payload: data('save: {chapterId,draft:{summary,adaptationNotes,scenes,shots}}；shot: {chapterId,shotId,patch}') }, ['workId', 'expectedRevision', 'action', 'payload'], async (raw, exec) => {
    const args = writeInput.extend({ action: z.enum(['save', 'shot']), payload: object }).parse(raw)
    const { store, sessionId } = await environment(runtime, exec)
    const work = await store.command(args.workId, args.expectedRevision, args.action === 'save' ? 'draft.save' : 'shot.update', args.payload, sessionId)
    const chapter = work.chapters.find(c => c.id === args.payload.chapterId)
    return { ...contextFor(work, chapter?.id), validation: chapter ? validateChapter(work, chapter) : undefined }
  }))
  tools.push(tool('canon', '登记共享角色、场景、道具或风格。已知章节范围防止后章设定覆盖前章；修改同一实体保留 id。', { ...common, entry: data('{id?,kind:character|location|prop|style,name,description,aliases:[],knownFromChapter:章节序号,assetId?}') }, ['workId', 'expectedRevision', 'entry'], async (raw, exec) => {
    const args = writeInput.extend({ entry: object }).parse(raw)
    const { store, sessionId } = await environment(runtime, exec)
    return { work: await store.command(args.workId, args.expectedRevision, 'canon.save', { entry: args.entry }, sessionId) }
  }))
  tools.push(tool('fact', '保存跨章剧情事实、推测或用户决定。原著 source 与改编 adaptation 分开；推测不能假装已确认。', { ...common, fact: data('{id?,subjectId,text,scope:source|adaptation,origin:source|user|inference|adaptation,knownFromChapter,storyTime,confirmed,sourceChapterId?,sourceRevisionId?,sourceParagraphIds:[]}') }, ['workId', 'expectedRevision', 'fact'], async (raw, exec) => {
    const args = writeInput.extend({ fact: object }).parse(raw)
    const { store, sessionId } = await environment(runtime, exec)
    return { work: await store.command(args.workId, args.expectedRevision, 'fact.save', { fact: args.fact }, sessionId) }
  }))
  tools.push(tool('decision', '记录用户已表达的确认、撤销或改编意见。approve 先校验当前章并绑定该修订；不得替用户编造确认。', { ...common, chapterId: text('章节 ID'), action: choice(['approve', 'revoke', 'note'], '记录的决定'), note: text('用户决定与范围原意') }, ['workId', 'expectedRevision', 'chapterId', 'action', 'note'], async (raw, exec) => {
    const args = writeInput.extend({ chapterId: z.string(), action: z.enum(['approve', 'revoke', 'note']), note: z.string().min(1) }).parse(raw)
    const { store, sessionId } = await environment(runtime, exec)
    const payload = args.action === 'note' ? { chapterId: args.chapterId, text: args.note } : { chapterId: args.chapterId, note: args.note }
    return { work: await store.command(args.workId, args.expectedRevision, args.action === 'note' ? 'note.add' : `chapter.${args.action}`, payload, sessionId) }
  }))
  tools.push(tool('validate', '检查分镜覆盖、来源引用、人物、场次及对白时长。只读，不发起媒体生成。', { workId: common.workId, chapterId: text('章节 ID') }, ['workId', 'chapterId'], async (raw, exec) => {
    const args = workInput.extend({ chapterId: z.string() }).parse(raw)
    const { store } = await environment(runtime, exec)
    const work = await store.get(args.workId)
    const chapter = work.chapters.find(c => c.id === args.chapterId)
    if (!chapter) throw new Error('章节不存在')
    return validateChapter(work, chapter)
  }))
  tools.push(tool('generate', '为已确认镜头创建图片/视频/配音任务并立即返回任务记录。preview 是明确标记的本地预演，不是 AI 画面；production 使用已配置通道。查询用 job，不要重复提交。', { ...common, chapterId: text('章节 ID'), shotIds: { type: 'array', items: { type: 'string' }, description: '明确选定的镜头范围' }, kind: choice(['image', 'video', 'audio'], '媒介'), mode: choice(['preview', 'production'], '模式'), operationId: text('本次用户操作唯一键；重复投递沿用，有意再做一版使用新键'), providerId: text('使用 context 返回的供应商 ID'), model: text('可选模型 ID，按通道能力使用') }, ['workId', 'expectedRevision', 'chapterId', 'shotIds', 'kind', 'mode', 'operationId'], async (raw, exec) => {
    const args = writeInput.extend({ chapterId: z.string(), shotIds: z.array(z.string()).min(1).max(200), kind: z.enum(['image', 'video', 'audio']), mode: z.enum(['preview', 'production']), operationId: z.string().min(1).max(128), providerId: z.string().optional(), model: z.string().optional() }).parse(raw)
    const { media } = await environment(runtime, exec)
    return { work: await media.generate(args.workId, args, args.expectedRevision), next: '任务已保存。使用 video_studio_job list 查询；用户采用候选后才合成。' }
  }))
  tools.push(tool('job', '列出任务、候选与交付文件的本地绝对路径，恢复已知远端任务查询，或请求取消。files.available 表示文件仍在本地；resume 不盲目重新提交未知任务。', { workId: common.workId, action: choice(['list', 'resume', 'cancel'], '操作'), jobId: text('取消时必填') }, ['workId', 'action'], async (raw, exec) => {
    const args = workInput.extend({ action: z.enum(['list', 'resume', 'cancel']), jobId: z.string().optional() }).parse(raw)
    const { store, media } = await environment(runtime, exec)
    if (args.action === 'list') { const work = await store.get(args.workId); return { revision: work.revision, jobs: work.jobs, takes: work.takes, renders: work.renders, assets: work.assets, files: await artifactFiles(store, work) } }
    return { work: args.action === 'resume' ? await media.resume(args.workId) : await media.cancel(args.workId, z.string().min(1).parse(args.jobId)) }
  }))
  tools.push(tool('take', '采用用户选中的生成候选。保留其他候选和原有成片，不自动采用不明结果。', { ...common, chapterId: text('章节 ID'), shotId: text('镜头 ID'), kind: choice(['image', 'video', 'audio'], '采用的媒介'), takeId: text('候选 ID') }, ['workId', 'expectedRevision', 'chapterId', 'shotId', 'kind', 'takeId'], async (raw, exec) => {
    const args = writeInput.extend({ chapterId: z.string(), shotId: z.string(), kind: z.enum(['image', 'video', 'audio']), takeId: z.string() }).parse(raw)
    const { store, sessionId } = await environment(runtime, exec)
    return { work: await store.command(args.workId, args.expectedRevision, 'take.select', { chapterId: args.chapterId, shotId: args.shotId, kind: args.kind, takeId: args.takeId }, sessionId) }
  }))
  tools.push(tool('asset', '将用户提供的本地参考图/声音/视频复制到当前作品资产库。随后通过 assetId 绑定设定或分镜；不读取其他作品的凭证。', { ...common, path: text('用户提供的本地文件绝对路径'), name: text('资产名称'), kind: choice(['image', 'video', 'audio'], '媒介'), entityId: text('关联角色/场景/道具 ID，可选') }, ['workId', 'expectedRevision', 'path', 'name', 'kind'], async (raw, exec) => {
    const args = writeInput.extend({ path: z.string(), name: z.string(), kind: z.enum(['image', 'video', 'audio']), entityId: z.string().optional() }).parse(raw)
    const { media } = await environment(runtime, exec)
    return { work: await media.importAsset(args.workId, args, args.expectedRevision) }
  }))
  tools.push(tool('render', '使用本章已采用镜头合成 MP4、SRT 和时间线。字幕/剪辑改变仅重渲染，不调用图像视频模型。voice=true 在缺少已选音频时尝试本地配音。', { ...common, chapterId: text('章节 ID'), voice: { type: 'boolean', description: '是否为缺少声音的镜头生成本地配音，默认 false' }, subtitles: { type: 'boolean', description: '是否生成字幕，默认 true；支持时烧录，否则 MP4 软字幕与 SRT' } }, ['workId', 'expectedRevision', 'chapterId'], async (raw, exec) => {
    const args = writeInput.extend({ chapterId: z.string(), voice: z.boolean().optional(), subtitles: z.boolean().optional() }).parse(raw)
    const { media } = await environment(runtime, exec)
    return { work: await media.render(args.workId, args, args.expectedRevision), next: '使用 video_studio_job list 查看渲染记录和 files。本地文件就绪后在当前 DSH 会话交付，不启动额外页面。' }
  }))
  return tools
}
