import { StudioRuntime } from './host/runtime.ts'
import { studioTools, type ToolDefinition } from './host/tools.ts'
import { parseBundledSkill } from './host/skills.ts'
import { Config, configuredProviders, type StudioConfig } from './config.ts'
import chapterSkill from '../skills/chapter-video-authoring/SKILL.md'
import productionSkill from '../skills/chapter-video-production/SKILL.md'

export const name = 'dsh-chapter-video-studio'
export { Config }
export const inject = ['tools', 'skills', 'systemPrompt']

/** Narrow structural faces keep this plugin independent of DSH's unpublished internal source tree. */
export interface HostContext {
  tools: { register(tool: ToolDefinition): () => void }
  skills: { register(skill: { name: string; description: string; content: string; source: 'runtime'; provider: string }): () => void }
  systemPrompt: { section(section: { name: string; order: number; text: string }): () => void }
  effect(effect: () => (() => void | Promise<void>) | void, label?: string): unknown
  logger?: { error(message: string, error?: unknown): void }
}

export function apply(ctx: HostContext, config: StudioConfig = Config({})): void {
  const runtime = new StudioRuntime({ providers: () => configuredProviders(config) })
  for (const tool of studioTools(runtime)) ctx.effect(() => ctx.tools.register(tool), tool.name)
  for (const raw of [chapterSkill, productionSkill]) {
    const skill = parseBundledSkill(raw)
    ctx.effect(() => ctx.skills.register({ ...skill, source: 'runtime', provider: 'dsh-chapter-video-studio' }), skill.name)
  }
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'chapter-video-studio-workflow', order: 75,
    text: '小说视频创作使用 video_studio_* 工具。用户贴一章时先保存原文、读取当前作品上下文与 chapter-video-authoring 技能，按用户意图逐步讨论剧本和分镜。不要要求整本书或总集数，不要用标点切句代替创作，不要自建第二套 LLM 编排。所有写操作使用最近 work.revision；冲突时重读。原文、已确认设定与模型推测分开。重要改编、镜头采用及生成范围遵循用户已表达的意愿，不虚构确认、不重复询问已授权事项。需要真实媒体时读取 chapter-video-production；preview 只能称本地预演。工具结果 JSON 是可恢复事实源，下一章先读 context。生成提交与查询分开，未知提交不盲目重提。',
  }), 'chapter video studio guidance')
  ctx.effect(() => () => runtime.dispose(), 'chapter video studio lifetime')
}
