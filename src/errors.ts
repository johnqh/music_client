/**
 * Typed errors mapped from music_api's envelope codes / HTTP statuses so UI
 * layers can branch on error class instead of parsing messages.
 */
import type { GenerationErrorKind } from '@sudobility/music_types';

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

/**
 * Whether a failure is the server refusing work for want of credits.
 *
 * Checked by name as well as by class. Two copies of this package in one
 * bundle — a nested install, an rsynced build beside a registry one — make
 * `instanceof` false for an error thrown by the other copy, and the paywall
 * then silently degrades into a toast saying a request failed. A bare 402 that
 * reached a caller as an `ApiError` is the same refusal.
 */
export function isInsufficientCredits(err: unknown): boolean {
  if (err instanceof InsufficientCreditsError) return true;
  if (err instanceof ApiError && err.status === 402) return true;
  return err instanceof Error && err.name === 'InsufficientCreditsError';
}

/**
 * Where a failed generation goes: the store, or an ordinary error message.
 *
 * Running out of credits is the one refusal the user can act on, so it opens
 * the paywall rather than reporting a failure. Decided here so the dashboard,
 * the editor and both apps route it identically — they raise jobs from
 * different code, and each was separately reporting the 402 as a network error.
 */
export function classifyGenerationError(err: unknown): GenerationErrorKind {
  return isInsufficientCredits(err) ? 'paywall' : 'error';
}
