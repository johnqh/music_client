/**
 * MusicClient — the single typed gateway to music_api (SudojoClient
 * pattern): constructed with an injected NetworkClient + baseUrl, all HTTP
 * through one private `request<T>()` funnel, bearer token passed per call
 * (never stored), envelope unwrapping and typed-error mapping in one place.
 */
import type { NetworkClient } from '@sudobility/types';
import type {
  ApiResponse,
  CreateGenerationJobRequest,
  GenerateScoreRequest,
  GenerateScoreResult,
  GenerationJob,
  ProjectCreateRequest,
  ProjectDuplicateRequest,
  ProjectListQuery,
  ProjectRecord,
  ProjectSaveResult,
  ProjectStatusResult,
  ProjectSummary,
  ProjectUpdateRequest,
  CommunityItem,
  PublishedSnapshot,
  Snapshot,
  SnapshotSummary,
  RegenerateRegionRequest,
  RegenerateRegionResult,
} from '@sudobility/music_types';
import {
  AiGenerationError,
  AiOutputInvalidError,
  ApiError,
  ProjectNotFoundError,
  QuotaExceededError,
} from '../errors.js';

const BASE_PATH = '/api/v1';

/**
 * Bodies below this go up as-is.
 *
 * gzip costs a header and a CPU pass; below a kilobyte it can make the payload
 * *larger*, and a request that small was never the problem. Matches the floor
 * the server's response compression uses, so both directions turn on together.
 */
const COMPRESS_MIN_BYTES = 1024;

/**
 * Gzips a request body when it is worth it and the platform can.
 *
 * A browser gzips responses it *receives* automatically and bodies it *sends*
 * never — so uploading a score, the largest thing this client does and the
 * thing an autosave does on every debounce window, was the one leg still
 * paying full price. `CompressionStream` is missing on React Native's engine,
 * which is why this degrades to the plain string rather than assuming it.
 */
async function encodeBody(json: string): Promise<{ body: string | Blob; encoding?: string }> {
  if (json.length < COMPRESS_MIN_BYTES || typeof CompressionStream === 'undefined') {
    return { body: json };
  }
  try {
    // Through `Response`, not `Blob.stream()`: jsdom's Blob has no `stream`,
    // so the Blob route silently degrades in exactly the environment the tests
    // run in — the feature would never have been exercised.
    const source = new Response(json).body;
    if (!source) return { body: json };
    const gzipped = await new Response(source.pipeThrough(new CompressionStream('gzip')))
      .arrayBuffer();
    return { body: new Blob([gzipped]), encoding: 'gzip' };
  } catch {
    // Never fail a save over an optimisation.
    return { body: json };
  }
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  /**
   * Sent as-is under `contentType`, instead of being JSON-encoded.
   *
   * For audio going up to be separated: it is already bytes, and putting it
   * through `JSON.stringify` plus base64 would add a third to the largest
   * payload this client sends to carry bytes that are bytes. Gzip is skipped
   * with it — a WAV compresses a little, an MP3 not at all, and neither is
   * worth a pass over tens of megabytes.
   */
  rawBody?: Blob | FormData;
  contentType?: string;
  token?: string;
  signal?: AbortSignal;
};

export class MusicClient {
  private readonly networkClient: NetworkClient;
  private readonly baseUrl: string;

