/**
 * Makes a server project from a New Project submission.
 *
 * Both apps offer New Project with "Generate for me", and a generation job
 * writes its result back to a project row — so a generated piece always starts
 * as a server project, whichever screen asked for it. The web dashboard and the
 * native dashboard (and its macOS File menu) each carried a copy of these rules;
 * this is the one copy.
 *
 * The project is created **up front** rather than on completion, so it appears
 * in a list with its badge from the first second instead of materialising
 * minutes later — and with a placeholder score shaped like the request, so the
 * editor can open it meaningfully mid-generation.
 */
import {
  emptyScoreForRequest,
  withGenerationVariant,
  type NewProjectSubmission,
  type ProjectSaveResult,
} from '@sudobility/music_types';
import type { MusicClient } from '../network/music-client';

/** The three calls this makes, so a test can stub them. */
export type GeneratedProjectClient = Pick<MusicClient, 'createProject' | 'createJob' | 'deleteProject'>;

/**
 * The name a generated project gets when its request has no title.
 *
 * Not the prompt: prompts routinely begin "Create a ...", which makes a project
 * list of near-identical names that also collide with the page's own Create
 * button. English because it is stored data — the server's row name — rather
 * than a label; a host that wants a translated fallback puts it in `title`.
 */
export const GENERATED_PROJECT_FALLBACK_NAME = 'Generated score';

export type CreateGeneratedProjectOptions = {
  /**
   * The generation backend to use when the request names none — typically a
   * developer setting. A request that already carries a variant keeps it,
   * because choosing per generation is what the dialog's own picker is for.
   * `'default'` sends no field at all (see `withGenerationVariant`).
   */
  variant?: string;
};

/**
 * Creates the project and, for a generation, starts its job.
 *
 * Resolves as soon as the job is *recorded*, not when the music is ready.
 *
 * If the job is refused — out of credits, over quota, another job already
 * queued — the project it was made to hold is **deleted again** and the
 * refusal rethrown unchanged (so `classifyGenerationError` still sees an
 * `InsufficientCreditsError`). Without that, a user with no credits collects an
 * empty "Generated score" row on every attempt. The delete is best effort: if
 * it fails too, the refusal is still what the caller hears about.
 */
export async function createGeneratedProject(
  client: GeneratedProjectClient,
  token: string,
  submission: NewProjectSubmission,
  options: CreateGeneratedProjectOptions = {}
): Promise<ProjectSaveResult> {
  if (submission.kind === 'blank') {
    return client.createProject({ name: submission.title, score: submission.score }, token);
  }

  const request = submission.request.variant
    ? submission.request
    : withGenerationVariant(submission.request, options.variant);

  const project = await client.createProject(
    {
      name: request.title?.trim() || GENERATED_PROJECT_FALLBACK_NAME,
      score: emptyScoreForRequest(request),
    },
    token
  );
  try {
    await client.createJob({ projectId: project.id, kind: 'generate-score', request }, token);
  } catch (jobError) {
    await client.deleteProject(project.id, token).catch(() => {
      // Best effort: the refusal is what the user needs to hear about.
    });
    throw jobError;
  }
  return project;
}
