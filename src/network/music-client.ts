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
  ProjectListQuery,
  ProjectRecord,
  ProjectStatus,
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

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
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

    const response = await this.networkClient.request<ApiResponse<T>>(url, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
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
   * Just the status, for polling while a generation job runs.
   *
   * `getProject` would ship the whole score every few seconds, and the score
   * cannot change while generating — writes are rejected — so that payload is
   * pure waste.
   */
  async getProjectStatus(
    id: string,
    token: string
  ): Promise<{ status: ProjectStatus; updatedAt: string }> {
    return this.request<{ status: ProjectStatus; updatedAt: string }>(
      `/projects/${encodeURIComponent(id)}/status`,
      { token }
    );
  }

  createProject(req: ProjectCreateRequest, token: string): Promise<ProjectRecord> {
    return this.request<ProjectRecord>('/projects', { method: 'POST', body: req, token });
  }

  updateProject(id: string, req: ProjectUpdateRequest, token: string): Promise<ProjectRecord> {
    return this.request<ProjectRecord>(`/projects/${encodeURIComponent(id)}`, {
      method: 'PUT',
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

  createSnapshot(projectId: string, name: string, token: string): Promise<Snapshot> {
    return this.request<Snapshot>(`/projects/${encodeURIComponent(projectId)}/snapshots`, {
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

  publishSnapshot(id: string, publisherName: string, token: string): Promise<Snapshot> {
    return this.request<Snapshot>(`/snapshots/${encodeURIComponent(id)}/publish`, {
      method: 'POST',
      body: { publisherName },
      token,
    });
  }

  unpublishSnapshot(id: string, token: string): Promise<Snapshot> {
    return this.request<Snapshot>(`/snapshots/${encodeURIComponent(id)}/unpublish`, {
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
