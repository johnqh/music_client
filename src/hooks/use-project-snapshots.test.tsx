/**
 * Snapshot history for an open project.
 *
 * Most of what is asserted here is about calls that must NOT happen, or must
 * happen in a particular order: the live score is flushed before a snapshot is
 * asked for (the server copies the stored row), and neither creating nor
 * opening one re-downloads the project (opening hands the score back in its
 * own response, and creating changes no music).
 */
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { SnapshotSummary } from '@sudobility/music_types';
import { LIVE_NODE_ID } from '@sudobility/music_types';
import { BASE_URL, fakeServer, newQueryClient, wrapperFor } from '../test/fake-server';
import {
  publishNamesProblem,
  suggestedPublicName,
  useProjectSnapshots,
} from './use-project-snapshots';

function snap(id: string, parentId: string | null, extra: Partial<SnapshotSummary> = {}): SnapshotSummary {
  return { id, projectId: 'p1', parentId, name: id, createdAt: `2026-01-0${id.length}T00:00:00Z`, ...extra };
}

function setup(options: { publisherName?: string | null; statusUpdatedAt?: string[] } = {}) {
  const snapshots: SnapshotSummary[] = [snap('v1', null)];
  let parentSnapshotId: string | null = 'v1';
  const stamps = [...(options.statusUpdatedAt ?? ['2026-02-01T00:00:00Z'])];
  const order: string[] = [];
  const server = fakeServer({
    'GET /projects/p1/snapshots': () => ({ data: [...snapshots] }),
    'GET /projects/p1/status': () => ({
      data: {
        status: 'ready',
        updatedAt: stamps.length > 1 ? stamps.shift() : stamps[0],
        lastGenerationError: null,
        parentSnapshotId,
      },
    }),
    'GET /snapshots/publisher-name': () => ({ data: { publisherName: options.publisherName ?? null } }),
    'POST /projects/p1/snapshots': (call) => {
      order.push('createSnapshot');
      const created = snap('v22', parentSnapshotId, { name: (call.body as { name: string }).name });
      snapshots.push(created);
      parentSnapshotId = created.id;
      return { data: created };
    },
    'POST /snapshots/v22/publish': (call) => {
      const body = call.body as { publisherName: string; publicName: string };
      const i = snapshots.findIndex((s) => s.id === 'v22');
      snapshots[i] = { ...snapshots[i]!, ...body, publicId: 'pub22' };
      return { data: snapshots[i] };
    },
    'POST /snapshots/v1/publish': (call) => {
      const body = call.body as { publisherName: string; publicName: string };
      snapshots[0] = { ...snapshots[0]!, ...body, publicId: snapshots[0]!.publicId ?? 'pub1' };
      return { data: snapshots[0] };
    },
    'POST /snapshots/v1/unpublish': () => {
      const { publicId: _p, publicName: _n, publisherName: _w, ...rest } = snapshots[0]!;
      snapshots[0] = rest;
      return { data: snapshots[0] };
    },
    'POST /snapshots/v1/open': () => {
      parentSnapshotId = 'v1';
      return {
        data: {
          id: 'p1',
          name: 'Song',
          createdAt: '',
          updatedAt: '2026-03-01T00:00:00Z',
          schemaVersion: 1,
          status: 'ready',
          lastGenerationError: null,
          parentSnapshotId: 'v1',
          score: { marker: 'from-v1' },
        },
      };
    },
  });
  const flush = vi.fn(async () => {
    order.push('flush');
  });
  const onAdopt = vi.fn();
  const noteServerVersion = vi.fn();
  const getToken = vi.fn(async () => 'tok');
  const ctx = { networkClient: server.networkClient, baseUrl: BASE_URL, getToken };
  const hook = renderHook(
    ({ projectId }: { projectId: string | null }) =>
      useProjectSnapshots(ctx, projectId, { flush, onAdopt, noteServerVersion }),
    { wrapper: wrapperFor(newQueryClient()), initialProps: { projectId: 'p1' as string | null } }
  );
  return { server, hook, flush, onAdopt, noteServerVersion, order, snapshots };
}

