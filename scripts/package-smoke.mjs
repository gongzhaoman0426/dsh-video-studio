#!/usr/bin/env node
/** Verify source installs and packed artifacts without touching DSH profiles or calling providers. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await mkdtemp(join(tmpdir(), 'chapter-video-package-smoke-'))
const source = join(temporary, 'source')
const consumer = join(temporary, 'consumer')
const options = cwd => ({ cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })

try {
  await Promise.all([mkdir(source), mkdir(consumer)])
  const tracked = (await run('git', ['ls-files', '-z'], options(projectRoot))).stdout.split('\0').filter(Boolean)
  const sourceFiles = tracked.filter(path => !/^(?:lib|node_modules)(?:\/|$)/.test(path))
  for (const path of sourceFiles) {
    await mkdir(dirname(join(source, path)), { recursive: true })
    // Copy current working-tree contents, including pending package/build fixes.
    await copyFile(join(projectRoot, path), join(source, path))
  }
  for (const path of ['lib', 'node_modules']) await assert.rejects(access(join(source, path)), { code: 'ENOENT' })
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
  assert.ok(manifest.scripts?.prepare, 'Git installs need a prepare lifecycle script')

  await run('npm', ['ci', '--no-audit', '--no-fund'], options(source))
  const entries = ['lib/index.js', 'lib/client.js']
  for (const path of entries) await access(join(source, path))
  const packed = JSON.parse((await run('npm', ['pack', '--json'], options(source))).stdout)
  assert.equal(packed.length, 1)
  const required = [...entries, 'cordis.patch.yml',
    'skills/chapter-video-authoring/SKILL.md', 'skills/chapter-video-production/SKILL.md']
  const packedPaths = new Set(packed[0].files.map(file => file.path))
  for (const path of required) assert.ok(packedPaths.has(path), `Packed artifact contains ${path}`)

  await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'chapter-video-package-consumer', private: true, type: 'module' }))
  await run('npm', ['install', join(source, packed[0].filename), '--ignore-scripts', '--no-audit', '--no-fund'], options(consumer))
  const installed = join(consumer, 'node_modules', manifest.name)
  for (const path of required) await access(join(installed, path))
  // A published tarball must import without build tools, source files, or lifecycle scripts.
  const verification = `
    import assert from 'node:assert/strict';
    import { readFile } from 'node:fs/promises';
    import { runInNewContext } from 'node:vm';
    const plugin = await import(${JSON.stringify(manifest.name)});
    assert.equal(plugin.name, ${JSON.stringify(manifest.name)});
    assert.equal(typeof plugin.apply, 'function');
    assert.equal(typeof plugin.Config, 'function');
    const registrations = [];
    runInNewContext(await readFile(new URL(import.meta.resolve(${JSON.stringify(`${manifest.name}/client`)})), 'utf8'), {
      window: { __ModuleLoader__: { load: entry => registrations.push(entry) } },
    });
    assert.equal(registrations.length, 1);
    assert.equal(registrations[0].id, ${JSON.stringify(manifest.name)});
    assert.equal(typeof registrations[0].factory, 'function');
  `
  await run(process.execPath, ['--input-type=module', '--eval', verification], options(consumer))
  console.log(JSON.stringify({ ok: true, sourceFiles: sourceFiles.length, preparedEntries: entries.length,
    packedFiles: packedPaths.size, requiredArtifacts: required.length, consumerLifecycleScripts: false,
    hostImport: true, clientRegistration: true, providerCalls: 0 }, null, 2))
} finally {
  await rm(temporary, { recursive: true, force: true })
}
