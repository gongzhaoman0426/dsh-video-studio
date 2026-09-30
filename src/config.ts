import z from '@deepseek-ai/schemastery'
import { createArkProvider, createTtsProvider, environmentProviders } from './providers/official.ts'
import type { MediaProvider } from './providers/types.ts'

export const SETTINGS_NS = 'dsh-chapter-video-studio'

export interface StudioSettings {
  source: 'settings' | 'environment'
  ark: {
    apiKey: string; baseUrl: string; imageModel: string; videoModel: string
    imageReferences: boolean; videoReferences: boolean; videoDurations: number[]; imageSize: string
  }
  tts: { apiKey: string; baseUrl: string; model: string; voice: string }
}

const endpoint = (value: string) => z.string().pattern(/^https?:\/\/[^\s@?#]+$/).default(value).description('服务接口根地址，包含版本路径，不包含密钥或具体生成端点').volatile()
const secret = () => z.string().role('secret').description('API Key；DSH 设置读取时脱敏，空白输入不覆盖已有密钥').volatile()

/** DSH projects these live leaves into its profile-backed Settings service. */
export const Config = z.object({
  source: z.union(['settings', 'environment']).default('settings').description('配置来源：DSH 设置或宿主环境变量；两者不混用').volatile(),
  ark: z.object({
    apiKey: secret(),
    baseUrl: endpoint('https://ark.cn-beijing.volces.com/api/v3'),
    imageModel: z.string().default('').description('图片模型或接入点 ID').volatile(),
    videoModel: z.string().default('').description('视频模型或接入点 ID').volatile(),
    imageReferences: z.boolean().default(false).description('图片模型支持参考图输入').volatile(),
    videoReferences: z.boolean().default(false).description('视频模型支持首帧参考图').volatile(),
    videoDurations: z.array(z.number().min(1).max(120).step(1)).min(1).max(120).default([5, 10]).description('模型支持的整数秒数；不自动调整镜头时长').volatile(),
    imageSize: z.string().default('').description('可选图片尺寸；留空跟随作品画幅').volatile(),
  }),
  tts: z.object({
    apiKey: secret(),
    baseUrl: endpoint('https://api.openai.com/v1'),
    model: z.string().default('').description('配音模型 ID').volatile(),
    voice: z.string().default('').description('该配音服务支持的音色 ID').volatile(),
  }),
})
export type StudioConfig = ReturnType<typeof Config>

/** This snapshot stays on the Host; never expose it in a tool result or log. */
export function settingsSnapshot(config: StudioConfig): StudioSettings {
  return {
    source: config.source.get(),
    ark: {
      apiKey: config.ark.apiKey.get() ?? '', baseUrl: config.ark.baseUrl.get(),
      imageModel: config.ark.imageModel.get(), videoModel: config.ark.videoModel.get(),
      imageReferences: config.ark.imageReferences.get(), videoReferences: config.ark.videoReferences.get(),
      videoDurations: Array.from(config.ark.videoDurations.get()), imageSize: config.ark.imageSize.get(),
    },
    tts: { apiKey: config.tts.apiKey.get() ?? '', baseUrl: config.tts.baseUrl.get(), model: config.tts.model.get(), voice: config.tts.voice.get() },
  }
}

export function configuredProviders(config: StudioConfig, env: NodeJS.ProcessEnv = process.env): MediaProvider[] {
  const value = settingsSnapshot(config)
  if (value.source === 'environment') return environmentProviders(env)
  return [
    createArkProvider({ ...value.ark, imageModel: value.ark.imageModel || undefined, videoModel: value.ark.videoModel || undefined, imageSize: value.ark.imageSize || undefined }),
    createTtsProvider({ ...value.tts, model: value.tts.model || undefined, voice: value.tts.voice || undefined }),
  ]
}
