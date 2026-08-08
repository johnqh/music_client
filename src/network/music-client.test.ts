/**
 * MusicClient tests against a fake NetworkClient: request shapes (URL,
 * method, headers, body), envelope unwrapping, and typed-error mapping.
 */
import { describe, expect, it } from 'vitest';
import type { NetworkClient, NetworkRequestOptions, NetworkResponse } from '@sudobility/types';
import type { ApiResponse } from '@sudobility/music_types';
import { MusicClient } from './music-client.js';
import {
  AiOutputInvalidError,
  ApiError,
  ProjectNotFoundError,
  QuotaExceededError,
} from '../errors.js';

type Recorded = { url: string; options: NetworkRequestOptions | undefined };

function fakeNetwork(
  body: ApiResponse<unknown>,
  status = 200
): { client: NetworkClient; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const respond = <T>(url: string, options?: NetworkRequestOptions): Promise<NetworkResponse<T>> => {
    calls.push({ url, options });
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      headers: {},
      data: body as T,
      success: body.success,
    } as NetworkResponse<T>);
  };
  const client: NetworkClient = {
    request: respond,
    get: (url, options) => respond(url, { ...options, method: 'GET' }),
    post: (url, _b, options) => respond(url, { ...options, method: 'POST' }),
    put: (url, _b, options) => respond(url, { ...options, method: 'PUT' }),
    delete: (url, options) => respond(url, { ...options, method: 'DELETE' }),
  };
  return { client, calls };
}

const BASE = 'http://localhost:8022';

describe('MusicClient request shapes', () => {
  it('lists projects with query params, bearer token, GET', async () => {
    const { client, calls } = fakeNetwork({ success: true, data: [] });
    const music = new MusicClient(client, BASE);
    await music.listProjects('tok-1', { search: 'so ng', sort: 'name' });
    expect(calls[0].url).toBe(`${BASE}/api/v1/projects?search=so+ng&sort=name`);
    expect(calls[0].options?.method).toBe('GET');
    expect(calls[0].options?.headers?.Authorization).toBe('Bearer tok-1');
  });

  it('creates a project via POST with a JSON body', async () => {
    const { client, calls } = fakeNetwork({ success: true, data: { id: 'p1' } });
    const music = new MusicClient(client, BASE);
    await music.createProject({ name: 'X', score: {} as never }, 'tok');
    expect(calls[0].url).toBe(`${BASE}/api/v1/projects`);
    expect(calls[0].options?.method).toBe('POST');
    expect(JSON.parse(calls[0].options?.body as string)).toEqual({ name: 'X', score: {} });
  });

  it('updates and deletes by encoded id', async () => {
    const { client, calls } = fakeNetwork({ success: true, data: { id: 'a/b' } });
    const music = new MusicClient(client, BASE);
    await music.updateProject('a/b', { name: 'Y' }, 'tok');
    await music.deleteProject('a/b', 'tok');
    expect(calls[0].url).toBe(`${BASE}/api/v1/projects/a%2Fb`);
    expect(calls[0].options?.method).toBe('PUT');
    expect(calls[1].options?.method).toBe('DELETE');
  });

  it('unwraps the envelope and returns data', async () => {
    const { client } = fakeNetwork({ success: true, data: { status: 'ok' } });
    const music = new MusicClient(client, BASE);
    await expect(music.health()).resolves.toBe(true);
  });

  it('generate/regenerate POST to the AI endpoints with the token', async () => {
    const { client, calls } = fakeNetwork({
      success: true,
      data: { score: {}, warnings: [] },
    });
    const music = new MusicClient(client, BASE);
    await music.generateScore({ prompt: 'x', durationMeasures: 1, tracks: [] }, 'tok-9');
    expect(calls[0].url).toBe(`${BASE}/api/v1/ai/generate`);
    expect(calls[0].options?.headers?.Authorization).toBe('Bearer tok-9');
  });
});

