# @sudobility/music_client

> **Git policy — never auto-commit or auto-push.** Leave your work in the working tree.
> Run `git commit`, `git push`, `gh pr create`, or `scripts/push_all.sh` **only when the user
> explicitly asks in that turn**. Approval for an earlier change does not carry forward, and
> finishing a task is not permission to commit it.

Typed network client + React Query hooks for the Moosiac music_api. SudojoClient pattern.

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
- `src/hooks/` — `useProjects` (optional `pollWhileGenerating`)/`useProject`/`useCreateProject`/`useUpdateProject`/`useDeleteProject`/`useDuplicateProject`/`useCancelProjectGeneration`, `useGenerateScore`/`useRegenerateRegion`, `useSiteAdmin`, `useTranscriptionCapability`, `useProjectSnapshots`; every hook takes a `MusicHookContext` (`hook-context.ts`)
- `src/projects/create-generated-project.ts` — `createGeneratedProject`: create the project, start the job, delete the project if the job is refused. The one copy of what both dashboards did
- `src/test/fake-server.tsx` — routed fake of music_api for hook tests (excluded from the build)
- `src/hooks/query-keys.ts` — `musicQueryKeys` hierarchical factory; mutations invalidate through it
- Stale times: projects list 2min; project detail 0 (editor owns freshness)

## Gotchas

- **Reads return the score; writes return metadata about it.** `createProject`/`updateProject` resolve to `ProjectSaveResult` and the snapshot writes to `SnapshotSummary` — none carries a `score`. The caller sent that score a moment ago and still holds it, so echoing it back doubled the cost of every create and every autosave. `useUpdateProject` therefore *patches* the cached detail entry (keeping the score from the request, or the one already cached) rather than writing the response into it, which would replace a cached project with a score-less one.
- **`request()` gzips bodies over 1KB** and sets `Content-Encoding`. A browser gzips responses it *receives* automatically and bodies it *sends* never, so uploading a score — what an autosave does every debounce window — was the one leg still paying full price. Gated on `CompressionStream` (absent on React Native's engine) and falling back to the plain string on any failure: never fail a save over an optimisation. Compression goes through `new Response(json).body`, **not** `Blob.stream()` — jsdom has no `Blob.stream`, so the Blob route degrades silently in exactly the environment the tests run in, and the feature would never have been exercised.
- `duplicateProject` exists so a copy never crosses the wire; `getProjectStatus` carries `parentSnapshotId` so nothing fetches a whole project to read one id.
- music_lib's generation/project slices call `MusicClient` directly (their own abort/token discipline); the hooks exist for app-level views (dashboard)
- `Optional<T>` from @sudobility/types permits null — normalize `response.data ?? undefined`
- **A guard test enforces that this package runs on React Native** (`src/platform-free.test.ts`): no web-only global, no `import.meta`, and `CompressionStream` still gated behind a `typeof` check. `tsconfig.json` sets `lib: [..., "DOM"]` and `eslint.config.js` spreads `globals.browser` — both genuinely needed, since `fetch`/`Blob`/`File`/`FormData`/`AbortSignal`/`URLSearchParams` are declared in `lib.dom.d.ts` but implemented on React Native too. The cost is that neither the compiler nor the linter would ever object to `document.querySelector` here, and every test runs in jsdom where it would work fine. The guard is what objects. It greps raw source with comments stripped, so reword a doc comment rather than weakening a rule.

- **`useScorePresets` takes a nullable context and is not gated on a token.** Every other query here is gated on `ctx.token`; this one must not be, because the route is public and gating it would leave the menu empty until Firebase restored the session. `null` means there is no server at all — the native app opens local documents with no `MusicClient` — and the query simply does not run rather than failing on every mount. `staleTime` is `Infinity`: the list changes when the server is deployed, and a reader who has the dialog open through a deploy is not the case worth a refetch loop.
- **`getScorePresets` validates rather than trusts.** The host renders these by looking each id up in its own copy, so an id it has never heard of prints as its own name in a menu. An unrecognisable body answers an empty list, which is what the menu hides itself on.

- **The hook context resolves its token per request.** `MusicHookContext.getToken` is awaited at the moment each request is sent (`requireHookToken`), because a token captured into the context goes stale an hour into a session and one read at start-up is null until Firebase restores the session. `userId` (`null` = signed out) is what gates queries synchronously and keys per-account caches — `useSiteAdmin` is keyed by it so one account's `true` is never shown for the next. The old captured `token` field still works when `getToken` is absent, and is deprecated.
- **`useProjectSnapshots` never re-downloads the project.** Create flushes (host's `flush`), creates, re-reads list+status and hands `status.updatedAt` to `noteServerVersion`; open takes the score from `openSnapshot`'s own response to `onAdopt`, then notes `project.updatedAt`. Blank names are refused before anything is sent, including a publish-on-create — no snapshot is made if its publish would be refused. `rename` reads the cache rather than the render, so a rename straight after a publish sees it.
- **`isInsufficientCredits` checks the error's name as well as its class.** Two copies of this package in one bundle make `instanceof` false for the other copy's error, and the paywall silently becomes a toast.

## Related Projects

`music_types` · `music_api` · `music_lib` · `music_app`

## Git Workflow

- Do not use feature branches for code changes. Always stay on the current branch.
