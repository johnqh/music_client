import { describe, expect, it } from 'vitest';
import {
  ApiError,
  InsufficientCreditsError,
  QuotaExceededError,
  classifyGenerationError,
  isInsufficientCredits,
} from './errors.js';

describe('isInsufficientCredits', () => {
  it('recognises the typed error', () => {
    expect(isInsufficientCredits(new InsufficientCreditsError())).toBe(true);
  });

  it('recognises a copy from a second bundled instance of this package, by name', () => {
    // Two copies of music_client in one bundle make `instanceof` false for an
    // error thrown by the other copy — the paywall would silently become a toast.
    const foreign = new Error('Not enough credits.');
    foreign.name = 'InsufficientCreditsError';
    expect(isInsufficientCredits(foreign)).toBe(true);
  });

  it('recognises a bare 402 that reached the caller as an ApiError', () => {
    expect(isInsufficientCredits(new ApiError('Payment required', 402))).toBe(true);
  });

  it('is false for everything else', () => {
    expect(isInsufficientCredits(new QuotaExceededError())).toBe(false);
    expect(isInsufficientCredits(new ApiError('x', 500))).toBe(false);
    expect(isInsufficientCredits('INSUFFICIENT_CREDITS')).toBe(false);
    expect(isInsufficientCredits(null)).toBe(false);
  });
});

describe('classifyGenerationError', () => {
  it('sends a credits refusal to the paywall and everything else to an error', () => {
    expect(classifyGenerationError(new InsufficientCreditsError())).toBe('paywall');
    expect(classifyGenerationError(new QuotaExceededError())).toBe('error');
    expect(classifyGenerationError(new Error('network'))).toBe('error');
  });
});