  constructor(networkClient: NetworkClient, baseUrl: string) {
    this.networkClient = networkClient;
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  private async request<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
    const url = `${this.baseUrl}${BASE_PATH}${endpoint}`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (options.token) {
      headers['Authorization'] = `Bearer ${options.token}`;
    }

    let body: string | Blob | FormData | undefined;
    if (options.rawBody !== undefined) {
      body = options.rawBody;
      if (options.rawBody instanceof FormData) {
        // Left to the platform: multipart needs a boundary parameter that only
        // whatever sends the body can generate, and setting the header by hand
        // produces one without it, which the server cannot parse.
        delete headers['Content-Type'];
      } else {
        headers['Content-Type'] = options.contentType ?? 'application/octet-stream';
      }
    } else if (options.body !== undefined) {
      const encoded = await encodeBody(JSON.stringify(options.body));
      body = encoded.body;
      if (encoded.encoding) headers['Content-Encoding'] = encoded.encoding;
    }

    const response = await this.networkClient.request<ApiResponse<T>>(url, {
      method: options.method ?? 'GET',
      headers,
      ...(body !== undefined ? { body } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });

    const envelope = response.data ?? undefined;
    if (!response.ok || !envelope || envelope.success !== true) {
      throw mapError(response.status, envelope);
    }
    return envelope.data as T;
  }

  // -- AI generation ---------------------------------------------------------

  generateScore(
    req: GenerateScoreRequest,
    token: string,
    signal?: AbortSignal
  ): Promise<GenerateScoreResult> {
    return this.request<GenerateScoreResult>('/ai/generate', {
      method: 'POST',
      body: req,
      token,
      ...(signal ? { signal } : {}),
    });
  }

  regenerateRegion(
    req: RegenerateRegionRequest,
    token: string,
    signal?: AbortSignal
  ): Promise<RegenerateRegionResult> {
    return this.request<RegenerateRegionResult>('/ai/regenerate', {
      method: 'POST',
      body: req,
      token,
      ...(signal ? { signal } : {}),
    });
  }

  // -- Generation jobs -------------------------------------------------------

  /**
   * Starts a generation and returns as soon as the row exists — the work runs
   * on the server. Nothing here holds a connection open for the minutes a
   * generation takes, which is the entire point of the job model.
   */
  createJob(req: CreateGenerationJobRequest, token: string): Promise<GenerationJob> {
    return this.request<GenerationJob>('/jobs', { method: 'POST', body: req, token });
  }

  getJob(id: string, token: string): Promise<GenerationJob> {
    return this.request<GenerationJob>(`/jobs/${encodeURIComponent(id)}`, { token });
  }

  /** Releases the project. A job already in flight discards its result when it notices. */
  async cancelJob(id: string, token: string): Promise<void> {
    await this.request<{ ok: boolean }>(`/jobs/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      token,
    });
  }

  /**
   * Cancels by project rather than job — for the projects list, which has no
   * job id. A project can only have one running job, so this is unambiguous.
   */
  async cancelProjectGeneration(projectId: string, token: string): Promise<void> {
    await this.request<{ ok: boolean }>(
      `/projects/${encodeURIComponent(projectId)}/generation/cancel`,
      { method: 'POST', token }
    );
  }

  // -- Audio transcription ---------------------------------------------------

  /** Whether this deployment can transcribe audio at all. */
  async getTranscriptionCapability(token: string): Promise<{ available: boolean }> {
    return this.request<{ available: boolean }>('/projects/transcribe/capability', { token });
  }

  /**
   * Uploads a recording and returns the project it created.
   *
   * The project comes back immediately with `status: 'transcribing'` and an
   * empty score — transcription is minutes of model time on another service,
   * and the score arrives on a later read. Poll `getProjectStatus` until it
   * says `ready`.
   *
   * Multipart rather than raw bytes: the filename is the only thing the user
   * told us about the recording, and it becomes the project's name.
   */
  async transcribeAudio(
    file: File | Blob,
    filename: string,
    token: string
  ): Promise<ProjectSaveResult> {
    const form = new FormData();
    form.append('file', file, filename);
    return this.request<ProjectSaveResult>('/projects/transcribe', {
      method: 'POST',
      rawBody: form,
      token,
    });
  }

  // -- Projects --------------------------------------------------------------

  listProjects(token: string, query?: ProjectListQuery): Promise<ProjectSummary[]> {
    const params = new URLSearchParams();
    if (query?.search) params.set('search', query.search);
    if (query?.sort) params.set('sort', query.sort);
    const qs = params.toString();
    return this.request<ProjectSummary[]>(`/projects${qs ? `?${qs}` : ''}`, { token });
  }

  getProject(id: string, token: string): Promise<ProjectRecord> {
    return this.request<ProjectRecord>(`/projects/${encodeURIComponent(id)}`, { token });
  }

  /**
   * Just the status, for polling while a generation job runs — and for
   * `parentSnapshotId`, the one other field an open editor needs.
   *
   * `getProject` would ship the whole score every few seconds, and the score
   * cannot change while generating — writes are rejected — so that payload is
   * pure waste.
   */
  async getProjectStatus(id: string, token: string): Promise<ProjectStatusResult> {
    return this.request<ProjectStatusResult>(`/projects/${encodeURIComponent(id)}/status`, {
      token,
    });
  }


  /**
   * Creates a project. Returns metadata, not the score: the caller sent that
   * score a moment ago and still holds it, so echoing it back doubles the cost
   * of every create — and of every autosave, on `updateProject` below.
   */
  createProject(req: ProjectCreateRequest, token: string): Promise<ProjectSaveResult> {
    return this.request<ProjectSaveResult>('/projects', { method: 'POST', body: req, token });
  }

  updateProject(id: string, req: ProjectUpdateRequest, token: string): Promise<ProjectSaveResult> {
    return this.request<ProjectSaveResult>(`/projects/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: req,
      token,
    });
  }

