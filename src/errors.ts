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

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}
