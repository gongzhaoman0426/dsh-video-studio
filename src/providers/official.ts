// Ark endpoint/request shapes were evaluated against the MIT-licensed reference
// dsh-video-studio/src/providers/doubao.ts at 36198b8. This adapter is newly written;
// model IDs and reference capabilities must be configured for the user's account.
import { readFile } from 'node:fs/promises'
import { hash } from '../media/process.ts'
import { ProviderError, type MediaProvider, type MediaRequest, type MediaArtifact } from './types.ts'

export interface ArkOptions {
  apiKey?: string; baseUrl?: string; imageModel?: string; videoModel?: string;
  imageReferences?: boolean; videoReferences?: boolean; videoDurations?: number[];
  imageSize?: string; fetchImpl?: typeof fetch; timeoutMs?: number;
}
function endpoint(value: string): string {
  const url = new URL(value)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Provider endpoint must be an HTTP(S) URL without credentials, query or fragment')
  return url.toString().replace(/\/$/, '')
}
async function imageData(request: MediaRequest): Promise<string[]> {
  return Promise.all(request.references.map(async (ref) => {
    if (!/^image\/(png|jpeg|webp)$/.test(ref.mimeType)) throw new ProviderError(`Unsupported reference format: ${ref.mimeType}`)
    const bytes = await readFile(ref.path)
    if (bytes.length > 15 * 1024 * 1024) throw new ProviderError('Reference image exceeds the local 15 MB limit')
    return `data:${ref.mimeType};base64,${bytes.toString('base64')}`
  }))
}
async function jsonCall(fetcher: typeof fetch, url: string, key: string, method: string, data: unknown, signal: AbortSignal, timeoutMs: number): Promise<any> {
  let response: Response
  try {
    response = await fetcher(url, { method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) })
  } catch { throw new ProviderError(`${method} request interrupted; acceptance cannot be determined`, method === 'POST') }
  if (!response.ok) throw new ProviderError(`Provider rejected ${method} request: HTTP ${response.status}`, method === 'POST' && (response.status >= 500 || response.status === 408))
  try { return await response.json() } catch { throw new ProviderError('Provider returned an unreadable response', method === 'POST') }
}
function imageResult(data: any): MediaArtifact {
  const output = data?.data?.[0]
  if (typeof output?.url === 'string' && /^https?:\/\//.test(output.url)) return { url: output.url }
  if (typeof output?.b64_json === 'string') return { bytes: Buffer.from(output.b64_json, 'base64'), mimeType: 'image/png' }
  throw new ProviderError('Image response contains no usable output; do not automatically resubmit', true)
}
export function createArkProvider(options: ArkOptions = {}): MediaProvider {
  const base = endpoint(options.baseUrl ?? 'https://ark.cn-beijing.volces.com/api/v3')
  const key = options.apiKey ?? '', fetcher = options.fetchImpl ?? fetch, timeout = options.timeoutMs ?? 120_000
  const durations = options.videoDurations ?? [5, 10]
  return {
    id: 'ark', configId: hash(JSON.stringify([base, key, options.imageModel, options.videoModel, options.imageReferences, options.videoReferences, durations, options.imageSize])),
    label: '火山方舟 / Ark（账号配置的模型）', mode: 'production', kinds: ['image', 'video'], configured: Boolean(key && (options.imageModel || options.videoModel)),
    models: { image: options.imageModel, video: options.videoModel },
    validate(request) {
      if (!key) throw new ProviderError('Configure the Ark API Key in DSH plugin settings (or DSH_VIDEO_ARK_API_KEY when using environment configuration)')
      if (!request.model) throw new ProviderError(`Configure the Ark ${request.kind} model in DSH plugin settings before submitting`)
      if (request.model !== (request.kind === 'image' ? options.imageModel : options.videoModel)) throw new ProviderError('Requested model differs from the configured and capability-checked Ark model')
      if (request.kind === 'audio') throw new ProviderError('Ark adapter has no audio generation capability')
      if (request.kind === 'video' && !durations.includes(request.durationSec)) throw new ProviderError(`Configured Ark video durations: ${durations.join(', ')} seconds. Revise the shot explicitly; durations are never rounded.`)
      if (request.references.length && !(request.kind === 'image' ? options.imageReferences : options.videoReferences)) throw new ProviderError(`Reference input is not enabled for the configured Ark ${request.kind} model`)
      if (request.kind === 'video' && request.references.length > 1) throw new ProviderError('This adapter supports one first-frame reference per video; combine/choose references explicitly')
    },
    async submit(request) {
      const references = await imageData(request)
      if (request.kind === 'image') {
        const size = options.imageSize ?? (request.aspectRatio === '16:9' ? '2560x1440' : request.aspectRatio === '9:16' ? '1440x2560' : '2048x2048')
        const body = { model: request.model, prompt: request.prompt + (request.negative ? `\n避免：${request.negative}` : ''), size, response_format: 'url', ...(references.length ? { image: references.length === 1 ? references[0] : references } : {}) }
        return { artifact: imageResult(await jsonCall(fetcher, `${base}/images/generations`, key, 'POST', body, request.signal, timeout)) }
      }
      const content: unknown[] = [{ type: 'text', text: request.prompt + (request.negative ? `\n避免：${request.negative}` : '') }]
      if (references[0]) content.push({ type: 'image_url', image_url: { url: references[0] }, role: 'first_frame' })
      const data = await jsonCall(fetcher, `${base}/contents/generations/tasks`, key, 'POST', { model: request.model, content, ratio: request.aspectRatio, duration: request.durationSec, generate_audio: false, watermark: true }, request.signal, timeout)
      if (typeof data?.id !== 'string' || !data.id) throw new ProviderError('Video submission returned no remote ID; acceptance is unknown', true)
      return { remoteId: data.id }
    },
    async poll(remoteId, request) {
      const data = await jsonCall(fetcher, `${base}/contents/generations/tasks/${encodeURIComponent(remoteId)}`, key, 'GET', undefined, request.signal, Math.min(timeout, 30_000))
      const status = String(data?.status ?? 'unknown')
      if (status === 'succeeded') {
        const url = data?.content?.video_url
        if (typeof url !== 'string' || !/^https?:\/\//.test(url)) throw new Error('Completed Ark job has no video URL; retry querying the same remote ID')
        return { state: 'succeeded', artifact: { url, mimeType: 'video/mp4' }, remoteStatus: status }
      }
      if (['failed', 'expired', 'cancelled'].includes(status)) return { state: status === 'cancelled' ? 'cancelled' : 'failed', error: `Remote task ${status}`, remoteStatus: status }
      return { state: 'running', remoteStatus: status }
    },
  }
}

export interface TtsOptions { apiKey?: string; baseUrl?: string; model?: string; voice?: string; fetchImpl?: typeof fetch; timeoutMs?: number }
export function createTtsProvider(options: TtsOptions = {}): MediaProvider {
  const base = endpoint(options.baseUrl ?? 'https://api.openai.com/v1'), key = options.apiKey ?? '', fetcher = options.fetchImpl ?? fetch
  return {
    id: 'compatible-tts', configId: hash(JSON.stringify([base, key, options.model, options.voice])), label: '配置的 OpenAI-compatible TTS', mode: 'production', kinds: ['audio'],
    configured: Boolean(key && options.model && options.voice), models: { audio: options.model },
    validate(request) {
      if (!key || !request.model || !options.voice) throw new ProviderError('Configure the TTS API Key, model and voice in DSH plugin settings (or DSH_VIDEO_TTS_API_KEY, DSH_VIDEO_TTS_MODEL and DSH_VIDEO_TTS_VOICE when using environment configuration)')
      if (request.model !== options.model) throw new ProviderError('Requested model differs from the configured TTS model')
      if (request.kind !== 'audio' || !request.text?.trim()) throw new ProviderError('TTS requires a non-empty narration audio request')
      if (request.references.length) throw new ProviderError('This TTS adapter does not support reference voices')
    },
    async submit(request) {
      let response: Response
      try {
        response = await fetcher(`${base}/audio/speech`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: request.model, voice: options.voice, input: request.text, response_format: 'mp3' }), signal: AbortSignal.any([request.signal, AbortSignal.timeout(options.timeoutMs ?? 120_000)]) })
      } catch { throw new ProviderError('TTS submit response was lost; acceptance is unknown', true) }
      if (!response.ok) throw new ProviderError(`TTS returned HTTP ${response.status}`, response.status >= 500 || response.status === 408)
      try { return { artifact: { bytes: new Uint8Array(await response.arrayBuffer()), mimeType: 'audio/mpeg' } } } catch { throw new ProviderError('TTS response body interrupted; do not automatically resubmit', true) }
    },
  }
}
export function environmentProviders(env: NodeJS.ProcessEnv = process.env): MediaProvider[] {
  return [createArkProvider({ apiKey: env.DSH_VIDEO_ARK_API_KEY, baseUrl: env.DSH_VIDEO_ARK_BASE_URL, imageModel: env.DSH_VIDEO_ARK_IMAGE_MODEL, videoModel: env.DSH_VIDEO_ARK_VIDEO_MODEL, imageReferences: env.DSH_VIDEO_ARK_IMAGE_REFERENCES === '1', videoReferences: env.DSH_VIDEO_ARK_VIDEO_REFERENCES === '1', imageSize: env.DSH_VIDEO_ARK_IMAGE_SIZE, videoDurations: env.DSH_VIDEO_ARK_VIDEO_DURATIONS?.split(',').map(Number).filter(Number.isFinite) }), createTtsProvider({ apiKey: env.DSH_VIDEO_TTS_API_KEY, baseUrl: env.DSH_VIDEO_TTS_BASE_URL, model: env.DSH_VIDEO_TTS_MODEL, voice: env.DSH_VIDEO_TTS_VOICE })]
}
