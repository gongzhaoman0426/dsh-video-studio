import { writeFile } from 'node:fs/promises'
// Small original bitmap alphabet for visible labels when FFmpeg has no font filters.
// Prompt text remains in the shot record and sidecar; this fallback is visibly a placeholder.
const glyphs: Record<string, string[]> = {
  A:['01110','10001','10001','11111','10001','10001','10001'], B:['11110','10001','10001','11110','10001','10001','11110'], C:['01111','10000','10000','10000','10000','10000','01111'], D:['11110','10001','10001','10001','10001','10001','11110'], E:['11111','10000','10000','11110','10000','10000','11111'], F:['11111','10000','10000','11110','10000','10000','10000'], G:['01111','10000','10000','10111','10001','10001','01111'], H:['10001','10001','10001','11111','10001','10001','10001'], I:['11111','00100','00100','00100','00100','00100','11111'], J:['00111','00010','00010','00010','10010','10010','01100'], K:['10001','10010','10100','11000','10100','10010','10001'], L:['10000','10000','10000','10000','10000','10000','11111'], M:['10001','11011','10101','10101','10001','10001','10001'], N:['10001','11001','10101','10011','10001','10001','10001'], O:['01110','10001','10001','10001','10001','10001','01110'], P:['11110','10001','10001','11110','10000','10000','10000'], Q:['01110','10001','10001','10001','10101','10010','01101'], R:['11110','10001','10001','11110','10100','10010','10001'], S:['01111','10000','10000','01110','00001','00001','11110'], T:['11111','00100','00100','00100','00100','00100','00100'], U:['10001','10001','10001','10001','10001','10001','01110'], V:['10001','10001','10001','10001','10001','01010','00100'], W:['10001','10001','10001','10101','10101','10101','01010'], X:['10001','10001','01010','00100','01010','10001','10001'], Y:['10001','10001','01010','00100','00100','00100','00100'], Z:['11111','00001','00010','00100','01000','10000','11111'],
  '0':['01110','10001','10011','10101','11001','10001','01110'], '1':['00100','01100','00100','00100','00100','00100','01110'], '2':['01110','10001','00001','00010','00100','01000','11111'], '3':['11110','00001','00001','01110','00001','00001','11110'], '4':['00010','00110','01010','10010','11111','00010','00010'], '5':['11111','10000','10000','11110','00001','00001','11110'], '6':['01110','10000','10000','11110','10001','10001','01110'], '7':['11111','00001','00010','00100','01000','01000','01000'], '8':['01110','10001','10001','01110','10001','10001','01110'], '9':['01110','10001','10001','01111','00001','00001','01110'], '.':['00000','00000','00000','00000','00000','00100','00100'], '-':['00000','00000','00000','11111','00000','00000','00000'], '/':['00001','00001','00010','00100','01000','10000','10000'],
}
function pixels(text: string, x: number, y: number, scale: number, draw: (x: number, y: number, w: number, h: number) => void): void {
  [...text.toUpperCase()].forEach((char, i) => (glyphs[char] ?? []).forEach((row, j) => [...row].forEach((on, k) => { if (on === '1') draw(x + i * 6 * scale + k * scale, y + j * scale, scale, scale) })))
}
export function bitmapLabelFilter(text: string, x: number, y: number, scale = 1): string {
  const rects: string[] = []
  pixels(text, x, y, scale, (left, top, w, h) => rects.push(`drawbox=x=${left}:y=${top}:w=${w}:h=${h}:color=0xf7bd65:t=fill`))
  return rects.join(',')
}
export async function writePreviewCard(path: string, width: number, height: number, duration: number): Promise<void> {
  const data = Buffer.alloc(width * height * 3)
  for (let i = 0; i < data.length; i += 3) { data[i] = 23; data[i + 1] = 35; data[i + 2] = 53 }
  const box = (x: number, y: number, w: number, h: number, color: number[]) => {
    for (let row = Math.max(0, y); row < Math.min(height, y + h); row++) for (let col = Math.max(0, x); col < Math.min(width, x + w); col++) { const offset = (row * width + col) * 3; data[offset] = color[0]!; data[offset + 1] = color[1]!; data[offset + 2] = color[2]! }
  }
  const amber = [247, 189, 101], white = [220, 229, 243], scale = width >= 480 ? 2 : 1
  pixels('STORYBOARD PREVIEW', 30, 38, scale, (x,y,w,h) => box(x,y,w,h,amber))
  pixels('NOT AI GENERATED', 30, 65, scale, (x,y,w,h) => box(x,y,w,h,amber))
  box(30, 110, width - 60, Math.max(80, height - 200), [39, 58, 79])
  box(50, 130, Math.floor(width * 0.22), Math.max(50, height - 240), [55, 79, 105])
  box(Math.floor(width * 0.52), 150, Math.floor(width * 0.25), Math.max(40, height - 260), [65, 90, 110])
  pixels(`DURATION ${duration} S`, 30, height - 62, scale, (x,y,w,h) => box(x,y,w,h,white))
  pixels('SHOT TEXT IN STUDIO', 30, height - 36, scale, (x,y,w,h) => box(x,y,w,h,white))
  await writeFile(path, Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), data]))
}
