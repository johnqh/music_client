/**
 * music_client must run unchanged on the web and in React Native.
 *
 * The family's frontend packages are audited for this, and an audit is a
 * moment in time — one `document.` in a commit six months from now breaks a
 * native build at runtime, long after the change that caused it and nowhere
 * near it. So the property is checked here instead of remembered.
 *
 * Scoped to what SHIPS. Test files and test helpers are excluded because they
 * do not go in the package — music_codecs' test-only XML parser uses
 * `DOMParser`, which is exactly right for a helper that runs on a dev machine
 * and exactly wrong to flag as a portability defect.
 *
 * Comments and string bodies are stripped before matching, because prose about
 * a "document" is not a reach for the browser global, and a guard that cries
 * wolf is a guard somebody deletes.
 */
import { describe, expect, it } from 'vitest';
import { globSync, readFileSync } from 'node:fs';

/** Globals a browser has and React Native does not. */
const WEB_ONLY =
  /\b(document|window|localStorage|sessionStorage|XMLHttpRequest|HTMLElement|HTMLCanvasElement|CanvasRenderingContext2D|requestAnimationFrame|IntersectionObserver|ResizeObserver|Worker|DOMParser|FileReader)\b/;

function sources(): string[] {
  return globSync('src/**/*.ts', { cwd: process.cwd() }).filter(
    (f) => !f.includes('.test.') && !f.startsWith('src/test/'),
  );
}

/** The file as code: comments and string bodies removed. */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

describe('portability to React Native', () => {
  it('touches no global that React Native does not have', () => {
    const offenders = sources().flatMap((file) => {
      const match = WEB_ONLY.exec(codeOf(file));
      return match ? [`${file}: ${match[1]}`] : [];
    });

    expect(offenders).toEqual([]);
  });
});
