# @sudobility/music_client

Typed client and React Query hooks for the Moosiac API: AI score generation and project persistence.

## Installation

```bash
bun add @sudobility/music_client @sudobility/music_types
```

Peers: `@sudobility/types`, `@tanstack/react-query ≥5`, `react ≥18`.

## Usage

```ts
import { MusicClient, useProjects } from '@sudobility/music_client';

const client = new MusicClient(networkClient, 'http://localhost:8022');
const result = await client.generateScore(request, idToken);

// React:
const projects = useProjects({ networkClient, baseUrl, token });
```

Errors are typed: `QuotaExceededError`, `AiOutputInvalidError`, `AiGenerationError`, `ProjectNotFoundError`, `ApiError`.

## Development

```bash
bun install && bun run verify
```

## License

BUSL-1.1
