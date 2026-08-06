/**
 * MusicClient — the single typed gateway to music_api (SudojoClient
 * pattern): constructed with an injected NetworkClient + baseUrl, all HTTP
 * through one private `request<T>()` funnel, bearer token passed per call
 * (never stored), envelope unwrapping and typed-error mapping in one place.
 */
import type { NetworkClient } from '@sudobility/types';
import type {
  ApiResponse,
  GenerateScoreRequest,
  GenerateScoreResult,
  ProjectCreateRequest,
  ProjectListQuery,
  ProjectRecord,
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
