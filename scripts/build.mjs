import { build } from 'esbuild'
import { mkdir, rm } from 'node:fs/promises'

await mkdir('lib', { recursive: true })
// Settings uses inline styles; no sidecar stylesheet or standalone web application.
for (const file of ['lib/client.css', 'lib/client.css.map']) await rm(file, { force: true })
await build({ entryPoints: ['src/index.ts'], outfile: 'lib/index.js', bundle: true, platform: 'node', format: 'esm', target: 'node22', external: ['yaml', '@deepseek-ai/schemastery'], loader: { '.md': 'text' }, sourcemap: true })
await build({
  entryPoints: ['src/client/index.ts'], outfile: 'lib/client.js', bundle: true,
  platform: 'browser', format: 'cjs', target: 'es2022', jsx: 'automatic', sourcemap: true,
  external: ['react', 'react/jsx-runtime'],
  banner: { js: 'window.__ModuleLoader__.load({ id: "dsh-chapter-video-studio", factory: (require) => { var module = { exports: {} }; var exports = module.exports;' },
  footer: { js: 'return module.exports; } });' },
})
console.error('Built DSH Skills, Tools and native settings panel.')
