/**
 * @sudobility/music_client — typed gateway + React Query hooks for music_api.
 */
export { MusicClient } from './network/music-client.js';
export {
  AiGenerationError,
  AiOutputInvalidError,
  ApiError,
  InsufficientCreditsError,
  ProjectNotFoundError,
  QuotaExceededError,
} from './errors.js';
export { musicQueryKeys } from './hooks/query-keys.js';
export {
  ALWAYS_FOREGROUND,
  GENERATION_IDLE_POLL_MS,
  GENERATION_POLL_MS,
  useProjectGeneration,
} from './hooks/use-project-generation.js';
export type {
  ForegroundPort,
  GenerationClient,
  GenerationStore,
  ProjectGeneration,
  UseProjectGenerationOptions,
} from './hooks/use-project-generation.js';
export {
  useCreateProject,
  useDeleteProject,
  useMusicClient,
  useProject,
  useProjects,
  type MusicHookContext,
} from './hooks/use-projects.js';
export {
  useCancelGenerationJob,
  useCreateGenerationJob,
  useGenerateScore,
  useGenerationJob,
  useRegenerateRegion,
} from './hooks/use-generation.js';
