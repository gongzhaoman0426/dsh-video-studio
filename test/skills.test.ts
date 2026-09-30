import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { parseBundledSkill } from '../src/host/skills.ts'

test('bundled skill directory, metadata and runtime registration agree; metadata is not instruction content', async () => {
  const root = new URL('../skills/', import.meta.url)
  const names = []
  for (const directory of await readdir(root, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue
    const raw = await readFile(new URL(`${directory.name}/SKILL.md`, root), 'utf8')
    const skill = parseBundledSkill(raw)
    assert.equal(skill.name, directory.name)
    assert.equal(skill.content.startsWith('---'), false)
    assert.ok(skill.description.length > 0)
    names.push(skill.name)
  }
  assert.deepEqual(names.sort(), ['chapter-video-authoring', 'chapter-video-production'])
})

test('invalid skill metadata cannot silently register an unnamed or empty skill', () => {
  assert.throws(() => parseBundledSkill('# Missing metadata'))
  assert.throws(() => parseBundledSkill('---\nname: Invalid_Name\ndescription: test\n---\nbody'))
  assert.throws(() => parseBundledSkill('---\nname: valid-name\ndescription: test\n---\n'))
})
