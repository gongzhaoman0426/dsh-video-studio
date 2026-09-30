import { z } from 'zod'

export const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/, 'Expected a stable ID containing letters, numbers, underscore or hyphen')
const text = z.string()
const nonempty = z.string().refine(value => value.trim().length > 0, 'Must not be blank')
const integer = z.number().int().nonnegative()
const date = z.string().datetime()
export const mediaKindSchema = z.enum(['image', 'video', 'audio'])
const sourceSchema = z.object({ id: idSchema, text: nonempty, hash: z.string().regex(/^[a-f0-9]{64}$/), at: date, paragraphs: z.array(z.object({ id: idSchema, text: nonempty }).strict()).min(1) }).strict()
const beatSchema = z.object({ id: idSchema, kind: z.enum(['action', 'dialogue', 'narration']), text: nonempty, speakerId: idSchema.optional(), tone: text.optional(), sourceParagraphIds: z.array(idSchema) }).strict()
export const sceneSchema = z.object({ id: idSchema, title: nonempty, location: nonempty, time: text, characterIds: z.array(idSchema), beats: z.array(beatSchema) }).strict()
export const shotSchema = z.object({
  id: idSchema, sceneId: idSchema, title: nonempty, beatIds: z.array(idSchema), description: nonempty,
  prompt: nonempty, camera: text, durationSec: z.number().finite().positive().max(3600), characterIds: z.array(idSchema), assetIds: z.array(idSchema),
  narration: text, negative: text.optional(), continuityIn: text.optional(), continuityOut: text.optional(),
}).strict()
export const chapterDraftSchema = z.object({ sourceRevisionId: idSchema.optional(), summary: nonempty, adaptationNotes: text, scenes: z.array(sceneSchema), shots: z.array(shotSchema) }).strict()
const selectionSchema = z.object({ image: idSchema.optional(), video: idSchema.optional(), audio: idSchema.optional() }).strict()
export const chapterSchema = z.object({ id: idSchema, title: nonempty, order: integer, revision: integer, sourceRevisionId: idSchema, sources: z.array(sourceSchema).min(1), draft: chapterDraftSchema.optional(), approvedRevision: integer.optional(), selections: z.record(idSchema, selectionSchema), createdAt: date, updatedAt: date }).strict()
export const canonEntrySchema = z.object({ id: idSchema, kind: z.enum(['character', 'location', 'prop', 'style']), name: nonempty, description: nonempty, aliases: z.array(nonempty), revision: integer, assetId: idSchema.optional(), knownFromChapter: integer }).strict()
export const factSchema = z.object({ id: idSchema, subjectId: idSchema, text: nonempty, scope: z.enum(['source', 'adaptation']), origin: z.enum(['source', 'user', 'inference', 'adaptation']), knownFromChapter: integer, storyTime: text, confirmed: z.boolean(), needsReview: z.boolean().optional(), reviewReason: text.optional(), sourceChapterId: idSchema.optional(), sourceRevisionId: idSchema.optional(), sourceParagraphIds: z.array(idSchema) }).strict()
const assetSchema = z.object({ id: idSchema, entityId: idSchema.optional(), kind: mediaKindSchema, name: nonempty, path: nonempty, createdAt: date, mimeType: nonempty, hash: nonempty, source: z.enum(['local', 'generated']), jobId: idSchema.optional() }).strict()
const jobSchema = z.object({
  id: idSchema, operationId: nonempty, requestKey: nonempty, chapterId: idSchema, shotId: idSchema, kind: mediaKindSchema,
  chapterRevision: integer, fingerprint: nonempty, mode: z.enum(['preview', 'production']), providerId: nonempty, model: text.optional(), providerConfigId: text.optional(),
  status: z.enum(['queued', 'submitting', 'submitted', 'running', 'downloading', 'validating', 'succeeded', 'failed', 'cancelled', 'unknown']), remoteStatus: text.optional(), remoteId: text.optional(), remoteResult: z.object({ url: nonempty, mimeType: text.optional() }).strict().optional(), stopRequested: z.boolean(), attempt: integer,
  input: z.object({ prompt: text, negative: text.optional(), text: text.optional(), durationSec: z.number().finite().positive(), aspectRatio: nonempty, referencePaths: z.array(nonempty) }).strict(),
  createdAt: date, updatedAt: date, error: text.optional(), assetId: idSchema.optional(), takeId: idSchema.optional(),
}).strict()
const takeSchema = z.object({ id: idSchema, jobId: idSchema, chapterId: idSchema, shotId: idSchema, kind: mediaKindSchema, assetId: idSchema, fingerprint: nonempty, chapterRevision: integer, createdAt: date, mode: z.enum(['preview', 'production']) }).strict()
const renderSchema = z.object({ id: idSchema, chapterId: idSchema, chapterRevision: integer, status: z.enum(['rendering', 'completed', 'failed']), createdAt: date, updatedAt: date, videoPath: text.optional(), subtitlePath: text.optional(), timelinePath: text.optional(), durationSec: z.number().finite().nonnegative().optional(), error: text.optional(), inputHash: nonempty, mode: z.enum(['preview', 'production']) }).strict()
const decisionSchema = z.object({ id: idSchema, chapterId: idSchema, revision: integer, kind: z.enum(['approve', 'note', 'revoke']), text, at: date, sessionId: nonempty.optional() }).strict()
const eventSchema = z.object({ id: idSchema, at: date, type: nonempty, message: text, chapterId: idSchema.optional(), objectId: idSchema.optional() }).strict()
export const workStateSchema = z.object({
  schemaVersion: z.literal(1), id: idSchema, title: nonempty, revision: integer, style: text, aspectRatio: z.enum(['16:9', '9:16', '1:1']), createdAt: date, updatedAt: date,
  chapters: z.array(chapterSchema), canon: z.array(canonEntrySchema), canonHistory: z.array(canonEntrySchema).optional(), facts: z.array(factSchema), assets: z.array(assetSchema), jobs: z.array(jobSchema), takes: z.array(takeSchema), renders: z.array(renderSchema), decisions: z.array(decisionSchema), events: z.array(eventSchema),
}).strict()
export const bindingSchema = z.object({ sessionId: nonempty, workId: idSchema, chapterId: idSchema.optional(), updatedAt: date }).strict()
