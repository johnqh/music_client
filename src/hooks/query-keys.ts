/**
 * Hierarchical query-key factory (sudojo_client pattern) — every hook and
 * invalidation goes through these so targeted invalidation stays possible.
 */
import type { ProjectListQuery } from '@sudobility/music_types';

export const musicQueryKeys = {
  all: ['music'] as const,
  projects: {
    all: ['music', 'projects'] as const,
    list: (query?: ProjectListQuery) => ['music', 'projects', 'list', query ?? {}] as const,
    detail: (id: string) => ['music', 'projects', 'detail', id] as const,
  },
  presets: {
    all: ['music', 'presets'] as const,
    // Keyed by style, because that is what the answer depends on — and by ''
    // for "no style", since a key holding `undefined` is not a stable key.
    forStyle: (style?: string) => ['music', 'presets', style ?? ''] as const,
  },
  snapshots: {
    all: ['music', 'snapshots'] as const,
    /** A project's snapshot list together with where the live work hangs off it. */
    forProject: (projectId: string) => ['music', 'snapshots', 'project', projectId] as const,
    /** The name this account last published under — per account, not per project. */
    publisherName: (userId?: string | null) => ['music', 'snapshots', 'publisher-name', userId ?? ''] as const,
  },
  /**
   * Per account: keyed by user id so one account's answer is never read back
   * for the next one signed in on the same device.
   */
  me: (userId?: string | null) => ['music', 'me', userId ?? ''] as const,
  transcription: {
    capability: ['music', 'transcription', 'capability'] as const,
  },
  jobs: {
    all: ['music', 'jobs'] as const,
    detail: (id: string) => ['music', 'jobs', 'detail', id] as const,
  },
} as const;
