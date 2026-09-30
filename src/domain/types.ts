/** Durable state shared by DSH tools, the chapter panel and media workers. */
export type MediaKind = 'image' | 'video' | 'audio'
export interface SourceRevision { id: string; text: string; hash: string; at: string; paragraphs: Array<{ id: string; text: string }> }
export interface Beat { id: string; kind: 'action' | 'dialogue' | 'narration'; text: string; speakerId?: string; tone?: string; sourceParagraphIds: string[] }
export interface Scene { id: string; title: string; location: string; time: string; characterIds: string[]; beats: Beat[] }
export interface Shot {
  id: string; sceneId: string; title: string; beatIds: string[]; description: string;
  prompt: string; camera: string; durationSec: number; characterIds: string[]; assetIds: string[];
  narration: string; negative?: string; continuityIn?: string; continuityOut?: string;
}
export interface ChapterDraft { sourceRevisionId?: string; summary: string; adaptationNotes: string; scenes: Scene[]; shots: Shot[] }
export interface Selection { image?: string; video?: string; audio?: string }
export interface Chapter {
  id: string; title: string; order: number; revision: number; sourceRevisionId: string;
  sources: SourceRevision[]; draft?: ChapterDraft; approvedRevision?: number;
  selections: Record<string, Selection>; createdAt: string; updatedAt: string;
}
export interface CanonEntry {
  id: string; kind: 'character' | 'location' | 'prop' | 'style'; name: string; description: string;
  aliases: string[]; revision: number; assetId?: string; knownFromChapter: number;
}
export interface ContinuityFact {
  id: string; subjectId: string; text: string; scope: 'source' | 'adaptation';
  origin: 'source' | 'user' | 'inference' | 'adaptation'; knownFromChapter: number;
  storyTime: string; confirmed: boolean; needsReview?: boolean; reviewReason?: string; sourceChapterId?: string; sourceRevisionId?: string; sourceParagraphIds: string[];
}
export interface Asset {
  id: string; entityId?: string; kind: MediaKind; name: string; path: string; createdAt: string;
  mimeType: string; hash: string; source: 'local' | 'generated'; jobId?: string;
}
export type JobStatus = 'queued' | 'submitting' | 'submitted' | 'running' | 'downloading' | 'validating' | 'succeeded' | 'failed' | 'cancelled' | 'unknown'
export interface GenerationJob {
  id: string; operationId: string; requestKey: string; chapterId: string; shotId: string; kind: MediaKind;
  chapterRevision: number; fingerprint: string; mode: 'preview' | 'production';
  providerId: string; providerConfigId?: string; model?: string; status: JobStatus; remoteStatus?: string; remoteId?: string;
  remoteResult?: { url: string; mimeType?: string };
  stopRequested: boolean; attempt: number; input: { prompt: string; negative?: string; text?: string; durationSec: number; aspectRatio: string; referencePaths: string[] };
  createdAt: string; updatedAt: string; error?: string; assetId?: string; takeId?: string;
}
export interface Take { id: string; jobId: string; chapterId: string; shotId: string; kind: MediaKind; assetId: string; fingerprint: string; chapterRevision: number; createdAt: string; mode: 'preview' | 'production' }
export interface RenderRecord {
  id: string; chapterId: string; chapterRevision: number; status: 'rendering' | 'completed' | 'failed';
  createdAt: string; updatedAt: string; videoPath?: string; subtitlePath?: string; timelinePath?: string;
  durationSec?: number; error?: string; inputHash: string; mode: 'preview' | 'production';
}
export interface StudioEvent { id: string; at: string; type: string; message: string; chapterId?: string; objectId?: string }
export interface Decision { id: string; chapterId: string; revision: number; kind: 'approve' | 'note' | 'revoke'; text: string; at: string; sessionId?: string }
export interface WorkState {
  schemaVersion: 1; id: string; title: string; revision: number; style: string;
  aspectRatio: '16:9' | '9:16' | '1:1'; createdAt: string; updatedAt: string;
  chapters: Chapter[]; canon: CanonEntry[]; canonHistory?: CanonEntry[]; facts: ContinuityFact[];
  assets: Asset[]; jobs: GenerationJob[]; takes: Take[]; renders: RenderRecord[];
  decisions: Decision[]; events: StudioEvent[];
}
export interface WorkSummary { id: string; title: string; revision: number; chapterCount: number; updatedAt: string }
export interface SessionBinding { sessionId: string; workId: string; chapterId?: string; updatedAt: string }
export interface ValidationIssue { level: 'error' | 'warning'; path: string; message: string }
export interface ValidationReport { valid: boolean; issues: ValidationIssue[]; estimatedDurationSec: number }
export interface StudioContext { work: { id: string; title: string; style: string; aspectRatio: string; revision: number }; chapter?: Chapter; canon: CanonEntry[]; facts: ContinuityFact[]; decisions: Decision[]; pendingJobs: GenerationJob[]; next: string[] }