describe('suggestedPublicName', () => {
  it('is the project name then the snapshot name, joined by a space, blanks dropped', () => {
    expect(suggestedPublicName('Song', 'Version 2')).toBe('Song Version 2');
    expect(suggestedPublicName('  Song ', '  ')).toBe('Song');
    expect(suggestedPublicName('', 'Version 2')).toBe('Version 2');
  });
});

describe('publishNamesProblem', () => {
  it('refuses a blank publisher or a blank public title', () => {
    expect(publishNamesProblem({ publisherName: ' ', publicName: 'Song' })).toBe('publisherName');
    expect(publishNamesProblem({ publisherName: 'Ann', publicName: '  ' })).toBe('publicName');
    expect(publishNamesProblem({ publisherName: 'Ann', publicName: 'Song' })).toBeNull();
  });
});

describe('useProjectSnapshots', () => {
  it('loads the list, the tree with the live node, and the default publisher name', async () => {
    const { hook } = setup({ publisherName: 'Ann' });
    await waitFor(() => expect(hook.result.current.snapshots).not.toBeNull());
    await waitFor(() => expect(hook.result.current.defaultPublisherName).toBe('Ann'));

    const { snapshots, parentSnapshotId, nodes } = hook.result.current;
    expect(snapshots!.map((s) => s.id)).toEqual(['v1']);
    expect(parentSnapshotId).toBe('v1');
    expect(nodes.map((n) => n.id)).toEqual(['v1', LIVE_NODE_ID]);
    expect(nodes[1]!.parentId).toBe('v1');
  });

  it('asks nothing without a project', () => {
    const { server, hook } = setup();
    hook.rerender({ projectId: null });
    expect(hook.result.current.snapshots).toBeNull();
    // Only whatever the first render fired; nothing aimed at a null project.
    expect(server.calls.every((c) => !c.path.includes('null'))).toBe(true);
  });

  it('create flushes first, records where the server stands, and never re-reads the project', async () => {
    const { server, hook, order, noteServerVersion } = setup({
      statusUpdatedAt: ['2026-02-01T00:00:00Z', '2026-02-02T00:00:00Z'],
    });
    await waitFor(() => expect(hook.result.current.snapshots).not.toBeNull());

    let created: SnapshotSummary | null = null;
    await act(async () => {
      created = await hook.result.current.create({ name: '  Version 2 ' });
    });

    expect(created!.name).toBe('Version 2');
    expect(order).toEqual(['flush', 'createSnapshot']);
    expect(noteServerVersion).toHaveBeenCalledWith('2026-02-02T00:00:00Z');
    expect(server.log()).not.toContain('GET /projects/p1');
    await waitFor(() => expect(hook.result.current.snapshots!.map((s) => s.id)).toEqual(['v1', 'v22']));
    expect(hook.result.current.parentSnapshotId).toBe('v22');
  });

  it('create refuses a blank name before flushing or sending anything', async () => {
    const { server, hook, flush } = setup();
    await waitFor(() => expect(hook.result.current.snapshots).not.toBeNull());
    const before = server.calls.length;

    let created: unknown = 'untouched';
    await act(async () => {
      created = await hook.result.current.create({ name: '   ' });
    });
    expect(created).toBeNull();
    expect(flush).not.toHaveBeenCalled();
    expect(server.calls).toHaveLength(before);
  });

  it('create with publish publishes in the same step, trimmed', async () => {
    const { server, hook } = setup();
    await waitFor(() => expect(hook.result.current.snapshots).not.toBeNull());

    await act(async () => {
      await hook.result.current.create({
        name: 'Version 2',
        publish: { publisherName: ' Ann ', publicName: ' Song Version 2 ' },
      });
    });
    const publish = server.calls.find((c) => c.path === '/snapshots/v22/publish')!;
    expect(publish.body).toEqual({ publisherName: 'Ann', publicName: 'Song Version 2' });
    await waitFor(() => expect(hook.result.current.published.map((s) => s.id)).toEqual(['v22']));
  });

  it('create with a blank public title is refused whole — no half-made snapshot', async () => {
    const { server, hook, flush } = setup();
    await waitFor(() => expect(hook.result.current.snapshots).not.toBeNull());
    const before = server.calls.length;

    let created: unknown = 'untouched';
    await act(async () => {
      created = await hook.result.current.create({
        name: 'Version 2',
        publish: { publisherName: 'Ann', publicName: '  ' },
      });
    });
    expect(created).toBeNull();
    expect(flush).not.toHaveBeenCalled();
    expect(server.calls).toHaveLength(before);
  });

  it('rename republishes with the publisher kept, and refuses a blank title', async () => {
    const { server, hook } = setup();
    await waitFor(() => expect(hook.result.current.snapshots).not.toBeNull());
    await act(async () => {
      await hook.result.current.publish('v1', { publisherName: 'Ann', publicName: 'Song' });
    });

    await act(async () => {
      await hook.result.current.rename('v1', '  Nocturne ');
    });
    const publishes = server.calls.filter((c) => c.path === '/snapshots/v1/publish');
    expect(publishes[publishes.length - 1]!.body).toEqual({ publisherName: 'Ann', publicName: 'Nocturne' });

    const count = server.calls.length;
    let renamed: unknown = 'untouched';
    await act(async () => {
      renamed = await hook.result.current.rename('v1', '   ');
    });
    expect(renamed).toBeNull();
    expect(server.calls).toHaveLength(count);
  });

  it('unpublish withdraws and refreshes', async () => {
    const { server, hook } = setup();
    await waitFor(() => expect(hook.result.current.snapshots).not.toBeNull());
    await act(async () => {
      await hook.result.current.publish('v1', { publisherName: 'Ann', publicName: 'Song' });
    });
    await waitFor(() => expect(hook.result.current.published).toHaveLength(1));

    await act(async () => {
      await hook.result.current.unpublish('v1');
    });
    expect(server.log()).toContain('POST /snapshots/v1/unpublish');
    await waitFor(() => expect(hook.result.current.published).toHaveLength(0));
  });

  it('open adopts the score from the response and notes the server version, with no reload', async () => {
    const { server, hook, onAdopt, noteServerVersion } = setup();
    await waitFor(() => expect(hook.result.current.snapshots).not.toBeNull());

    await act(async () => {
      await hook.result.current.open('v1');
    });
    expect(onAdopt).toHaveBeenCalledTimes(1);
    expect(onAdopt.mock.calls[0]![0]).toEqual({ marker: 'from-v1' });
    expect(noteServerVersion).toHaveBeenCalledWith('2026-03-01T00:00:00Z');
    // Adopted before the version is noted, so the poll never sees the stamp
    // without the score that goes with it.
    expect(onAdopt.mock.invocationCallOrder[0]!).toBeLessThan(noteServerVersion.mock.invocationCallOrder[0]!);
    expect(server.log()).not.toContain('GET /projects/p1');
  });

  it('a write with no token rejects without sending', async () => {
    const { server, hook } = setup();
    await waitFor(() => expect(hook.result.current.snapshots).not.toBeNull());
    const before = server.calls.length;
    const ctx = {
      networkClient: server.networkClient,
      baseUrl: BASE_URL,
      getToken: async () => null,
    };
    const signedOut = renderHook(() => useProjectSnapshots(ctx, 'p1', { onAdopt: vi.fn() }), {
      wrapper: wrapperFor(newQueryClient()),
    });
    await expect(signedOut.result.current.open('v1')).rejects.toThrow();
    expect(server.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect(server.calls.length).toBeGreaterThanOrEqual(before);
  });
});