  /**
   * Copies a project without its score crossing the wire in either direction.
   *
   * The client-side alternative — GET then POST — moved the whole score twice
   * for a copy nobody was going to look at.
   */
  duplicateProject(
    id: string,
    req: ProjectDuplicateRequest,
    token: string
  ): Promise<ProjectSaveResult> {
    return this.request<ProjectSaveResult>(`/projects/${encodeURIComponent(id)}/duplicate`, {
      method: 'POST',
      body: req,
      token,
    });
  }

  // -- Snapshots -------------------------------------------------------------

  listSnapshots(projectId: string, token: string): Promise<SnapshotSummary[]> {
    return this.request<SnapshotSummary[]>(
      `/projects/${encodeURIComponent(projectId)}/snapshots`,
      { token }
    );
  }

  /**
   * Pins the project's stored score as a new version.
   *
   * Returns a summary: the caller is looking at the very score it asked to
   * pin, so sending a second copy of it back is freight nobody unpacks.
   */
  createSnapshot(projectId: string, name: string, token: string): Promise<SnapshotSummary> {
    return this.request<SnapshotSummary>(`/projects/${encodeURIComponent(projectId)}/snapshots`, {
      method: 'POST',
      body: { name },
      token,
    });
  }

  getSnapshot(id: string, token: string): Promise<Snapshot> {
    return this.request<Snapshot>(`/snapshots/${encodeURIComponent(id)}`, { token });
  }

  /** Replaces the live project with this snapshot; returns the updated project. */
  openSnapshot(id: string, token: string): Promise<ProjectRecord> {
    return this.request<ProjectRecord>(`/snapshots/${encodeURIComponent(id)}/open`, {
      method: 'POST',
      token,
    });
  }

  /** Publishing changes who may read the score, never the score — so neither response carries one. */
  publishSnapshot(id: string, publisherName: string, token: string): Promise<SnapshotSummary> {
    return this.request<SnapshotSummary>(`/snapshots/${encodeURIComponent(id)}/publish`, {
      method: 'POST',
      body: { publisherName },
      token,
    });
  }

  unpublishSnapshot(id: string, token: string): Promise<SnapshotSummary> {
    return this.request<SnapshotSummary>(`/snapshots/${encodeURIComponent(id)}/unpublish`, {
      method: 'POST',
      token,
    });
  }

  lastPublisherName(token: string): Promise<{ publisherName: string | null }> {
    return this.request<{ publisherName: string | null }>('/snapshots/publisher-name', { token });
  }

  // -- Public (no token: a visitor has none) -----------------------------------

  getPublishedSnapshot(publicId: string): Promise<PublishedSnapshot> {
    return this.request<PublishedSnapshot>(`/public/snapshots/${encodeURIComponent(publicId)}`, {});
  }

  listCommunity(): Promise<CommunityItem[]> {
    return this.request<CommunityItem[]>('/public/community', {});
  }

  async deleteProject(id: string, token: string): Promise<void> {
    await this.request<{ deleted: boolean }>(`/projects/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      token,
    });
  }

  // -- Health ----------------------------------------------------------------

  async health(): Promise<boolean> {
    try {
      await this.request<{ status: string }>('/health');
      return true;
    } catch {
      return false;
    }
  }
}

function mapError(status: number, envelope: ApiResponse<unknown> | undefined): Error {
  const message = envelope?.error ?? `Request failed with status ${status}`;
  switch (envelope?.code) {
    case 'QUOTA_EXCEEDED':
      return new QuotaExceededError(message);
    case 'AI_OUTPUT_INVALID':
      return new AiOutputInvalidError(message);
    case 'AI_GENERATION_FAILED':
      return new AiGenerationError(message);
    case 'PROJECT_NOT_FOUND':
      return new ProjectNotFoundError(message);
    default:
      if (status === 429) return new QuotaExceededError(message);
      if (status === 404) return new ProjectNotFoundError(message);
      return new ApiError(message, status);
  }
}
