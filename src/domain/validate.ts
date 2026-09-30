import { createHash } from 'node:crypto'
import type { CanonEntry, Chapter, MediaKind, Shot, StudioContext, ValidationIssue, ValidationReport, WorkState } from './types.js'
import { chapterDraftSchema } from './schema.js'

/** Resolve identity revisions as known at this chapter, never the latest future revision. */
export function canonFor(work: WorkState, order: number): CanonEntry[] {
  const chosen = new Map<string, CanonEntry>()
  for (const entry of [...(work.canonHistory ?? []), ...work.canon]) {
    if (entry.knownFromChapter > order) continue
    const previous = chosen.get(entry.id)
    if (!previous || entry.revision > previous.revision) chosen.set(entry.id, entry)
  }
  return [...chosen.values()].sort((a, b) => a.id.localeCompare(b.id))
}

export function validateChapter(work: WorkState, chapter: Chapter): ValidationReport {
  const issues: ValidationIssue[] = []
  const issue = (path: string, message: string, level: ValidationIssue['level'] = 'error') => issues.push({ level, path, message })
  const base = `chapters.${chapter.id}`
  const source = chapter.sources.find(item => item.id === chapter.sourceRevisionId)
  if (!source) issue(`${base}.sourceRevisionId`, 'Current source revision does not exist')
  if (!chapter.draft) return { valid: false, issues: [...issues, { level: 'error', path: `${base}.draft`, message: 'Create a chapter draft before approval or production' }], estimatedDurationSec: 0 }
  const parsed = chapterDraftSchema.safeParse(chapter.draft)
  if (!parsed.success) return { valid: false, issues: [...issues, ...parsed.error.issues.map(entry => ({ level: 'error' as const, path: `${base}.draft.${entry.path.join('.')}`, message: entry.message }))], estimatedDurationSec: 0 }
  const draft = parsed.data
  if (draft.sourceRevisionId && draft.sourceRevisionId !== chapter.sourceRevisionId) issue(`${base}.draft.sourceRevisionId`, 'Draft references an older source revision; review and save it against the current source')
  if (!draft.scenes.length) issue(`${base}.draft.scenes`, 'At least one scene is required')
  if (!draft.shots.length) issue(`${base}.draft.shots`, 'At least one shot is required')
  const sourceParagraphs = new Set(source?.paragraphs.map(item => item.id) ?? [])
  const visibleCanon = new Map(canonFor(work, chapter.order).map(item => [item.id, item]))
  const assets = new Map(work.assets.map(item => [item.id, item]))
  const scenes = new Map(draft.scenes.map(scene => [scene.id, scene]))
  const allBeats = new Map(draft.scenes.flatMap(scene => scene.beats.map(beat => [beat.id, { beat, sceneId: scene.id }] as const)))
  const unique = (values: string[], path: string) => {
    const seen = new Set<string>()
    for (const id of values) { if (seen.has(id)) issue(path, `Duplicate ID: ${id}`); seen.add(id) }
  }
  unique(draft.scenes.map(item => item.id), `${base}.draft.scenes`)
  unique(draft.shots.map(item => item.id), `${base}.draft.shots`)
  unique(draft.scenes.flatMap(scene => scene.beats.map(item => item.id)), `${base}.draft.beats`)
  const otherDrafts = work.chapters.filter(item => item.id !== chapter.id).flatMap(item => item.draft ? [item.draft] : [])
  const otherIds = new Set(otherDrafts.flatMap(item => [...item.scenes.map(scene => scene.id), ...item.scenes.flatMap(scene => scene.beats.map(beat => beat.id)), ...item.shots.map(shot => shot.id)]))
  const localIds = [...draft.scenes.map(scene => scene.id), ...draft.scenes.flatMap(scene => scene.beats.map(beat => beat.id)), ...draft.shots.map(shot => shot.id)]
  unique(localIds, `${base}.draft`)
  for (const id of localIds) if (otherIds.has(id)) issue(`${base}.draft`, `ID ${id} is already used in another chapter`)
  const checkCharacters = (ids: string[], path: string) => {
    unique(ids, path)
    for (const id of ids) if (visibleCanon.get(id)?.kind !== 'character') issue(path, `Character ${id} is missing or is not known in this chapter`)
  }
  for (const scene of draft.scenes) {
    const path = `${base}.draft.scenes.${scene.id}`
    checkCharacters(scene.characterIds, `${path}.characterIds`)
    if (!scene.beats.length) issue(`${path}.beats`, 'A scene must contain at least one action or spoken beat')
    for (const beat of scene.beats) {
      unique(beat.sourceParagraphIds, `${path}.beats.${beat.id}.sourceParagraphIds`)
      for (const id of beat.sourceParagraphIds) if (!sourceParagraphs.has(id)) issue(`${path}.beats.${beat.id}.sourceParagraphIds`, `Paragraph ${id} is not in the current source revision`)
      if (beat.kind === 'dialogue' && !beat.speakerId) issue(`${path}.beats.${beat.id}.speakerId`, 'Dialogue requires a character speaker')
      if (beat.speakerId && visibleCanon.get(beat.speakerId)?.kind !== 'character') issue(`${path}.beats.${beat.id}.speakerId`, `Speaker ${beat.speakerId} is missing or not known in this chapter`)
      if (beat.kind === 'dialogue' && beat.speakerId && !scene.characterIds.includes(beat.speakerId)) issue(`${path}.beats.${beat.id}.speakerId`, 'Dialogue speaker must be included in the scene cast')
      if (!beat.sourceParagraphIds.length && !draft.adaptationNotes.trim()) issue(`${path}.beats.${beat.id}`, 'Unreferenced beat needs an adaptation note explaining added material')
    }
    const expected = scene.beats.map(beat => beat.id)
    const actual = draft.shots.filter(shot => shot.sceneId === scene.id).flatMap(shot => shot.beatIds)
    if (JSON.stringify(actual) !== JSON.stringify(expected)) issue(`${path}.beats`, 'Shots must cover every scene beat exactly once in script order')
  }
  let lastScene = -1
  for (const shot of draft.shots) {
    const path = `${base}.draft.shots.${shot.id}`
    const scene = scenes.get(shot.sceneId)
    if (!scene) issue(`${path}.sceneId`, `Scene ${shot.sceneId} does not exist`)
    const sceneIndex = draft.scenes.findIndex(item => item.id === shot.sceneId)
    if (sceneIndex < lastScene) issue(`${path}.sceneId`, 'Shot order returns to an earlier scene; revise the scene sequence explicitly')
    lastScene = Math.max(lastScene, sceneIndex)
    if (!shot.beatIds.length) issue(`${path}.beatIds`, 'A shot must reference at least one story beat')
    unique(shot.beatIds, `${path}.beatIds`)
    checkCharacters(shot.characterIds, `${path}.characterIds`)
    for (const id of shot.characterIds) if (scene && !scene.characterIds.includes(id)) issue(`${path}.characterIds`, `Character ${id} is not listed in the scene`)
    unique(shot.assetIds, `${path}.assetIds`)
    for (const id of shot.assetIds) if (!assets.has(id)) issue(`${path}.assetIds`, `Asset ${id} does not exist`)
    for (const id of shot.beatIds) if (allBeats.get(id)?.sceneId !== shot.sceneId) issue(`${path}.beatIds`, `Beat ${id} does not belong to this shot's scene`)
    const spoken = shot.beatIds.flatMap(id => { const beat = allBeats.get(id)?.beat; return beat && beat.kind !== 'action' ? [beat.text] : [] })
    // Narration is the actual speech input, including character dialogue, not an arbitrary synopsis.
    const normalize = (value: string) => value.replace(/[\s\p{P}\p{S}]/gu, '')
    const speech = normalize(shot.narration)
    let cursor = 0
    for (const line of spoken) {
      const part = normalize(line)
      const at = speech.indexOf(part, cursor)
      if (part && at < 0) issue(`${path}.narration`, 'Speech text must contain each dialogue/narration beat in order; revise the script explicitly when changing words')
      else cursor = at + part.length
    }
    if (!spoken.length && speech) issue(`${path}.narration`, 'Speech is not backed by a dialogue/narration beat; add it to the script before production')
    const estimatedSpeech = spoken.join('').replace(/\s/g, '').length / 4
    if (estimatedSpeech > shot.durationSec) issue(`${path}.durationSec`, `Estimated speech (${estimatedSpeech.toFixed(1)}s) exceeds shot duration (${shot.durationSec}s); verify with actual audio`, 'warning')
    for (const kind of ['image', 'video', 'audio'] as const) {
      const selectedId = chapter.selections[shot.id]?.[kind]
      if (!selectedId) continue
      const take = work.takes.find(item => item.id === selectedId)
      if (!take || take.chapterId !== chapter.id || take.shotId !== shot.id || take.kind !== kind || !assets.has(take.assetId)) issue(`${path}.selection.${kind}`, 'Selected take is missing or belongs to a different shot/media kind')
      else if (take.fingerprint !== shotFingerprint(work, chapter, shot, kind)) issue(`${path}.selection.${kind}`, 'Selected take was made from older inputs; review or generate a new candidate', 'warning')
    }
  }
  return { valid: !issues.some(item => item.level === 'error'), issues, estimatedDurationSec: draft.shots.reduce((sum, item) => sum + item.durationSec, 0) }
}

