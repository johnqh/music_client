import { describe, expect, it, vi } from 'vitest';
import type { GenerateScoreRequest, Score } from '@sudobility/music_types';
import { InsufficientCreditsError } from '../errors';
import {
  GENERATED_PROJECT_FALLBACK_NAME,
  createGeneratedProject,
  type GeneratedProjectClient,
} from './create-generated-project';

const request: GenerateScoreRequest = {
  prompt: 'A waltz',
  durationMeasures: 8,
  tracks: [{ name: 'Piano', instrumentName: 'Acoustic Grand Piano', midiProgram: 0, clef: 'treble' }],
};

function fakeClient(overrides: Partial<GeneratedProjectClient> = {}) {
  const saved = { id: 'p1', name: 'x', createdAt: '', updatedAt: '', schemaVersion: 1 };
  return {
    createProject: vi.fn().mockResolvedValue(saved),
    createJob: vi.fn().mockResolvedValue({ id: 'j1' }),
    deleteProject: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as GeneratedProjectClient & {
    createProject: ReturnType<typeof vi.fn>;
    createJob: ReturnType<typeof vi.fn>;
    deleteProject: ReturnType<typeof vi.fn>;
  };
}

describe('createGeneratedProject', () => {
  it('creates the project, then starts a generate-score job against it', async () => {
    const client = fakeClient();
    const project = await createGeneratedProject(client, 'tok', { kind: 'generate', request });

    expect(project.id).toBe('p1');
    expect(client.createProject).toHaveBeenCalledTimes(1);
    const [createReq, token] = client.createProject.mock.calls[0] as [{ score: Score }, string];
    expect(token).toBe('tok');
    // Placeholder score shaped like the request, so the editor can open it mid-job.
    expect((createReq.score as Score).tracks).toHaveLength(1);
    expect(client.createJob).toHaveBeenCalledWith(
      { projectId: 'p1', kind: 'generate-score', request },
      'tok'
    );
    expect(client.deleteProject).not.toHaveBeenCalled();
  });

  it('names the project from the title, else the fallback — never the prompt', async () => {
    const client = fakeClient();
    await createGeneratedProject(client, 'tok', {
      kind: 'generate',
      request: { ...request, title: '  Moonlight  ' },
    });
    await createGeneratedProject(client, 'tok', {
      kind: 'generate',
      request: { ...request, title: '   ' },
    });
    await createGeneratedProject(client, 'tok', { kind: 'generate', request });

    expect(client.createProject.mock.calls.map((c) => c[0].name)).toEqual([
      'Moonlight',
      GENERATED_PROJECT_FALLBACK_NAME,
      GENERATED_PROJECT_FALLBACK_NAME,
    ]);
    expect(GENERATED_PROJECT_FALLBACK_NAME).toBe('Generated score');
  });

  it('deletes the project it made when the job is refused, and rethrows the refusal', async () => {
    const refusal = new InsufficientCreditsError();
    const client = fakeClient({ createJob: vi.fn().mockRejectedValue(refusal) });

    await expect(
      createGeneratedProject(client, 'tok', { kind: 'generate', request })
    ).rejects.toBe(refusal);
    expect(client.deleteProject).toHaveBeenCalledWith('p1', 'tok');
  });

  it('still reports the refusal when the clean-up delete fails too', async () => {
    const refusal = new InsufficientCreditsError();
    const client = fakeClient({
      createJob: vi.fn().mockRejectedValue(refusal),
      deleteProject: vi.fn().mockRejectedValue(new Error('offline')),
    });

    await expect(
      createGeneratedProject(client, 'tok', { kind: 'generate', request })
    ).rejects.toBe(refusal);
  });

  it('applies a variant only when the request names none, and never "default"', async () => {
    const client = fakeClient();
    await createGeneratedProject(client, 'tok', { kind: 'generate', request }, { variant: 'local' });
    await createGeneratedProject(
      client,
      'tok',
      { kind: 'generate', request: { ...request, variant: 'deepseek' } },
      { variant: 'local' }
    );
    await createGeneratedProject(client, 'tok', { kind: 'generate', request }, { variant: 'default' });

    const sent = client.createJob.mock.calls.map((c) => c[0].request.variant);
    expect(sent).toEqual(['local', 'deepseek', undefined]);
  });

  it('creates a blank project with no job', async () => {
    const client = fakeClient();
    const score = { tracks: [] } as unknown as Score;
    await createGeneratedProject(client, 'tok', { kind: 'blank', title: 'Etude', score });

    expect(client.createProject).toHaveBeenCalledWith({ name: 'Etude', score }, 'tok');
    expect(client.createJob).not.toHaveBeenCalled();
  });
});
