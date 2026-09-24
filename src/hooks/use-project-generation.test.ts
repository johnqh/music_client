/**
 * `useProjectGeneration` watches the *project*, not the job — see the
 * module's own header comment for why. These tests cover the one rule that
 * matters most: which project statuses count as "busy".
 */
import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ProjectStatusResult } from '@sudobility/music_types';
import {
  ALWAYS_FOREGROUND,
  useProjectGeneration,
  type GenerationClient,
  type GenerationStore,
} from './use-project-generation.js';

function client(status: Pick<ProjectStatusResult, 'status' | 'updatedAt'>): GenerationClient {
  return {
    createJob: vi.fn(),
    getJob: vi.fn(),
    cancelJob: vi.fn(),
    cancelProjectGeneration: vi.fn(),
    getProjectStatus: vi.fn().mockResolvedValue({
      lastGenerationError: null,
      parentSnapshotId: null,
      ...status,
    } satisfies ProjectStatusResult),
  } as unknown as GenerationClient;
}

function store(): GenerationStore {
  return { getState: () => ({}) };
}

describe('useProjectGeneration', () => {
  /**
   * The bug this pins: `POST /projects/transcribe` opens the editor before
   * the transcription has produced anything (the same shape as a generation
   * — see `music_app_rn`'s `DashboardScreen.transcribeAudio`), so the very
   * first poll after opening reports `transcribing`. A hook that only
   * recognised `generating` set `generating` to `false` on that first poll,
   * hid the "working" overlay, and left the reader looking at the
   * still-empty score as though the transcription had come back blank.
   */
  it('treats a transcribing project as busy, the same as a generating one', async () => {
    const { result } = renderHook(() =>
      useProjectGeneration('p1', {
        store: store(),
        client: client({ status: 'transcribing', updatedAt: 't1' }),
        getToken: async () => 'token',
        foreground: ALWAYS_FOREGROUND,
      })
    );

    await waitFor(() => expect(result.current.generating).toBe(true));
  });

  it('treats a generating project as busy', async () => {
    const { result } = renderHook(() =>
      useProjectGeneration('p1', {
        store: store(),
        client: client({ status: 'generating', updatedAt: 't1' }),
        getToken: async () => 'token',
        foreground: ALWAYS_FOREGROUND,
      })
    );

    await waitFor(() => expect(result.current.generating).toBe(true));
  });

  it('treats a ready project as not busy', async () => {
    const { result } = renderHook(() =>
      useProjectGeneration('p1', {
        store: store(),
        client: client({ status: 'ready', updatedAt: 't1' }),
        getToken: async () => 'token',
        foreground: ALWAYS_FOREGROUND,
      })
    );

    await waitFor(() => expect(result.current.generating).toBe(false));
  });
});
