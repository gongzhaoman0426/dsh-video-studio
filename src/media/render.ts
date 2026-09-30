import { mkdir, writeFile } from 'node:fs/promises'
import type { Asset, Chapter, WorkState } from '../domain/types.ts'
import type { WorkStore } from '../domain/store.ts'
import { shotFingerprint } from '../domain/validate.ts'
import { dimensions, fileHash, probe, run, speak, textCapabilities } from './process.ts'
import { bitmapLabelFilter } from './card.ts'

export interface RenderClip {
  shotId: string; title: string; source: string; sourceKind: 'image' | 'video';
  sourceAssetId: string; sourceHash: string; audio?: string; audioHash?: string;
  durationSec: number; text: string; localPreviewVoice: boolean; mode: 'preview' | 'production';
}
export interface RenderPlan {
  version: 1; chapterId: string; chapterRevision: number; aspectRatio: string;
  subtitles: boolean; voice: boolean; clips: RenderClip[]; sourceAudio: 'muted';
  note: string; mode: 'preview' | 'production';
}
function selected(work: WorkState, chapter: Chapter, shotId: string, kind: 'image' | 'video' | 'audio'): { asset: Asset; mode: 'preview' | 'production' } | undefined {
  const id = chapter.selections[shotId]?.[kind]
  if (!id) return undefined
  const take = work.takes.find((item) => item.id === id)
  const shot = chapter.draft?.shots.find((item) => item.id === shotId)
  if (!take || !shot || take.chapterId !== chapter.id || take.shotId !== shotId || take.kind !== kind) throw new Error(`Invalid selected ${kind} take for ${shotId}`)
  if (take.fingerprint !== shotFingerprint(work, chapter, shot, kind)) throw new Error(`Selected ${kind} for ${shotId} is stale. Review and select a current candidate before rendering.`)
  const asset = work.assets.find((item) => item.id === take.assetId)
  if (!asset) throw new Error(`Missing asset for ${shotId}`)
  return { asset, mode: take.mode }
}
export function buildRenderPlan(work: WorkState, chapter: Chapter, input: { voice?: boolean; subtitles?: boolean }): RenderPlan {
  if (!chapter.draft?.shots.length) throw new Error('Create a storyboard before rendering')
  const clips = chapter.draft.shots.map((shot): RenderClip => {
    const video = selected(work, chapter, shot.id, 'video')
    const image = !video ? selected(work, chapter, shot.id, 'image') : undefined
    const visual = video ?? image
    if (!visual) throw new Error(`Select a video or image candidate for ${shot.title || shot.id} first`)
    // voice controls only the optional local preview TTS fallback; selected audio is always used.
    const audio = selected(work, chapter, shot.id, 'audio')
    const scene = chapter.draft!.scenes.find((s) => s.id === shot.sceneId)
    const text = shot.narration || shot.beatIds.flatMap((id) => { const beat = scene?.beats.find((b) => b.id === id); return beat && beat.kind !== 'action' ? [beat.text] : [] }).join('\n')
    const localPreviewVoice = input.voice === true && !audio && Boolean(text.trim())
    return { shotId: shot.id, title: shot.title, source: visual.asset.path, sourceKind: video ? 'video' : 'image', sourceAssetId: visual.asset.id, sourceHash: visual.asset.hash, audio: audio?.asset.path, audioHash: audio?.asset.hash, durationSec: shot.durationSec, text, localPreviewVoice, mode: visual.mode === 'preview' || audio?.mode === 'preview' || localPreviewVoice ? 'preview' : 'production' }
  })
  return { version: 1, chapterId: chapter.id, chapterRevision: chapter.revision, aspectRatio: work.aspectRatio, subtitles: input.subtitles !== false, voice: input.voice === true, clips, sourceAudio: 'muted', note: 'Image candidates are rendered as labelled still-image pans, not generated motion. Original video audio is muted; selected narration audio is always used. The voice flag enables local say preview narration only where an audio take is missing.', mode: clips.some((clip) => clip.mode === 'preview') ? 'preview' : 'production' }
}
function srtTime(seconds: number): string {
  const ms = Math.round(seconds * 1000)
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`
}
function assTime(seconds: number): string { const cs = Math.round(seconds * 100); return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}` }
function assText(text: string): string { return text.replaceAll('\\', '＼').replaceAll('{', '｛').replaceAll('}', '｝').replace(/\r?\n/g, '\\N') }
function escapedFilterPath(path: string): string { return path.replaceAll('\\', '/').replaceAll(':', '\\:').replaceAll("'", "'\\''") }

