/**
 * @sudobility/music_client — typed gateway + React Query hooks for music_api.
 */
export { MusicClient } from './network/music-client';
export type {
  NativeUploadFile,
  UploadableFile,
} from './network/music-client';
export {
  AiGenerationError,
  AiOutputInvalidError,
  ApiError,
  InsufficientCreditsError,
  ProjectNotFoundError,
  QuotaExceededError,
  classifyGenerationError,
  isInsufficientCredits,
} from './errors';
export {
  hookAuthEnabled,
  requireHookToken,
  resolveHookToken,
  type MusicHookContext,
} from './hooks/hook-context';
export {
  GENERATED_PROJECT_FALLBACK_NAME,
  createGeneratedProject,
} from './projects/create-generated-project';
export type {
  CreateGeneratedProjectOptions,
  GeneratedProjectClient,
} from './projects/create-generated-project';
export { musicQueryKeys } from './hooks/query-keys';
export {
  ALWAYS_FOREGROUND,
  GENERATION_IDLE_POLL_MS,
  GENERATION_POLL_MS,
  LIVE_COALESCE_MS,
  useProjectGeneration,
} from './hooks/use-project-generation';
export type {
  ForegroundPort,
  GenerationClient,
  GenerationStore,
  LiveGenerationFinal,
  LiveGenerationOptions,
  LiveScoreMeta,
  LiveStatus,
  ProjectGeneration,
  UseProjectGenerationOptions,
} from './hooks/use-project-generation';
export {
  LIVE_RECONNECT_DEFAULTS,
  defaultWebSocketFactory,
  liveGenerationUrl,
  openLiveGeneration,
} from './network/live-generation-socket';
export type {
  LiveGenerationSocket,
  LiveSocketCloseReason,
  LiveSocketLike,
  LiveSocketStatus,
  OpenLiveGenerationOptions,
  ReconnectPolicy,
  WebSocketFactory,
} from './network/live-generation-socket';
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
} from './hooks/use-projects';
export { useSiteAdmin } from './hooks/use-site-admin';
export {
  useTranscriptionCapability,
  type TranscriptionCapability,
} from './hooks/use-transcription-capability';
export {
  publishNamesProblem,
  suggestedPublicName,
  useProjectSnapshots,
  type ProjectSnapshots,
  type ProjectSnapshotsCallbacks,
} from './hooks/use-project-snapshots';
export {
  useCancelGenerationJob,
  useCreateGenerationJob,
  useGenerateScore,
  useGenerationJob,
  useProjectJobs,
  useRegenerateRegion,
} from './hooks/use-generation';
export { useScorePresets } from './hooks/use-presets';
export { useScoreStyleSettings } from './hooks/use-style-settings';
