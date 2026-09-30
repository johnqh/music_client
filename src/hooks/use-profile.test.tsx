import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { UserProfile } from '@sudobility/music_types';
import { BASE_URL, fakeServer, newQueryClient, wrapperFor, type FakeRoute } from '../test/fake-server';
import { musicQueryKeys } from './query-keys';
import { useDeleteAvatar, useProfile, useUpdateProfile, useUploadAvatar } from './use-profile';

const USER = 'u1';

function setup(routes: Record<string, FakeRoute>) {
  const server = fakeServer(routes);
  const queryClient = newQueryClient();
  const ctx = {
    networkClient: server.networkClient,
    baseUrl: BASE_URL,
    getToken: async () => 'tok',
    userId: USER,
  };
  // A cached publisher name, so there is something for a write to invalidate.
  queryClient.setQueryData(musicQueryKeys.snapshots.publisherName(USER), { publisherName: 'Old' });
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  return { server, queryClient, ctx, invalidate, wrapper: wrapperFor(queryClient) };
}

function publisherNameIsStale(queryClient: ReturnType<typeof newQueryClient>): boolean {
  return (
    queryClient.getQueryState(musicQueryKeys.snapshots.publisherName(USER))?.isInvalidated === true
  );
}

describe('useProfile', () => {
  it('answers what /me/profile says', async () => {
    const profile: UserProfile = { nickname: 'Ann', avatarId: 'a1' };
    const { server, ctx, wrapper } = setup({ 'GET /me/profile': () => ({ data: profile }) });
    const { result } = renderHook(() => useProfile(ctx), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual(profile));
    expect(server.calls[0]!.authorization).toBe('Bearer tok');
  });

  it('asks nothing with no server or nobody signed in', () => {
    const { server, ctx, wrapper } = setup({ 'GET /me/profile': () => ({ data: {} }) });
    renderHook(() => useProfile(null), { wrapper });
    renderHook(() => useProfile({ ...ctx, getToken: async () => null, userId: null }), { wrapper });
    expect(server.calls).toHaveLength(0);
  });
});

describe('profile writes', () => {
  it('updating the nickname caches the answer and invalidates the publisher name', async () => {
    const saved: UserProfile = { nickname: 'Ann', avatarId: null };
    const { server, queryClient, ctx, invalidate, wrapper } = setup({
      'PUT /me/profile': () => ({ data: saved }),
    });
    const { result } = renderHook(() => useUpdateProfile(ctx), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ nickname: 'Ann' });
    });

    expect(server.log()).toEqual(['PUT /me/profile']);
    expect(server.calls[0]!.body).toEqual({ nickname: 'Ann' });
    expect(queryClient.getQueryData(musicQueryKeys.profile(USER))).toEqual(saved);
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: musicQueryKeys.snapshots.publisherName(USER),
    });
    expect(publisherNameIsStale(queryClient)).toBe(true);
  });

  it('uploading a picture sends it under `file`, caches the answer and invalidates', async () => {
    const saved: UserProfile = { nickname: null, avatarId: 'a1' };
    const { server, queryClient, ctx, wrapper } = setup({
      'POST /me/avatar': () => ({ data: saved }),
    });
    const { result } = renderHook(() => useUploadAvatar(ctx), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ file: new Blob(['x'], { type: 'image/png' }), filename: 'me.png' });
    });

    const form = server.calls[0]!.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect((form.get('file') as File).name).toBe('me.png');
    expect(queryClient.getQueryData(musicQueryKeys.profile(USER))).toEqual(saved);
    expect(publisherNameIsStale(queryClient)).toBe(true);
  });

  it('deleting the picture caches the answer and invalidates', async () => {
    const saved: UserProfile = { nickname: 'Ann', avatarId: null };
    const { server, queryClient, ctx, wrapper } = setup({
      'DELETE /me/avatar': () => ({ data: saved }),
    });
    queryClient.setQueryData(musicQueryKeys.profile(USER), { nickname: 'Ann', avatarId: 'a1' });
    const { result } = renderHook(() => useDeleteAvatar(ctx), { wrapper });

    await act(async () => {
      await result.current.mutateAsync();
    });

    expect(server.log()).toEqual(['DELETE /me/avatar']);
    expect(queryClient.getQueryData(musicQueryKeys.profile(USER))).toEqual(saved);
    expect(publisherNameIsStale(queryClient)).toBe(true);
  });

  it('a refused write leaves the cache and the publisher name alone', async () => {
    const { queryClient, ctx, invalidate, wrapper } = setup({
      'PUT /me/profile': () => ({ status: 400, error: 'bad' }),
    });
    const { result } = renderHook(() => useUpdateProfile(ctx), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ nickname: 'Ann' }).catch(() => undefined);
    });

    expect(queryClient.getQueryData(musicQueryKeys.profile(USER))).toBeUndefined();
    expect(invalidate).not.toHaveBeenCalled();
    expect(publisherNameIsStale(queryClient)).toBe(false);
  });
});