export async function executeRender(store: WorkStore, workId: string, renderId: string, plan: RenderPlan, options: { ffmpeg: string; ffprobe: string; signal: AbortSignal }): Promise<{ videoPath: string; subtitlePath: string; timelinePath: string; durationSec: number }> {
  const relative = `media/renders/${renderId}`, directory = store.filePath(workId, relative)
  await mkdir(directory, { recursive: true })
  const [width, height] = dimensions(plan.aspectRatio)
  const textFilters = await textCapabilities(options.ffmpeg)
  const segments: string[] = [], subtitles: Array<{ text: string; start: number; end: number }> = [], timeline: unknown[] = []
  let cursor = 0
  for (let index = 0; index < plan.clips.length; index++) {
    const clip = plan.clips[index]!, clipDir = `${directory}/clip-${index}`
    await mkdir(clipDir, { recursive: true })
    const source = store.filePath(workId, clip.source)
    if (await fileHash(source) !== clip.sourceHash) throw new Error(`Source media changed for ${clip.shotId}; import a new asset version`)
    const sourceInfo = await probe(source, options.ffprobe, options.signal)
    if (!sourceInfo.hasVideo) throw new Error(`Visual source for ${clip.shotId} is not usable`)
    if (clip.sourceKind === 'video' && sourceInfo.durationSec + 0.08 < clip.durationSec) throw new Error(`Video ${clip.shotId} is ${sourceInfo.durationSec.toFixed(2)}s, shorter than ${clip.durationSec}s. Revise timing or generate a longer take.`)
    let audio = clip.audio ? store.filePath(workId, clip.audio) : undefined
    if (audio && await fileHash(audio) !== clip.audioHash) throw new Error(`Audio media changed for ${clip.shotId}; import a new asset version`)
    if (clip.localPreviewVoice) audio = await speak(clip.text, clipDir, options.ffmpeg, options.signal)
    const audioInfo = audio ? await probe(audio, options.ffprobe, options.signal) : undefined
    if (audioInfo && (!audioInfo.hasAudio || audioInfo.durationSec > clip.durationSec + 0.05)) throw new Error(`Narration for ${clip.shotId} lasts ${audioInfo.durationSec.toFixed(2)}s, exceeding the planned ${clip.durationSec}s. Revise timing or narration; audio was not truncated.`)
    const output = `${clipDir}/segment.mp4`
    const args = ['-hide_banner', '-loglevel', 'error', '-y']
    if (clip.sourceKind === 'image') args.push('-loop', '1')
    args.push('-i', source)
    if (audio) args.push('-i', audio)
    else args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000')
    let vf = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24`
    if (clip.sourceKind === 'image') vf += `,zoompan=z='min(zoom+0.0003,1.06)':d=1:s=${width}x${height}:fps=24,` + bitmapLabelFilter('STILL IMAGE', 12, 12)
    if (clip.mode === 'preview') vf += ',' + bitmapLabelFilter('PREVIEW', 12, height - 20)
    args.push('-map', '0:v:0', '-map', '1:a:0', '-vf', vf, '-af', 'apad', '-t', String(clip.durationSec), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', output)
    await run(options.ffmpeg, args, { signal: options.signal, timeoutMs: 180_000 })
    segments.push(`clip-${index}/segment.mp4`)
    if (plan.subtitles && clip.text.trim()) subtitles.push({ text: clip.text, start: cursor, end: cursor + (audioInfo?.durationSec || clip.durationSec) })
    timeline.push({ ...clip, startSec: cursor, effectiveDurationSec: clip.durationSec, audioDurationSec: audioInfo?.durationSec, transformation: clip.sourceKind === 'image' ? 'still-image-pan' : 'trim-normalize' })
    cursor += clip.durationSec
  }
  const concat = `${directory}/segments.txt`
  await writeFile(concat, segments.map((path) => `file '${path}'`).join('\n') + '\n')
  const srt = subtitles.map((item, index) => `${index + 1}\n${srtTime(item.start)} --> ${srtTime(item.end)}\n${item.text}\n`).join('\n')
  await writeFile(`${directory}/subtitles.srt`, srt)
  const ass = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,PingFang SC,22,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0,2,26,26,35,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n` + subtitles.map((item) => `Dialogue: 0,${assTime(item.start)},${assTime(item.end)},Default,,0,0,0,,${assText(item.text)}`).join('\n')
  await writeFile(`${directory}/subtitles.ass`, ass)
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '1', '-i', concat]
  if (subtitles.length && textFilters.ass) args.push('-vf', `ass='${escapedFilterPath(`${directory}/subtitles.ass`)}'`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p')
  else if (subtitles.length) args.push('-i', `${directory}/subtitles.srt`, '-map', '0:v:0', '-map', '0:a:0', '-map', '1:0', '-c:s', 'mov_text', '-c:v', 'copy')
  else args.push('-c:v', 'copy')
  args.push('-c:a', 'copy', '-movflags', '+faststart', `${directory}/chapter.mp4`)
  await run(options.ffmpeg, args, { signal: options.signal, timeoutMs: 300_000 })
  const finalInfo = await probe(`${directory}/chapter.mp4`, options.ffprobe, options.signal)
  if (!finalInfo.hasVideo || !finalInfo.hasAudio || Math.abs(finalInfo.durationSec - cursor) > 0.25) throw new Error('Rendered output failed track/duration validation')
  await writeFile(`${directory}/timeline.json`, JSON.stringify({ ...plan, clips: timeline, durationSec: finalInfo.durationSec, subtitleTiming: 'per-shot / measured narration when present', subtitleDelivery: !subtitles.length ? 'none' : textFilters.ass ? 'burned-in-and-srt' : 'mp4-text-track-and-srt' }, null, 2))
  return { videoPath: `${relative}/chapter.mp4`, subtitlePath: `${relative}/subtitles.srt`, timelinePath: `${relative}/timeline.json`, durationSec: finalInfo.durationSec }
}
