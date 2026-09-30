import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import { mkdir, open, readFile, readdir, rename, rmdir, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { Chapter, ChapterDraft, ContinuityFact, SessionBinding, SourceRevision, WorkState, WorkSummary } from './types.js'
import { bindingSchema, canonEntrySchema, chapterDraftSchema, factSchema, idSchema, mediaKindSchema, shotSchema, workStateSchema } from './schema.js'
import { shotFingerprint, validateChapter } from './validate.js'

export class DomainError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) { super(message); this.name = 'DomainError' }
}
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const uuid = (prefix: string) => `${prefix}_${randomUUID()}`
const at = () => new Date().toISOString()
const nonblank = z.string().refine(value => value.trim().length > 0, 'Must not be blank')
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input)
  if (!result.success) throw new DomainError('invalid_input', result.error.issues.map(item => `${item.path.join('.')}: ${item.message}`).join('; '))
  return result.data
}
function sourceOf(text: string): SourceRevision {
  parse(nonblank, text)
  const hash = sha(text)
  return { id: `source_${hash.slice(0, 24)}`, text, hash, at: at(), paragraphs: text.split(/\r?\n[\t ]*\r?\n/).map(value => value.trim()).filter(Boolean).map((value, index) => ({ id: `p_${hash.slice(0, 16)}_${index + 1}`, text: value })) }
}
function assertIntegrity(work: WorkState): void {
  for (const [name, rows] of Object.entries({ chapters: work.chapters, canon: work.canon, facts: work.facts, assets: work.assets, jobs: work.jobs, takes: work.takes, renders: work.renders, decisions: work.decisions, events: work.events })) {
    const ids = new Set<string>()
    for (const row of rows) { if (ids.has(row.id)) throw new Error(`Duplicate ${name} ID ${row.id}`); ids.add(row.id) }
  }
  const orders = new Set<number>()
  for (const chapter of work.chapters) {
    if (orders.has(chapter.order)) throw new Error(`Duplicate chapter order ${chapter.order}`)
    orders.add(chapter.order)
    if (!chapter.sources.some(source => source.id === chapter.sourceRevisionId)) throw new Error(`Missing current source for ${chapter.id}`)
    const ids = new Set<string>()
    for (const source of chapter.sources) {
      if (ids.has(source.id)) throw new Error(`Duplicate source revision ${source.id}`)
      ids.add(source.id)
      if (source.hash !== sha(source.text)) throw new Error(`Source integrity check failed: ${source.id}`)
      const paragraphs = new Set<string>()
      for (const paragraph of source.paragraphs) {
        if (paragraphs.has(paragraph.id)) throw new Error(`Duplicate paragraph ${paragraph.id}`)
        paragraphs.add(paragraph.id)
        if (!source.text.includes(paragraph.text)) throw new Error(`Paragraph ${paragraph.id} is not present in its source`)
      }
    }
    if (chapter.draft?.sourceRevisionId && !chapter.sources.some(source => source.id === chapter.draft?.sourceRevisionId)) throw new Error(`Missing draft source for ${chapter.id}`)
    if (chapter.approvedRevision !== undefined && chapter.approvedRevision !== chapter.revision) throw new Error(`Invalid approval revision for ${chapter.id}`)
  }
}

export class WorkStore {
  readonly root: string
  readonly cwd: string
  constructor(cwd: string) {
    this.cwd = realpathSync(resolve(cwd))
    this.root = join(this.cwd, '.dsh-video-studio')
    this.safe(this.root)
  }

