/**
 * Typed errors mapped from music_api's envelope codes / HTTP statuses so UI
 * layers can branch on error class instead of parsing messages.
 */

export class QuotaExceededError extends Error {
  constructor(message = 'Daily AI generation limit reached.') {
    super(message);
    this.name = 'QuotaExceededError';
  }
}

export class AiGenerationError extends Error {
  constructor(message = 'AI generation failed.') {
    super(message);
    this.name = 'AiGenerationError';
  }
}

export class AiOutputInvalidError extends Error {
  constructor(message = 'The model produced an invalid score.') {
    super(message);
    this.name = 'AiOutputInvalidError';
  }
}

export class ProjectNotFoundError extends Error {
  constructor(message = 'Project not found.') {
    super(message);
    this.name = 'ProjectNotFoundError';
  }
}

/**
 * The user has no credits left, so the job was refused before it ran.
 *
 * Its own class rather than an `ApiError` with `status === 402`, because it is
 * the one API failure with an obvious remedy: a UI should offer to sell
 * credits rather than report a network problem. Branching on the class is what
 * lets it do that without matching on a message or a bare status code.
 */
export class InsufficientCreditsError extends Error {
  constructor(message = 'Not enough credits.') {
    super(message);
    this.name = 'InsufficientCreditsError';
  }
}

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}
