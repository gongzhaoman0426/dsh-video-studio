import type { MediaKind } from '../domain/types.ts'

export interface MediaRequest {
  kind: MediaKind; model?: string; prompt: string; negative?: string; text?: string;
  durationSec: number; aspectRatio: string; references: Array<{ path: string; mimeType: string }>;
  requestKey: string; outputDirectory: string; signal: AbortSignal;
}
export interface MediaArtifact { url?: string; bytes?: Uint8Array; path?: string; mimeType?: string }
export type SubmitResult = { remoteId: string; artifact?: never } | { artifact: MediaArtifact; remoteId?: never }
export type PollResult = { state: 'running'; remoteStatus?: string } | { state: 'succeeded'; artifact: MediaArtifact; remoteStatus?: string } | { state: 'failed' | 'cancelled'; error?: string; remoteStatus?: string }
export interface MediaProvider {
  id: string; configId: string; label: string; mode: 'preview' | 'production'; kinds: MediaKind[];
  configured: boolean; models: Partial<Record<MediaKind, string>>;
  validate(request: MediaRequest): void;
  submit(request: MediaRequest): Promise<SubmitResult>;
  poll?(remoteId: string, request: MediaRequest): Promise<PollResult>;
  cancel?(remoteId: string, request: MediaRequest): Promise<boolean>;
}
/** A definite rejection may be retried as a new operation; a lost submit response is never silently resubmitted. */
export class ProviderError extends Error {
  constructor(message: string, public readonly ambiguous = false) { super(message); this.name = 'ProviderError' }
}
