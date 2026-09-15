/**
 * @sudobility/music_client — typed gateway + React Query hooks for music_api.
 */
export { MusicClient } from './network/music-client.js';
export type {
  NativeUploadFile,
  UploadableFile,
} from './network/music-client.js';
export {
  AiGenerationError,
  AiOutputInvalidError,
  ApiError,
  InsufficientCreditsError,
  ProjectNotFoundError,
  QuotaExceededError,
  classifyGenerationError,
  isInsufficientCredits,
} from './errors.js';
export type { GenerationErrorKind } from './errors.js';
export {
  hookAuthEnabled,
  requireHookToken,
  resolveHookToken,
  type MusicHookContext,
} from './hooks/hook-context.js';
export {
  GENERATED_PROJECT_FALLBACK_NAME,
  createGeneratedProject,
} from './projects/create-generated-project.js';
export type {
  CreateGeneratedProjectOptions,
  GeneratedProjectClient,
  GeneratedProjectSubmission,
} from './projects/create-generated-project.js';
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
  hasProjectsInFlight,
  useCancelProjectGeneration,
  useCreateProject,
  useDeleteProject,
  useDuplicateProject,
  useMusicClient,
  useProject,
  useProjects,
  useUpdateProject,
  type UseProjectsOptions,
} from './hooks/use-projects.js';
export { useSiteAdmin } from './hooks/use-site-admin.js';
export {
  useTranscriptionCapability,
  type TranscriptionCapability,
} from './hooks/use-transcription-capability.js';
export {
  publishNamesProblem,
  suggestedPublicName,
  useProjectSnapshots,
  type ProjectSnapshots,
  type ProjectSnapshotsCallbacks,
  type PublishNames,
} from './hooks/use-project-snapshots.js';
export {
  useCancelGenerationJob,
  useCreateGenerationJob,
  useGenerateScore,
  useGenerationJob,
  useRegenerateRegion,
} from './hooks/use-generation.js';
export { useScorePresets } from './hooks/use-presets.js';