  /** Reject traversal and symlinks, including a symlink replacing the data root. */
  private safe(path: string): string {
    const target = resolve(path)
    if (target !== this.root && !target.startsWith(this.root + sep)) throw new DomainError('unsafe_path', 'Path is outside this studio workspace')
    const parts = relative(this.cwd, target).split(sep)
    let cursor = this.cwd
    for (const part of parts) {
      cursor = join(cursor, part)
      try { if (lstatSync(cursor).isSymbolicLink()) throw new DomainError('unsafe_path', `Symlink paths are not allowed in studio storage: ${cursor}`) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    return target
  }

  filePath(workId: string, relativePath: string): string {
    parse(idSchema, workId)
    if (typeof relativePath !== 'string' || isAbsolute(relativePath) || relativePath.includes('\0')) throw new DomainError('unsafe_path', 'Expected a relative path inside the work directory')
    const base = join(this.root, 'works', workId)
    const target = resolve(base, relativePath)
    if (target !== base && !target.startsWith(base + sep)) throw new DomainError('unsafe_path', 'Path escapes the work directory')
    return this.safe(target)
  }

  private async atomic(path: string, data: unknown): Promise<void> {
    this.safe(path)
    await mkdir(dirname(path), { recursive: true })
    this.safe(path)
    const temporary = `${path}.${randomUUID()}.tmp`
    let handle
    try {
      handle = await open(temporary, 'wx', 0o600)
      await handle.writeFile(JSON.stringify(data, null, 2) + '\n', 'utf8')
      await handle.sync()
      await handle.close(); handle = undefined
      this.safe(path)
      await rename(temporary, path)
      const directory = await open(dirname(path), 'r')
      try { await directory.sync() } finally { await directory.close() }
    } finally {
      if (handle) await handle.close().catch(() => {})
      await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error })
    }
  }

