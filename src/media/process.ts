import { spawn } from 'node:child_process'
import { access, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { MediaKind } from '../domain/types.ts'

export interface ProcessOptions { signal?: AbortSignal; timeoutMs?: number; cwd?: string }
export function run(command: string, args: string[], options: ProcessOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(new Error('Operation interrupted'))
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: options.cwd, shell: false })
    let stdout = '', stderr = '', interrupted = false, killTimer: ReturnType<typeof setTimeout> | undefined
    const stop = () => { interrupted = true; child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 1500); killTimer.unref() }
    const timer = setTimeout(stop, options.timeoutMs ?? 120_000)
    options.signal?.addEventListener('abort', stop, { once: true })
    child.stdout.on('data', (data) => { stdout = (stdout + data).slice(-1_000_000) })
    child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-8000) })
    const cleanup = () => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); options.signal?.removeEventListener('abort', stop) }
    child.on('error', (error) => { cleanup(); reject(error) })
    child.on('close', (code) => { cleanup(); code === 0 && !interrupted ? resolve(stdout) : reject(new Error(interrupted ? 'Media process interrupted or timed out' : `${command} failed (${code}): ${stderr.slice(-1600)}`)) })
  })
}

export async function available(command: string): Promise<boolean> {
  try { await run(command, command === 'say' ? ['-v', '?'] : ['-version'], { timeoutMs: 5000 }); return true } catch { return false }
}
export async function exists(path: string): Promise<boolean> { try { await access(path); return true } catch { return false } }
const filterCache = new Map<string, Promise<{ drawtext: boolean; ass: boolean }>>()
export function textCapabilities(ffmpeg: string): Promise<{ drawtext: boolean; ass: boolean }> {
  let value = filterCache.get(ffmpeg)
  if (!value) { value = run(ffmpeg, ['-hide_banner', '-filters'], { timeoutMs: 10_000 }).then((text) => ({ drawtext: /\sdrawtext\s/.test(text), ass: /\sass\s/.test(text) })).catch(() => ({ drawtext: false, ass: false })); filterCache.set(ffmpeg, value) }
  return value
}
export function hash(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex') }
export async function fileHash(path: string): Promise<string> { return hash(await readFile(path)) }
export function safeError(error: unknown): string {
  return String(error instanceof Error ? error.message : error).replace(/https?:\/\/[^\s"']+/g, '[remote URL]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 1800)
}
export function dimensions(ratio: string): [number, number] { return ratio === '9:16' ? [360, 640] : ratio === '1:1' ? [480, 480] : [640, 360] }
export interface Probe { durationSec: number; width?: number; height?: number; hasVideo: boolean; hasAudio: boolean; format: string }
export async function probe(path: string, ffprobe = 'ffprobe', signal?: AbortSignal): Promise<Probe> {
  const data = JSON.parse(await run(ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path], { signal, timeoutMs: 30_000 }))
  const streams = data.streams ?? []
  const video = streams.find((s: any) => s.codec_type === 'video')
  return { durationSec: Number(data.format?.duration ?? video?.duration ?? 0) || 0, width: video?.width, height: video?.height, hasVideo: Boolean(video), hasAudio: streams.some((s: any) => s.codec_type === 'audio'), format: String(data.format?.format_name ?? '') }
}
export async function validateMedia(path: string, kind: MediaKind, ffprobe = 'ffprobe', signal?: AbortSignal): Promise<Probe> {
  const p = await probe(path, ffprobe, signal)
  if (kind === 'audio' ? !p.hasAudio || p.durationSec <= 0 : !p.hasVideo || !p.width || !p.height) throw new Error(`Invalid ${kind} media`)
  if (kind === 'video' && p.durationSec <= 0) throw new Error('Video has no usable duration')
  if (kind === 'image' && !/(image|png|jpeg|webp|gif|bmp|tiff|avif)/i.test(p.format)) throw new Error('Expected a still image, received a video container')
  return p
}
export function mediaFormat(kind: MediaKind, p: Probe): { extension: string; mimeType: string } {
  if (kind === 'image') {
    if (/jpeg/.test(p.format)) return { extension: 'jpg', mimeType: 'image/jpeg' }
    if (/webp/.test(p.format)) return { extension: 'webp', mimeType: 'image/webp' }
    if (/png/.test(p.format)) return { extension: 'png', mimeType: 'image/png' }
    throw new Error('Supported still-image formats are PNG, JPEG and WebP')
  }
  if (kind === 'video') return /webm|matroska/.test(p.format) ? { extension: 'mkv', mimeType: 'video/x-matroska' } : /mp4|mov/.test(p.format) ? { extension: 'mp4', mimeType: 'video/mp4' } : (() => { throw new Error('Supported video containers are MP4/MOV and WebM/Matroska') })()
  if (/mp3/.test(p.format)) return { extension: 'mp3', mimeType: 'audio/mpeg' }
  if (/wav/.test(p.format)) return { extension: 'wav', mimeType: 'audio/wav' }
  if (/mp4|mov/.test(p.format)) return { extension: 'm4a', mimeType: 'audio/mp4' }
  if (/aiff/.test(p.format)) return { extension: 'aiff', mimeType: 'audio/aiff' }
  throw new Error('Supported audio containers are WAV, MP3, M4A and AIFF')
}
export async function speak(text: string, directory: string, ffmpeg: string, signal?: AbortSignal): Promise<string> {
  if (!(await available('say'))) throw new Error('Local preview narration requires macOS say; select an audio take or configure TTS instead')
  const source = `${directory}/speech.txt`, aiff = `${directory}/speech.aiff`, wav = `${directory}/speech.wav`
  await writeFile(source, text, 'utf8')
  await run('say', ['-f', source, '-o', aiff], { signal, timeoutMs: 120_000 })
  await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', aiff, '-ar', '48000', '-ac', '2', wav], { signal })
  return wav
}
