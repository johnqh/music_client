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
  jobs: {
    all: ['music', 'jobs'] as const,
    detail: (id: string) => ['music', 'jobs', 'detail', id] as const,
  },
} as const;