describe('MusicClient error mapping', () => {
  it('maps QUOTA_EXCEEDED to QuotaExceededError', async () => {
    const { client } = fakeNetwork(
      { success: false, error: 'limit', code: 'QUOTA_EXCEEDED' },
      429
    );
    await expect(
      new MusicClient(client, BASE).generateScore(
        { prompt: 'x', durationMeasures: 1, tracks: [] },
        't'
      )
    ).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it('maps AI_OUTPUT_INVALID to AiOutputInvalidError', async () => {
    const { client } = fakeNetwork(
      { success: false, error: 'bad model output', code: 'AI_OUTPUT_INVALID' },
      502
    );
    await expect(
      new MusicClient(client, BASE).generateScore(
        { prompt: 'x', durationMeasures: 1, tracks: [] },
        't'
      )
    ).rejects.toBeInstanceOf(AiOutputInvalidError);
  });

  it('maps PROJECT_NOT_FOUND (and bare 404s) to ProjectNotFoundError', async () => {
    const { client } = fakeNetwork(
      { success: false, error: 'nope', code: 'PROJECT_NOT_FOUND' },
      404
    );
    await expect(new MusicClient(client, BASE).getProject('x', 't')).rejects.toBeInstanceOf(
      ProjectNotFoundError
    );
    const bare = fakeNetwork({ success: false, error: 'gone' }, 404);
    await expect(new MusicClient(bare.client, BASE).getProject('x', 't')).rejects.toBeInstanceOf(
      ProjectNotFoundError
    );
  });

  it('falls back to ApiError with the HTTP status', async () => {
    const { client } = fakeNetwork({ success: false, error: 'boom' }, 500);
    const err = await new MusicClient(client, BASE).getProject('x', 't').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
    expect((err as ApiError).message).toBe('boom');
  });
});

describe('MusicClient publishing', () => {
  const headersOf = (calls: Recorded[]): Record<string, string> =>
    (calls[0].options?.headers as Record<string, string> | undefined) ?? {};

  it('reads a published snapshot without sending a token', async () => {
    // The whole point of the public routes: a visitor has no token to send.
    const { client, calls } = fakeNetwork({ success: true, data: {} });
    await new MusicClient(client, BASE).getPublishedSnapshot('pub_x');
    expect(calls[0].url).toBe(`${BASE}/api/v1/public/snapshots/pub_x`);
    expect(headersOf(calls).Authorization).toBeUndefined();
  });

  it('reads the community list without a token', async () => {
    const { client, calls } = fakeNetwork({ success: true, data: [] });
    await new MusicClient(client, BASE).listCommunity();
    expect(calls[0].url).toBe(`${BASE}/api/v1/public/community`);
    expect(headersOf(calls).Authorization).toBeUndefined();
  });

  it('publishes with a token', async () => {
    const { client, calls } = fakeNetwork({ success: true, data: {} });
    await new MusicClient(client, BASE).publishSnapshot('s1', 'Jane', 'tok');
    expect(calls[0].url).toBe(`${BASE}/api/v1/snapshots/s1/publish`);
    expect(headersOf(calls).Authorization).toBe('Bearer tok');
  });

  it('unpublishes with a token', async () => {
    const { client, calls } = fakeNetwork({ success: true, data: {} });
    await new MusicClient(client, BASE).unpublishSnapshot('s1', 'tok');
    expect(calls[0].url).toBe(`${BASE}/api/v1/snapshots/s1/unpublish`);
    expect(headersOf(calls).Authorization).toBe('Bearer tok');
  });
});

describe('MusicClient generation jobs', () => {
  const runningJob = () => ({
    id: 'j1',
    projectId: 'p1',
    kind: 'replace-notes',
    status: 'running',
    createdAt: '2026-08-07T00:00:00.000Z',
    finishedAt: null,
    error: null,
  });

  it('creates a job via POST with the whole request payload', async () => {
    const { client, calls } = fakeNetwork({ success: true, data: runningJob() });
    const music = new MusicClient(client, BASE);

    const job = await music.createJob(
      { projectId: 'p1', kind: 'replace-notes', request: { instruction: 'brighter' } },
      'tok'
    );

    expect(calls[0].url).toBe(`${BASE}/api/v1/jobs`);
    expect(calls[0].options?.method).toBe('POST');
    expect(calls[0].options?.headers?.Authorization).toBe('Bearer tok');
    expect(JSON.parse(calls[0].options?.body as string)).toEqual({
      projectId: 'p1',
      kind: 'replace-notes',
      request: { instruction: 'brighter' },
    });
    expect(job.status).toBe('running');
  });

  it('fetches a job by encoded id', async () => {
    const { client, calls } = fakeNetwork({ success: true, data: runningJob() });
    const music = new MusicClient(client, BASE);

    await music.getJob('a/b', 'tok');

    expect(calls[0].url).toBe(`${BASE}/api/v1/jobs/a%2Fb`);
    expect(calls[0].options?.method).toBe('GET');
  });

  it('cancels via POST to the cancel sub-route', async () => {
    const { client, calls } = fakeNetwork({ success: true, data: { ok: true } });
    const music = new MusicClient(client, BASE);

    await music.cancelJob('j1', 'tok');

    expect(calls[0].url).toBe(`${BASE}/api/v1/jobs/j1/cancel`);
    expect(calls[0].options?.method).toBe('POST');
    expect(calls[0].options?.headers?.Authorization).toBe('Bearer tok');
  });
});
