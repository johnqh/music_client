# @sudobility/music_client

Typed network client + React Query hooks for the ScoreSmith music_api. SudojoClient pattern.

## Tech Stack

- TypeScript strict, ESM (source imports use `.js` specifiers; plain tsc build)
- `NetworkClient` DI from `@sudobility/types` — zero direct fetch anywhere
- Types/schemas from `@sudobility/music_types`; React Query ≥5 peer
- Bun scripts, vitest + jsdom (+ @testing-library/react renderHook)
- Published to npm as `@sudobility/music_client` (restricted) via CI on push to main

## Commands

`bun install` · `bun run verify` (typecheck+lint+test+build) · `bun run test`

## Architecture

- `src/network/music-client.ts` — `MusicClient(networkClient, baseUrl)`: one private `request<T>()` funnel; bearer token per call (never stored); envelope `{success,data,error,code}` unwrapping; typed-error mapping (429/QUOTA_EXCEEDED → `QuotaExceededError`, 502 AI codes → `AiOutputInvalidError`/`AiGenerationError`, 404 → `ProjectNotFoundError`, else `ApiError`)
- `src/hooks/` — `useProjects`/`useProject`/`useCreateProject`/`useUpdateProject`/`useDeleteProject`, `useGenerateScore`/`useRegenerateRegion`; every hook takes `{networkClient, baseUrl, token}` (`MusicHookContext`); queries disabled when token is null
- `src/hooks/query-keys.ts` — `musicQueryKeys` hierarchical factory; mutations invalidate through it
- Stale times: projects list 2min; project detail 0 (editor owns freshness)

## Gotchas

- music_lib's generation/project slices call `MusicClient` directly (their own abort/token discipline); the hooks exist for app-level views (dashboard)
- `Optional<T>` from @sudobility/types permits null — normalize `response.data ?? undefined`

## Related Projects

`music_types` · `music_api` · `music_lib` · `music_app`