export function contextFor(work: WorkState, chapterId?: string): StudioContext {
  const chapter = chapterId ? work.chapters.find(item => item.id === chapterId) : undefined
  if (chapterId && !chapter) throw new Error(`Chapter not found: ${chapterId}`)
  const order = chapter?.order ?? 0
  const canon = canonFor(work, order)
  const subjects = new Set(canon.map(item => item.id))
  const facts = work.facts.filter(item => item.knownFromChapter <= order && subjects.has(item.subjectId)).map(fact => {
    const sourceChapter = fact.sourceChapterId ? work.chapters.find(item => item.id === fact.sourceChapterId) : undefined
    if (fact.sourceChapterId && (!sourceChapter || fact.sourceRevisionId !== sourceChapter.sourceRevisionId)) return {
      ...fact, confirmed: false, needsReview: true,
      reviewReason: 'The cited chapter source was revised or is missing; review this fact against the current text.',
    }
    return fact
  })
  const relevantIds = new Set(work.chapters.filter(item => item.order <= order).map(item => item.id))
  const next = !chapter ? ['Select or add a chapter in this session.']
    : !chapter.draft ? ['Read the current chapter and relevant continuity, then discuss and save an adaptation and storyboard draft.']
    : !validateChapter(work, chapter).valid ? ['Review the chapter validation issues and revise the affected script or shots.']
    : chapter.approvedRevision !== chapter.revision ? ['Review this revision with the user; record approval only when they have approved this scope.']
    : ['Continue the requested asset, shot generation, or editing work using the approved revision.']
  const pendingFacts = facts.filter(fact => fact.needsReview)
  if (pendingFacts.length) next.unshift(`Review ${pendingFacts.length} continuity fact(s) whose source changed before relying on them: ${pendingFacts.map(fact => fact.id).join(', ')}.`)
  return structuredClone({ work: { id: work.id, title: work.title, style: work.style, aspectRatio: work.aspectRatio, revision: work.revision }, ...(chapter ? { chapter } : {}), canon, facts, decisions: work.decisions.filter(item => relevantIds.has(item.chapterId)), pendingJobs: work.jobs.filter(item => item.chapterId === chapter?.id && !['succeeded', 'failed', 'cancelled'].includes(item.status)), next })
}

