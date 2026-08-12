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

- **Reads return the score; writes return metadata about it.** `createProject`/`updateProject` resolve to `ProjectSaveResult` and the snapshot writes to `SnapshotSummary` — none carries a `score`. The caller sent that score a moment ago and still holds it, so echoing it back doubled the cost of every create and every autosave. `useUpdateProject` therefore *patches* the cached detail entry (keeping the score from the request, or the one already cached) rather than writing the response into it, which would replace a cached project with a score-less one.
- **`request()` gzips bodies over 1KB** and sets `Content-Encoding`. A browser gzips responses it *receives* automatically and bodies it *sends* never, so uploading a score — what an autosave does every debounce window — was the one leg still paying full price. Gated on `CompressionStream` (absent on React Native's engine) and falling back to the plain string on any failure: never fail a save over an optimisation. Compression goes through `new Response(json).body`, **not** `Blob.stream()` — jsdom has no `Blob.stream`, so the Blob route degrades silently in exactly the environment the tests run in, and the feature would never have been exercised.
- `duplicateProject` exists so a copy never crosses the wire; `getProjectStatus` carries `parentSnapshotId` so nothing fetches a whole project to read one id.
- music_lib's generation/project slices call `MusicClient` directly (their own abort/token discipline); the hooks exist for app-level views (dashboard)
- `Optional<T>` from @sudobility/types permits null — normalize `response.data ?? undefined`
- **A guard test enforces that this package runs on React Native** (`src/platform-free.test.ts`): no web-only global, no `import.meta`, and `CompressionStream` still gated behind a `typeof` check. `tsconfig.json` sets `lib: [..., "DOM"]` and `eslint.config.js` spreads `globals.browser` — both genuinely needed, since `fetch`/`Blob`/`File`/`FormData`/`AbortSignal`/`URLSearchParams` are declared in `lib.dom.d.ts` but implemented on React Native too. The cost is that neither the compiler nor the linter would ever object to `document.querySelector` here, and every test runs in jsdom where it would work fine. The guard is what objects. It greps raw source with comments stripped, so reword a doc comment rather than weakening a rule.

## Related Projects

`music_types` · `music_api` · `music_lib` · `music_app`
