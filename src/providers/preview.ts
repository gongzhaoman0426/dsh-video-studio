import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { dimensions, exists, run, speak, textCapabilities } from '../media/process.ts'
import { writePreviewCard } from '../media/card.ts'
import type { MediaProvider } from './types.ts'

function escapedPath(path: string): string { return path.replaceAll('\\', '/').replaceAll(':', '\\:').replaceAll("'", "'\\''") }
export function createPreviewProvider(ffmpeg = 'ffmpeg'): MediaProvider {
  return {
    id: 'local-preview', configId: 'local-preview-v1', label: '本地分镜预演（非 AI 生成）', mode: 'preview', configured: true,
    kinds: ['image', 'video', 'audio'], models: { image: 'storyboard-card', video: 'storyboard-card', audio: 'macos-say-preview' },
    validate(request) {
      if (request.kind === 'audio' && !request.text?.trim()) throw new Error('This shot has no narration to preview')
      if (!Number.isFinite(request.durationSec) || request.durationSec < 0.25 || request.durationSec > 120) throw new Error('Preview shot duration must be between 0.25 and 120 seconds')
    },
    async submit(request) {
      await mkdir(request.outputDirectory, { recursive: true })
      if (request.kind === 'audio') return { artifact: { path: await speak(request.text!, request.outputDirectory, ffmpeg, request.signal), mimeType: 'audio/wav' } }
      const [width, height] = dimensions(request.aspectRatio)
      const textPath = `${request.outputDirectory}/card.txt`
      const text = request.prompt.replace(/\r/g, '').slice(0, 250).match(/.{1,24}/gu)?.slice(0, 6).join('\n') ?? ''
      await writeFile(textPath, text, 'utf8')
      const fonts = ['/System/Library/Fonts/PingFang.ttc', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf']
      let font = ''; for (const candidate of fonts) if (await exists(candidate)) { font = `fontfile='${escapedPath(candidate)}':`; break }
      const filter = `drawbox=x=24:y=24:w=iw-48:h=ih-48:color=0x536884:t=1,drawtext=${font}text='PREVIEW / NOT AI-GENERATED':fontcolor=0xf7bd65:fontsize=15:x=38:y=40,drawtext=${font}textfile='${escapedPath(textPath)}':expansion=none:fontcolor=white:fontsize=20:x=38:y=100:line_spacing=10`
      const path = `${request.outputDirectory}/preview.${request.kind === 'image' ? 'png' : 'mp4'}`
      const args = ['-hide_banner', '-loglevel', 'error', '-y']
      if ((await textCapabilities(ffmpeg)).drawtext) args.push('-f', 'lavfi', '-i', `color=c=0x172335:s=${width}x${height}:r=24`, '-vf', filter)
      else { const card = `${request.outputDirectory}/card.ppm`; await writePreviewCard(card, width, height, request.durationSec); args.push('-loop', '1', '-framerate', '24', '-i', card) }
      if (request.kind === 'image') args.push('-frames:v', '1', '-update', '1', path)
      else args.push('-t', String(request.durationSec), '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path)
      await run(ffmpeg, args, { signal: request.signal })
      return { artifact: { path, mimeType: request.kind === 'image' ? 'image/png' : 'video/mp4' } }
    },
  }
}