/** Content-derived dependencies: unrelated edits/work revisions cannot invalidate a shot. */
export function shotFingerprint(work: WorkState, chapter: Chapter, shot: Shot, kind: MediaKind): string {
  const scene = chapter.draft?.scenes.find(item => item.id === shot.sceneId)
  const beats = shot.beatIds.map(id => scene?.beats.find(item => item.id === id)).filter(Boolean)
  const characterIds = new Set([...shot.characterIds, ...beats.flatMap(beat => beat?.speakerId ? [beat.speakerId] : [])])
  const canon = canonFor(work, chapter.order).filter(entry => characterIds.has(entry.id) || entry.id === scene?.location || entry.kind === 'style' || (entry.assetId && shot.assetIds.includes(entry.assetId)))
  const referenceIds = new Set([...shot.assetIds, ...canon.flatMap(entry => entry.assetId ? [entry.assetId] : [])])
  if (kind === 'video') {
    const imageId = chapter.selections[shot.id]?.image
    const imageTake = work.takes.find(item => item.id === imageId)
    if (imageTake) referenceIds.add(imageTake.assetId)
  }
  const references = [...referenceIds].sort().map(id => {
    const asset = work.assets.find(item => item.id === id)
    return asset ? { id, hash: asset.hash, path: asset.path, kind: asset.kind } : { id, missing: true }
  })
  const snapshot = {
    kind, workStyle: work.style, ...(kind !== 'audio' ? { aspectRatio: work.aspectRatio } : {}),
    shot: kind === 'audio' ? { narration: shot.narration } : { description: shot.description, prompt: shot.prompt, negative: shot.negative, camera: shot.camera, durationSec: shot.durationSec, continuityIn: shot.continuityIn, continuityOut: shot.continuityOut },
    scene: kind === 'audio' ? undefined : { location: scene?.location, time: scene?.time },
    beats: beats.map(beat => kind === 'audio' ? { kind: beat?.kind, text: beat?.text, speakerId: beat?.speakerId, tone: beat?.tone } : beat),
    canon, references: kind === 'audio' ? undefined : references,
  }
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
}
