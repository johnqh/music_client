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
