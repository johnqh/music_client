/**
 * @sudobility/music_client — typed gateway + React Query hooks for music_api.
 */
export { MusicClient } from './network/music-client.js';
export {
  AiGenerationError,
  AiOutputInvalidError,
  ApiError,
  ProjectNotFoundError,
  QuotaExceededError,
} from './errors.js';
export { musicQueryKeys } from './hooks/query-keys.js';
export {
  useCreateProject,
  useDeleteProject,
  useMusicClient,
  useProject,
  useProjects,
  type MusicHookContext,
} from './hooks/use-projects.js';
export { useGenerateScore, useRegenerateRegion } from './hooks/use-generation.js';
