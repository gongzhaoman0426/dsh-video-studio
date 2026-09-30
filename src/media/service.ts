import { copyFile, mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve, relative, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { WorkStore } from '../domain/store.ts'
import type { Asset, Chapter, GenerationJob, MediaKind, Shot, WorkState } from '../domain/types.ts'
import { canonFor, shotFingerprint, validateChapter } from '../domain/validate.ts'
import { acquireJobLock, delay, TaskQueue } from '../jobs/queue.ts'
import { environmentProviders } from '../providers/official.ts'
import { createPreviewProvider } from '../providers/preview.ts'
import { ProviderError, type MediaArtifact, type MediaProvider, type MediaRequest } from '../providers/types.ts'
import { available, exists, fileHash, hash, mediaFormat, run, safeError, textCapabilities, validateMedia } from './process.ts'
import { buildRenderPlan, executeRender, type RenderPlan } from './render.ts'

export interface GenerateInput { chapterId: string; shotIds: string[]; kind: MediaKind; mode: 'preview' | 'production'; operationId: string; providerId?: string; model?: string }
export interface MediaServiceOptions { providers?: MediaProvider[] | (() => MediaProvider[]); ffmpegPath?: string; ffprobePath?: string; pollIntervalMs?: number; maxPolls?: number; concurrency?: number; maxDownloadBytes?: number }
const terminal = new Set(['succeeded', 'failed', 'cancelled'])
const now = () => new Date().toISOString()
function addEvent(work: WorkState, type: string, message: string, objectId?: string, chapterId?: string): void { work.events.push({ id: randomUUID(), at: now(), type, message, objectId, chapterId }) }
function chapterFor(work: WorkState, chapterId: string): Chapter { const chapter = work.chapters.find((item) => item.id === chapterId); if (!chapter) throw new Error('Chapter not found'); return chapter }
function approved(work: WorkState, chapter: Chapter): void {
  if (chapter.approvedRevision !== chapter.revision) throw new Error('Review and approve the current chapter revision before creating media tasks')
  const report = validateChapter(work, chapter)
  if (!report.valid) throw new Error(`Chapter validation failed: ${report.issues.filter((item) => item.level === 'error').map((item) => item.message).join('; ')}`)
}
function narration(chapter: Chapter, shot: Shot): string {
  return shot.narration || shot.beatIds.flatMap((id) => { const beat = chapter.draft?.scenes.find((scene) => scene.id === shot.sceneId)?.beats.find((item) => item.id === id); return beat && beat.kind !== 'action' ? [beat.text] : [] }).join('\n')
}
function references(work: WorkState, chapter: Chapter, shot: Shot, kind: MediaKind): Asset[] {
  if (kind === 'audio') return []
  if (kind === 'video') {
    const take = work.takes.find((item) => item.id === chapter.selections[shot.id]?.image)
    if (take) {
      if (take.fingerprint !== shotFingerprint(work, chapter, shot, 'image')) throw new Error('Selected first-frame image is stale; select a current image before video generation')
      const asset = work.assets.find((item) => item.id === take.assetId)
      if (!asset) throw new Error('Selected first-frame image asset is missing')
      return [asset]
    }
  }
  const scene = chapter.draft?.scenes.find((item) => item.id === shot.sceneId)
  const canon = canonFor(work, chapter.order).filter((entry) => shot.characterIds.includes(entry.id) || entry.id === scene?.location || entry.kind === 'style')
  return [...new Set([...shot.assetIds, ...canon.flatMap((entry) => entry.assetId ? [entry.assetId] : [])])].map((id) => {
    const asset = work.assets.find((item) => item.id === id)
    if (!asset || asset.kind !== 'image') throw new Error(`Reference ${id} must resolve to a stored image`)
    return asset
  })
}

export class MediaService {
  private readonly preview: MediaProvider
  private readonly queue: TaskQueue
  private readonly renderQueue: TaskQueue
  private readonly ffmpeg: string
  private readonly ffprobe: string
  private disposed = false
  private workerErrors: string[] = []
  constructor(private readonly store: WorkStore, private readonly options: MediaServiceOptions = {}) {
    this.ffmpeg = options.ffmpegPath ?? process.env.DSH_VIDEO_FFMPEG ?? 'ffmpeg'
    this.ffprobe = options.ffprobePath ?? process.env.DSH_VIDEO_FFPROBE ?? 'ffprobe'
    this.preview = createPreviewProvider(this.ffmpeg)
    // Check the initial configuration, while later operations read live DSH settings.
    void this.currentProviders
    this.queue = new TaskQueue(options.concurrency ?? 2, (error) => { this.workerErrors.push(safeError(error)); this.workerErrors = this.workerErrors.slice(-10) })
    this.renderQueue = new TaskQueue(1, (error) => { this.workerErrors.push(safeError(error)); this.workerErrors = this.workerErrors.slice(-10) })
  }
  private get currentProviders(): Map<string, MediaProvider> {
    const configured = typeof this.options.providers === 'function' ? this.options.providers() : this.options.providers ?? environmentProviders()
    const providers = [this.preview, ...configured]
    if (new Set(providers.map((item) => item.id)).size !== providers.length) throw new Error('Duplicate media provider ID')
    return new Map(providers.map((item) => [item.id, item]))
  }
  async diagnostics(): Promise<object> {
    const [ffmpeg, ffprobe, voice] = await Promise.all([available(this.ffmpeg), available(this.ffprobe), available('say')])
    return { ffmpeg, ffprobe, voice, textFilters: await textCapabilities(this.ffmpeg), providers: [...this.currentProviders.values()].map((p) => ({ id: p.id, label: p.label, kinds: p.kinds, mode: p.mode, configured: p.configured, models: p.models, configuredKinds: p.kinds.filter((kind) => p.configured && Boolean(p.models[kind]) && (p.id !== 'local-preview' || kind !== 'audio' || voice)), cancelSupported: Boolean(p.cancel) })), workerErrors: [...this.workerErrors], note: 'Local preview cards are not AI-generated. Without drawtext, labels use a built-in ASCII bitmap font and shot text stays in the studio. Without libass, captions are delivered as an MP4 text track and SRT rather than burned in. Diagnostics sends no provider requests.' }
  }
  private assertAlive(): void { if (this.disposed) throw new Error('Media service has been disposed') }
  private choose(input: GenerateInput): MediaProvider {
    const providers = this.currentProviders
    const provider = input.providerId ? providers.get(input.providerId) : [...providers.values()].find((p) => p.mode === input.mode && p.kinds.includes(input.kind) && p.configured)
    if (!provider || provider.mode !== input.mode || !provider.kinds.includes(input.kind) || !provider.configured || !provider.models[input.kind]) throw new Error(`No configured ${input.mode} provider/model for ${input.kind}; check the DSH plugin settings`)
    return provider
  }
  private request(workId: string, job: GenerationJob, signal: AbortSignal): MediaRequest {
    return { ...job.input, kind: job.kind, model: job.model, requestKey: job.requestKey, references: job.input.referencePaths.map((path) => ({ path: this.store.filePath(workId, path), mimeType: /\.jpe?g$/i.test(path) ? 'image/jpeg' : /\.webp$/i.test(path) ? 'image/webp' : 'image/png' })), outputDirectory: this.store.filePath(workId, `media/jobs/${job.id}`), signal }
  }
  async generate(workId: string, input: GenerateInput, expectedRevision: number): Promise<WorkState> {
    this.assertAlive()
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(input.operationId)) throw new Error('operationId must be a stable identifier of 1–128 characters')
    if (!input.shotIds.length || input.shotIds.length > 100 || new Set(input.shotIds).size !== input.shotIds.length) throw new Error('Provide 1–100 distinct shot IDs')
    if (!['image', 'video', 'audio'].includes(input.kind) || !['preview', 'production'].includes(input.mode)) throw new Error('Invalid media kind or mode')
    const existing = await this.store.get(workId)
    const duplicate = existing.jobs.filter((job) => job.operationId === input.operationId)
    if (duplicate.length) {
      if (duplicate.length !== input.shotIds.length || duplicate.some((job) => job.chapterId !== input.chapterId || !input.shotIds.includes(job.shotId) || job.kind !== input.kind || job.mode !== input.mode || (input.providerId && job.providerId !== input.providerId) || (input.model && job.model !== input.model))) throw new Error('operationId already belongs to a different request; use a new operationId for a new candidate')
      return existing
    }
    const provider = this.choose(input)
    const state = await this.store.mutate(workId, expectedRevision, async (work) => {
      if (work.jobs.some((job) => job.operationId === input.operationId)) throw new Error('Concurrent duplicate operation; read existing jobs before retrying')
      const chapter = chapterFor(work, input.chapterId); approved(work, chapter)
      for (const shotId of input.shotIds) {
        const shot = chapter.draft!.shots.find((item) => item.id === shotId)
        if (!shot) throw new Error(`Shot ${shotId} does not belong to this chapter`)
        const refs = references(work, chapter, shot, input.kind)
        for (const ref of refs) if (!(await exists(this.store.filePath(workId, ref.path)))) throw new Error(`Reference file missing: ${ref.name}`)
        const timestamp = now(), fingerprint = shotFingerprint(work, chapter, shot, input.kind)
        const job: GenerationJob = {
          id: randomUUID(), operationId: input.operationId, requestKey: hash(JSON.stringify([input.operationId, chapter.id, shot.id, input.kind, input.mode, provider.id, fingerprint])),
          chapterId: chapter.id, shotId, kind: input.kind, chapterRevision: chapter.revision, fingerprint, mode: input.mode,
          providerId: provider.id, providerConfigId: provider.configId, model: input.model ?? provider.models[input.kind], status: 'queued', stopRequested: false, attempt: 0,
          input: { prompt: [work.style, shot.prompt || shot.description, shot.camera].filter(Boolean).join('\n'), negative: shot.negative, text: narration(chapter, shot), durationSec: shot.durationSec, aspectRatio: work.aspectRatio, referencePaths: refs.map((asset) => asset.path) }, createdAt: timestamp, updatedAt: timestamp,
        }
        provider.validate(this.request(workId, job, new AbortController().signal))
        work.jobs.push(job)
      }
      addEvent(work, 'generation.queued', `${input.mode}: queued ${input.shotIds.length} ${input.kind} tasks`, undefined, input.chapterId)
    })
    for (const job of state.jobs.filter((item) => item.operationId === input.operationId)) this.schedule(workId, job.id)
    return state
  }
  private schedule(workId: string, jobId: string): void { this.queue.add(`${workId}:${jobId}`, (signal) => this.executeJob(workId, jobId, signal)) }
  private async job(workId: string, jobId: string): Promise<GenerationJob> { const job = (await this.store.get(workId)).jobs.find((item) => item.id === jobId); if (!job) throw new Error('Job not found'); return job }
  private async update(workId: string, jobId: string, patch: Partial<GenerationJob>): Promise<void> {
    await this.store.mutate(workId, undefined, (work) => { const job = work.jobs.find((item) => item.id === jobId); if (!job) throw new Error('Job not found'); Object.assign(job, patch, { updatedAt: now() }) })
  }
  private async saveArtifact(workId: string, jobId: string, artifact: MediaArtifact, signal: AbortSignal): Promise<string> {
    const raw = this.store.filePath(workId, `media/jobs/${jobId}/result.bin`), part = `${raw}.part`
    await mkdir(dirname(raw), { recursive: true })
    if (await exists(raw)) return raw
    if (artifact.url) {
      if (!/^https?:\/\//.test(artifact.url)) throw new Error('Provider result must be an HTTP(S) URL')
      await this.update(workId, jobId, { remoteResult: { url: artifact.url, mimeType: artifact.mimeType }, status: 'downloading' })
      const response = await fetch(artifact.url, { signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) })
      if (!response.ok || !response.body) throw new Error(`Result download failed: HTTP ${response.status}`)
      const limit = this.options.maxDownloadBytes ?? 256 * 1024 * 1024
      if (Number(response.headers.get('content-length')) > limit) throw new Error('Media result exceeds the download size limit')
      const output = await open(part, 'w', 0o600)
      let bytes = 0
      try {
        for await (const chunk of response.body as any as AsyncIterable<Uint8Array>) {
          bytes += chunk.length; if (bytes > limit) throw new Error('Media result exceeds the download size limit')
          await output.write(chunk)
        }
        await output.sync()
      } finally { await output.close() }
    } else if (artifact.bytes) {
      if (artifact.bytes.length > (this.options.maxDownloadBytes ?? 256 * 1024 * 1024)) throw new Error('Media result exceeds the size limit')
      await writeFile(part, artifact.bytes, { mode: 0o600 })
    } else if (artifact.path) {
      const directory = this.store.filePath(workId, `media/jobs/${jobId}`)
      const rel = relative(directory, resolve(artifact.path))
      if (rel.startsWith(`..${sep}`) || rel === '..' || resolve(directory, rel) !== resolve(artifact.path)) throw new Error('Local provider output escaped the job directory')
      this.store.filePath(workId, relative(this.store.filePath(workId, '.'), artifact.path))
      await copyFile(artifact.path, part)
    } else throw new Error('Provider returned no media artifact')
    await rename(part, raw)
    return raw
  }
  private async executeJob(workId: string, jobId: string, signal: AbortSignal): Promise<void> {
    const release = await acquireJobLock(this.store.filePath(workId, `media/jobs/${jobId}/worker.lock`))
    if (!release) return
    let submittedHere = false
    try {
      let job = await this.job(workId, jobId)
      if (terminal.has(job.status)) return
      // Keep this provider snapshot for the entire attempt, including polling and
      // cancellation. A settings edit must never switch an in-flight account.
      const provider = this.currentProviders.get(job.providerId)
      if (!provider || provider.configId !== job.providerConfigId) { await this.update(workId, jobId, { error: 'Original provider configuration is unavailable or changed; restore it before resuming. No task was resubmitted.' }); return }
      const request = this.request(workId, job, signal)
      const raw = this.store.filePath(workId, `media/jobs/${jobId}/result.bin`)
      let artifact: MediaArtifact | undefined = job.remoteResult
      if (job.stopRequested && !job.remoteId) {
        const unknown = ['submitting', 'unknown'].includes(job.status) && job.mode === 'production'
        await this.update(workId, jobId, { status: unknown ? 'unknown' : 'cancelled', ...(unknown ? { error: 'Cancellation was requested, but remote acceptance remains unknown. Verify the provider; no resubmission was made.' } : {}) }); return
      }
      if (job.status === 'queued' || (job.mode === 'preview' && ['submitting', 'unknown'].includes(job.status) && !(await exists(raw)))) {
        provider.validate(request)
        // The final approval/fingerprint check and queued -> submitting transition share the work lock.
        await this.store.mutate(workId, undefined, async (work) => {
          const current = work.jobs.find((item) => item.id === jobId)!, chapter = chapterFor(work, current.chapterId)
          const shot = chapter.draft?.shots.find((item) => item.id === current.shotId)
          if (current.stopRequested) { current.status = 'cancelled'; return }
          approved(work, chapter)
          if (!shot || chapter.revision !== current.chapterRevision || shotFingerprint(work, chapter, shot, current.kind) !== current.fingerprint) throw new Error('Approval or shot inputs changed while queued; no provider request was sent')
          for (const path of current.input.referencePaths) {
            const asset = work.assets.find((item) => item.path === path)
            if (!asset || await fileHash(this.store.filePath(workId, path)) !== asset.hash) throw new Error('A reference file changed after approval; import a new immutable asset version before submitting')
          }
          current.status = 'submitting'; current.attempt++; current.updatedAt = now(); delete current.error
        })
        job = await this.job(workId, jobId)
        if (job.status === 'cancelled' || job.stopRequested) { if (job.status !== 'cancelled') await this.update(workId, jobId, { status: 'cancelled' }); return }
        submittedHere = true
        const result = await provider.submit(request)
        if (result.remoteId) { await this.update(workId, jobId, { remoteId: result.remoteId, status: 'submitted', remoteStatus: 'submitted' }); job = await this.job(workId, jobId) }
        else { artifact = result.artifact; await this.update(workId, jobId, { status: 'downloading', remoteStatus: 'succeeded' }) }
      } else if (!job.remoteId && !artifact && !(await exists(raw))) {
        await this.update(workId, jobId, { status: 'unknown', error: 'Submission outcome is unknown. No automatic resubmission; verify the provider before creating a new operation.' }); return
      }
      if (job.remoteId && !artifact && !(await exists(raw))) {
        if (!provider.poll) throw new Error('Original provider cannot query this remote task')
        let failures = 0
        for (let poll = 0; poll < (this.options.maxPolls ?? 1200); poll++) {
          job = await this.job(workId, jobId)
          if (signal.aborted) throw new Error('Worker interrupted')
          if (job.stopRequested && provider.cancel) {
            const cancelled = await provider.cancel(job.remoteId!, request)
            if (cancelled) { await this.update(workId, jobId, { status: 'cancelled', remoteStatus: 'cancelled' }); return }
          }
          try {
            const result = await provider.poll(job.remoteId!, request)
            failures = 0
            if (result.state === 'succeeded') {
              await this.update(workId, jobId, { remoteStatus: result.remoteStatus ?? 'succeeded' })
              if (job.stopRequested) { await this.update(workId, jobId, { status: 'cancelled', error: 'Remote task completed after cancellation; its result was not adopted.' }); return }
              artifact = result.artifact; break
            }
            if (result.state === 'failed' || result.state === 'cancelled') { await this.update(workId, jobId, { status: result.state, remoteStatus: result.remoteStatus ?? result.state, error: result.error }); return }
            await this.update(workId, jobId, { status: 'running', remoteStatus: result.remoteStatus ?? 'running', error: undefined })
          } catch (error) {
            failures++; await this.update(workId, jobId, { error: `Remote query failed; original task retained. ${safeError(error)}` })
            if (failures >= 3) return
          }
          await delay((this.options.pollIntervalMs ?? 2000) * Math.max(1, failures), signal)
        }
        if (!artifact) { await this.update(workId, jobId, { error: 'Polling paused after its bounded window; resume to query the same remote task.' }); return }
      }
      if (!(await exists(raw))) await this.saveArtifact(workId, jobId, artifact!, signal)
      await this.update(workId, jobId, { status: 'validating' })
      job = await this.job(workId, jobId)
      const info = await validateMedia(raw, job.kind, this.ffprobe, signal)
      await run(this.ffmpeg, ['-hide_banner', '-v', 'error', '-i', raw, '-f', 'null', '-'], { signal, timeoutMs: 120_000 })
      const format = mediaFormat(job.kind, info), assetId = `asset-${job.id}`, path = `media/assets/${assetId}.${format.extension}`
      await mkdir(dirname(this.store.filePath(workId, path)), { recursive: true })
      await copyFile(raw, this.store.filePath(workId, path))
      const digest = await fileHash(raw)
      await this.store.mutate(workId, undefined, (work) => {
        const current = work.jobs.find((item) => item.id === jobId)!
        if (current.stopRequested) { current.status = 'cancelled'; current.updatedAt = now(); return }
        if (!work.assets.some((item) => item.id === assetId)) work.assets.push({ id: assetId, kind: job.kind, name: `${job.mode === 'preview' ? '预演（非 AI）' : '生成'} ${job.shotId}`, path, mimeType: format.mimeType, hash: digest, source: 'generated', jobId, createdAt: now() })
        const takeId = `take-${job.id}`
        if (!work.takes.some((item) => item.id === takeId)) work.takes.push({ id: takeId, jobId, chapterId: job.chapterId, shotId: job.shotId, kind: job.kind, assetId, fingerprint: job.fingerprint, chapterRevision: job.chapterRevision, mode: job.mode, createdAt: now() })
        Object.assign(current, { status: 'succeeded', assetId, takeId, updatedAt: now(), error: undefined })
        addEvent(work, 'generation.completed', 'Candidate downloaded and validated; selection remains unchanged', jobId, job.chapterId)
      })
    } catch (error) {
      const job = await this.job(workId, jobId).catch(() => undefined)
      if (job && !terminal.has(job.status)) {
        const rawExists = await exists(this.store.filePath(workId, `media/jobs/${jobId}/result.bin`))
        const ambiguous = job.mode === 'production' && job.status === 'submitting' && submittedHere && (!(error instanceof ProviderError) || error.ambiguous)
        const resumable = Boolean(job.remoteId || job.remoteResult || rawExists)
        const invalidMedia = job.status === 'validating' && !signal.aborted
        const status = job.stopRequested && job.mode === 'preview' ? 'cancelled' : ambiguous ? 'unknown' : invalidMedia ? 'failed' : resumable ? job.status : 'failed'
        await this.update(workId, jobId, { status, error: safeError(error) })
      }
    } finally { await release() }
  }
  async resume(workId: string): Promise<WorkState> {
    this.assertAlive()
    const state = await this.store.get(workId)
    for (const job of state.jobs) if (!terminal.has(job.status)) this.schedule(workId, job.id)
    for (const render of state.renders) if (render.status === 'rendering' && render.timelinePath) this.scheduleRender(workId, render.id, render.timelinePath)
    return state
  }
  async cancel(workId: string, jobId: string): Promise<WorkState> {
    const state = await this.store.mutate(workId, undefined, (work) => {
      const job = work.jobs.find((item) => item.id === jobId); if (!job) throw new Error('Job not found')
      if (terminal.has(job.status)) return
      job.stopRequested = true; job.updatedAt = now(); if (job.status === 'queued') job.status = 'cancelled'
      addEvent(work, 'generation.cancel-requested', 'Pending work stopped; remote state remains independently tracked', jobId, job.chapterId)
    })
    const job = state.jobs.find((item) => item.id === jobId)!
    if (job.mode === 'preview') this.queue.interrupt(`${workId}:${jobId}`)
    else if (!terminal.has(job.status)) this.schedule(workId, jobId)
    return state
  }
  async importAsset(workId: string, input: { path: string; name: string; kind: MediaKind; entityId?: string }, expectedRevision: number): Promise<WorkState> {
    this.assertAlive()
    // Import may read a user-specified local source; generated destination is always inside this work.
    const source = resolve(input.path), info = await validateMedia(source, input.kind, this.ffprobe), format = mediaFormat(input.kind, info)
    if ((await stat(source)).size > (this.options.maxDownloadBytes ?? 256 * 1024 * 1024)) throw new Error('Asset exceeds the configured size limit')
    const id = randomUUID(), path = `media/assets/${id}.${format.extension}`, destination = this.store.filePath(workId, path)
    await mkdir(dirname(destination), { recursive: true }); await copyFile(source, destination)
    const digest = await fileHash(destination)
    return this.store.mutate(workId, expectedRevision, (work) => {
      if (input.entityId && !work.canon.some((item) => item.id === input.entityId)) throw new Error('Asset entity does not belong to this work')
      work.assets.push({ id, name: input.name, kind: input.kind, entityId: input.entityId, path, mimeType: format.mimeType, hash: digest, source: 'local', createdAt: now() })
      addEvent(work, 'asset.imported', `Imported ${input.name}`, id)
    })
  }
  async render(workId: string, input: { chapterId: string; voice?: boolean; subtitles?: boolean }, expectedRevision: number): Promise<WorkState> {
    this.assertAlive()
    const work = await this.store.get(workId), chapter = chapterFor(work, input.chapterId)
    approved(work, chapter)
    const plan = buildRenderPlan(work, chapter, input), id = randomUUID(), timelinePath = `media/renders/${id}/input.json`
    const path = this.store.filePath(workId, timelinePath)
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(plan, null, 2))
    const state = await this.store.mutate(workId, expectedRevision, (current) => {
      const currentChapter = chapterFor(current, input.chapterId); approved(current, currentChapter)
      if (hash(JSON.stringify(buildRenderPlan(current, currentChapter, input))) !== hash(JSON.stringify(plan))) throw new Error('Render inputs changed; retry with current selections')
      current.renders.push({ id, chapterId: chapter.id, chapterRevision: chapter.revision, status: 'rendering', createdAt: now(), updatedAt: now(), inputHash: hash(JSON.stringify(plan)), timelinePath, mode: plan.mode })
      addEvent(current, 'render.started', plan.clips.some((clip) => clip.sourceKind === 'image') ? 'Rendering selected assets, including explicitly labelled animated still images' : 'Rendering selected video candidates', id, chapter.id)
    })
    this.scheduleRender(workId, id, timelinePath)
    return state
  }
  private scheduleRender(workId: string, renderId: string, inputPath: string): void {
    this.renderQueue.add(`${workId}:render:${renderId}`, async (signal) => {
      const release = await acquireJobLock(this.store.filePath(workId, `media/renders/${renderId}/worker.lock`)); if (!release) return
      try {
        const work = await this.store.get(workId), record = work.renders.find((item) => item.id === renderId)
        if (!record || record.status !== 'rendering') return
        const plan: RenderPlan = JSON.parse(await readFile(this.store.filePath(workId, inputPath), 'utf8'))
        if (hash(JSON.stringify(plan)) !== record.inputHash) throw new Error('Persisted render input has changed; refusing to render an untracked plan')
        const output = await executeRender(this.store, workId, renderId, plan, { ffmpeg: this.ffmpeg, ffprobe: this.ffprobe, signal })
        await this.store.mutate(workId, undefined, (current) => { Object.assign(current.renders.find((item) => item.id === renderId)!, output, { status: 'completed', updatedAt: now() }); addEvent(current, 'render.completed', 'MP4, SRT and timeline validated', renderId, plan.chapterId) })
      } catch (error) {
        await this.store.mutate(workId, undefined, (work) => { const record = work.renders.find((item) => item.id === renderId); if (record) { record.status = signal.aborted && this.disposed ? 'rendering' : 'failed'; record.error = safeError(error); record.updatedAt = now() } })
      } finally { await release() }
    })
  }
  async waitForIdle(): Promise<void> { await Promise.all([this.queue.waitForIdle(), this.renderQueue.waitForIdle()]) }
  async dispose(): Promise<void> { this.disposed = true; this.queue.dispose(); this.renderQueue.dispose(); await this.waitForIdle() }
}