  private async locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    parse(idSchema, key)
    const parent = this.safe(join(this.root, 'locks'))
    await mkdir(parent, { recursive: true })
    const lock = this.safe(join(parent, `${key}.lock`))
    const token = randomUUID()
    const deadline = Date.now() + 5000
    while (true) {
      try { this.safe(lock); await mkdir(lock); break }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (Date.now() >= deadline) throw new DomainError('work_locked', 'The work is locked by another writer. A crashed writer may require explicit lock recovery; no lock was deleted.', 409)
        await new Promise(done => setTimeout(done, 25))
      }
    }
    const owner = join(lock, 'owner.json')
    try {
      await this.atomic(owner, { token, pid: process.pid, createdAt: at() })
      return await fn()
    } finally {
      // Only release the lock created by this invocation; never remove a stale lock.
      try {
        const recorded = JSON.parse(await readFile(this.safe(owner), 'utf8')) as { token?: string }
        if (recorded.token === token) { await unlink(owner); await rmdir(lock) }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        // If writing the owner failed, leave the directory for explicit diagnosis.
      }
    }
  }

  async list(): Promise<WorkSummary[]> {
    const parent = this.safe(join(this.root, 'works'))
    let rows
    try { rows = await readdir(parent, { withFileTypes: true }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    const works: WorkSummary[] = []
    for (const row of rows) {
      if (!row.isDirectory() && !row.isSymbolicLink()) continue
      const work = await this.get(row.name)
      works.push({ id: work.id, title: work.title, revision: work.revision, chapterCount: work.chapters.length, updatedAt: work.updatedAt })
    }
    return works.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
  }

  async create(input: { title: string; style?: string; aspectRatio?: string }): Promise<WorkState> {
    const data = parse(z.object({ title: nonblank, style: z.string().optional(), aspectRatio: z.enum(['16:9', '9:16', '1:1']).optional() }).strict(), input)
    const now = at()
    const work: WorkState = { schemaVersion: 1, id: uuid('work'), title: data.title.trim(), revision: 0, style: data.style ?? '', aspectRatio: data.aspectRatio ?? '16:9', createdAt: now, updatedAt: now, chapters: [], canon: [], canonHistory: [], facts: [], assets: [], jobs: [], takes: [], renders: [], decisions: [], events: [] }
    await this.locked(work.id, async () => { await this.atomic(this.filePath(work.id, 'state.json'), work) })
    return structuredClone(work)
  }

  async get(workId: string): Promise<WorkState> {
    const path = this.filePath(workId, 'state.json')
    let contents: string
    try { contents = await readFile(path, 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new DomainError('work_not_found', `Work not found: ${workId}`, 404); throw error }
    try {
      const work = workStateSchema.parse(JSON.parse(contents)) as WorkState
      if (work.id !== workId) throw new Error('Stored work ID does not match its directory')
      assertIntegrity(work)
      return work
    } catch (error) { throw new DomainError('invalid_state', `Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}. The original file has been preserved.`, 500) }
  }

  async mutate(workId: string, expectedRevision: number | undefined, fn: (state: WorkState) => void | Promise<void>): Promise<WorkState> {
    parse(idSchema, workId)
    if (expectedRevision !== undefined) parse(z.number().int().nonnegative(), expectedRevision)
    return this.locked(workId, async () => {
      const previous = await this.get(workId)
      if (expectedRevision !== undefined && previous.revision !== expectedRevision) throw new DomainError('revision_conflict', `Work revision conflict: expected ${expectedRevision}, current ${previous.revision}`, 409)
      const next = structuredClone(previous)
      await fn(next)
      if (next.id !== previous.id || next.schemaVersion !== previous.schemaVersion || next.createdAt !== previous.createdAt) throw new DomainError('immutable_identity', 'Work identity, schema version and creation time cannot be changed')
      next.revision = previous.revision + 1
      next.updatedAt = at()
      const checked = parse(workStateSchema, next) as WorkState
      try { assertIntegrity(checked) } catch (error) { throw new DomainError('invalid_state', error instanceof Error ? error.message : String(error)) }
      const history = this.filePath(workId, `history/${String(previous.revision).padStart(10, '0')}.json`)
      await mkdir(dirname(history), { recursive: true })
      let snapshot
      try {
        snapshot = await open(history, 'wx', 0o600)
        await snapshot.writeFile(JSON.stringify(previous, null, 2) + '\n', 'utf8')
        await snapshot.sync()
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        // An earlier interrupted commit can leave this exact immutable snapshot.
        const existing = JSON.parse(await readFile(history, 'utf8'))
        if (JSON.stringify(existing) !== JSON.stringify(previous)) throw new DomainError('history_conflict', `History revision ${previous.revision} differs from current state; refusing overwrite`, 500)
      } finally { await snapshot?.close() }
      await this.atomic(this.filePath(workId, 'state.json'), checked)
      return structuredClone(checked)
    })
  }

  async bind(sessionId: string, workId: string, chapterId?: string): Promise<SessionBinding> {
    parse(nonblank, sessionId)
    const work = await this.get(workId)
    if (chapterId && !work.chapters.some(chapter => chapter.id === chapterId)) throw new DomainError('chapter_not_found', `Chapter not found: ${chapterId}`, 404)
    const binding: SessionBinding = { sessionId, workId, ...(chapterId ? { chapterId } : {}), updatedAt: at() }
    await this.atomic(this.safe(join(this.root, 'bindings', `${sha(sessionId)}.json`)), binding)
    return binding
  }

  async binding(sessionId: string): Promise<SessionBinding | undefined> {
    parse(nonblank, sessionId)
    const path = this.safe(join(this.root, 'bindings', `${sha(sessionId)}.json`))
    let raw
    try { raw = await readFile(path, 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
    try {
      const binding = bindingSchema.parse(JSON.parse(raw))
      if (binding.sessionId !== sessionId) throw new Error('Session identity mismatch')
      return binding
    } catch (error) { throw new DomainError('invalid_binding', `Cannot read session binding: ${error instanceof Error ? error.message : String(error)}`, 500) }
  }

  async command(workId: string, expectedRevision: number, action: string, payload: unknown, sessionId?: string): Promise<WorkState> {
    if (expectedRevision === undefined) throw new DomainError('revision_required', 'expectedRevision is required for creative commands')
    parse(z.number().int().nonnegative(), expectedRevision)
    if (sessionId !== undefined) parse(nonblank, sessionId)
    return this.mutate(workId, expectedRevision, work => {
      const before = structuredClone(work)
      const touch = (chapter: Chapter) => { chapter.revision += 1; chapter.updatedAt = at(); delete chapter.approvedRevision }
      const findChapter = (id: string) => { const chapter = work.chapters.find(item => item.id === id); if (!chapter) throw new DomainError('chapter_not_found', `Chapter not found: ${id}`, 404); return chapter }
      let chapterId: string | undefined
      switch (action) {
        case 'chapter.add': {
          const data = parse(z.object({ title: nonblank, text: nonblank, order: z.number().int().nonnegative().optional() }).strict(), payload)
          const source = sourceOf(data.text)
          const duplicate = work.chapters.find(chapter => chapter.sources.some(item => item.hash === source.hash))
          if (duplicate) { chapterId = duplicate.id; break }
          const order = data.order ?? Math.max(0, ...work.chapters.map(chapter => chapter.order)) + 1
          if (work.chapters.some(chapter => chapter.order === order)) throw new DomainError('chapter_order_conflict', `Chapter order ${order} is already in use`, 409)
          const now = at(); chapterId = uuid('chapter')
          work.chapters.push({ id: chapterId, title: data.title.trim(), order, revision: 0, sourceRevisionId: source.id, sources: [source], selections: {}, createdAt: now, updatedAt: now })
          work.chapters.sort((a, b) => a.order - b.order)
          break
        }
        case 'chapter.source': {
          const data = parse(z.object({ chapterId: idSchema, text: nonblank }).strict(), payload)
          const chapter = findChapter(data.chapterId); chapterId = chapter.id
          const source = sourceOf(data.text)
          if (chapter.sourceRevisionId === source.id) break
          if (!chapter.sources.some(item => item.hash === source.hash)) chapter.sources.push(source)
          chapter.sourceRevisionId = source.id
          // Keep original evidence, but it cannot remain an authoritative fact after its source changes.
          for (const fact of work.facts) if (fact.sourceChapterId === chapter.id && fact.sourceRevisionId !== source.id) {
            fact.confirmed = false
            fact.needsReview = true
            fact.reviewReason = 'The cited chapter source was revised; review this fact against the current text.'
          }
          touch(chapter)
          break
        }
        case 'draft.save': {
          const data = parse(z.object({ chapterId: idSchema, draft: chapterDraftSchema }).strict(), payload)
          const chapter = findChapter(data.chapterId); chapterId = chapter.id
          const draft: ChapterDraft = { ...data.draft, sourceRevisionId: data.draft.sourceRevisionId ?? chapter.sourceRevisionId }
          if (!chapter.sources.some(source => source.id === draft.sourceRevisionId)) throw new DomainError('source_not_found', 'Draft source revision does not exist')
          chapter.draft = draft; touch(chapter)
          break
        }
        case 'shot.update': {
          const data = parse(z.object({ chapterId: idSchema, shotId: idSchema, patch: shotSchema.omit({ id: true }).partial() }).strict(), payload)
          const chapter = findChapter(data.chapterId); chapterId = chapter.id
          const shot = chapter.draft?.shots.find(item => item.id === data.shotId)
          if (!shot) throw new DomainError('shot_not_found', `Shot not found: ${data.shotId}`, 404)
          Object.assign(shot, data.patch); touch(chapter)
          break
        }
        case 'canon.save': {
          const data = parse(z.object({ entry: canonEntrySchema.omit({ id: true, revision: true }).extend({ id: idSchema.optional() }) }).strict(), payload)
          const id = data.entry.id ?? uuid('canon')
          const previous = work.canon.find(entry => entry.id === id)
          if (data.entry.assetId && !work.assets.some(asset => asset.id === data.entry.assetId)) throw new DomainError('asset_not_found', `Asset not found: ${data.entry.assetId}`, 404)
          const next = { ...data.entry, id, revision: previous ? previous.revision + 1 : 0 }
          if (previous) { (work.canonHistory ??= []).push(structuredClone(previous)); work.canon[work.canon.indexOf(previous)] = next }
          else work.canon.push(next)
          break
        }
        case 'fact.save': {
          const data = parse(z.object({ fact: factSchema.omit({ id: true }).extend({ id: idSchema.optional() }) }).strict(), payload)
          const fact: ContinuityFact = { ...data.fact, id: data.fact.id ?? uuid('fact') }
          if (!work.canon.some(entry => entry.id === fact.subjectId)) throw new DomainError('subject_not_found', `Continuity subject not found: ${fact.subjectId}`)
          if (fact.origin === 'inference' && fact.confirmed) throw new DomainError('unconfirmed_inference', 'An inference cannot be confirmed without a source or user decision; record that origin instead')
          if (fact.sourceChapterId) {
            const chapter = findChapter(fact.sourceChapterId)
            fact.sourceRevisionId ??= chapter.sourceRevisionId
            const source = chapter.sources.find(item => item.id === fact.sourceRevisionId)
            if (!source) throw new DomainError('source_not_found', 'Fact source revision does not exist')
            if (fact.sourceParagraphIds.some(id => !source.paragraphs.some(paragraph => paragraph.id === id))) throw new DomainError('invalid_source_reference', 'Fact references a paragraph outside its source revision')
            if (fact.sourceRevisionId !== chapter.sourceRevisionId) {
              fact.confirmed = false
              fact.needsReview = true
              fact.reviewReason = 'The cited chapter source was revised; review this fact against the current text.'
            } else if (fact.confirmed) {
              delete fact.needsReview
              delete fact.reviewReason
            }
          } else if (fact.sourceParagraphIds.length || fact.sourceRevisionId) throw new DomainError('source_required', 'Source paragraph references require sourceChapterId')
          const index = work.facts.findIndex(item => item.id === fact.id)
          if (index < 0) work.facts.push(fact); else work.facts[index] = fact
          break
        }
        case 'chapter.approve':
        case 'chapter.revoke':
        case 'note.add': {
          const data = action === 'note.add'
            ? parse(z.object({ chapterId: idSchema, text: nonblank }).strict(), payload)
            : parse(z.object({ chapterId: idSchema, note: z.string().optional() }).strict(), payload)
          const chapter = findChapter(data.chapterId); chapterId = chapter.id
          if (action === 'chapter.approve') {
            const report = validateChapter(work, chapter)
            if (!report.valid) throw new DomainError('chapter_invalid', report.issues.filter(item => item.level === 'error').map(item => `${item.path}: ${item.message}`).join('; '))
            chapter.approvedRevision = chapter.revision
          } else if (action === 'chapter.revoke') delete chapter.approvedRevision
          const kind = action === 'chapter.approve' ? 'approve' : action === 'chapter.revoke' ? 'revoke' : 'note'
          work.decisions.push({ id: uuid('decision'), chapterId: chapter.id, revision: chapter.revision, kind, text: 'text' in data ? data.text : data.note ?? '', at: at(), ...(sessionId ? { sessionId } : {}) })
          chapter.updatedAt = at()
          break
        }
        case 'take.select': {
          const data = parse(z.object({ chapterId: idSchema, shotId: idSchema, kind: mediaKindSchema, takeId: idSchema }).strict(), payload)
          const chapter = findChapter(data.chapterId); chapterId = chapter.id
          const shot = chapter.draft?.shots.find(item => item.id === data.shotId)
          const take = work.takes.find(item => item.id === data.takeId)
          if (!shot || !take || take.chapterId !== chapter.id || take.shotId !== shot.id || take.kind !== data.kind || !work.assets.some(asset => asset.id === take.assetId)) throw new DomainError('invalid_take', 'Take does not match this chapter, shot and media kind, or its asset is missing')
          if (take.fingerprint !== shotFingerprint(work, chapter, shot, data.kind)) throw new DomainError('stale_take', 'This candidate was created from older inputs; revise or explicitly produce a matching candidate before adopting it', 409)
          ;(chapter.selections[shot.id] ??= {})[data.kind] = take.id
          chapter.updatedAt = at()
          break
        }
        default: throw new DomainError('unknown_action', `Unknown creative command: ${action}`)
      }
      // Identity changes revoke only chapters whose currently visible inputs changed.
      if (action === 'canon.save') for (const chapter of work.chapters) {
        const previous = before.chapters.find(item => item.id === chapter.id)
        if (previous && chapter.draft?.shots.some(shot => (['image', 'video', 'audio'] as const).some(kind => shotFingerprint(work, chapter, shot, kind) !== shotFingerprint(before, previous, shot, kind)))) touch(chapter)
      }
      work.events.push({ id: uuid('event'), at: at(), type: action, message: action, ...(chapterId ? { chapterId } : {}) })
    })
  }
}
