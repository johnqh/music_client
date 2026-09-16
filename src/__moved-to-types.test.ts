/**
 * The submission, error-kind and publish-name types live in music_types, once.
 *
 * `GeneratedProjectSubmission` was a structural copy of music_lib's
 * `NewProjectSubmission`, written out because this package may not depend on
 * music_lib. The shape is vocabulary, so it moved below both of them, and the
 * two names became one. music_lib re-exports this package's neighbours and
 * music_types wholesale, so a name declared or re-exported here again reaches
 * an app by two routes.
 */
import { describe, expect, it } from 'vitest';
import { globSync, readFileSync } from 'node:fs';

const MOVED = ['GeneratedProjectSubmission', 'NewProjectSubmission', 'GenerationErrorKind', 'PublishNames'];

describe('types that moved to music_types', () => {
  it('are neither declared nor re-exported by any source file', () => {
    const offenders: string[] = [];
    for (const file of globSync('src/**/*.{ts,tsx}')) {
      if (file.includes('.test.')) continue;
      const text = readFileSync(file, 'utf8');
      for (const name of MOVED) {
        const declared = new RegExp(`export\\s+(?:type|interface|const|class|function|enum)\\s+${name}\\b`);
        const reexported = new RegExp(`export\\s+(?:type\\s+)?\\{[^}]*\\b${name}\\b[^}]*\\}`);
        if (declared.test(text) || reexported.test(text)) offenders.push(`${name} in ${file}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
