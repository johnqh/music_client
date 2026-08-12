import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, found);
    else if (/\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path)) found.push(path);
  }
  return found;
}

/** Prose is not code — a doc comment naming `document.` must not fail the build. The `[^:]` guard keeps `https://` from eating the rest of its line. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Globals the web has and React Native does not. Deliberately excludes
 * `fetch`, `Blob`, `File`, `FormData`, `AbortSignal`, `URLSearchParams` and
 * `Response`: `lib.dom.d.ts` is where TypeScript declares them, but React
 * Native implements them too, and this client is built out of exactly those.
 */
const WEB_ONLY_GLOBALS = [
  'document',
  'window',
  'navigator',
  'localStorage',
  'sessionStorage',
  'DOMParser',
  'XMLHttpRequest',
  'requestAnimationFrame',
  'getComputedStyle',
  'matchMedia',
  'alert',
];

/**
 * `tsconfig.json` sets `lib: [..., "DOM"]` and `eslint.config.js` spreads
 * `globals.browser`, both of which this package genuinely needs for the
 * standard-everywhere globals above. The cost is that neither the compiler nor
 * the linter will ever object to `document.querySelector` appearing here, and
 * every test runs in jsdom where it would work fine. This is the check that
 * objects. Mirrors `music_lib`'s `src/platform/no-platform-imports.test.ts`.
 */
describe('music_client is platform-free', () => {
  it('touches no web-only global', () => {
    const pattern = new RegExp(`(^|[^.\\w])(globalThis\\.)?(${WEB_ONLY_GLOBALS.join('|')})\\s*[.([]`, 'm');
    const offenders = sourceFiles('src').filter((path) => pattern.test(stripComments(readFileSync(path, 'utf8'))));
    expect(offenders).toEqual([]);
  });

  /**
   * `import.meta` is syntax, not a value, so a `typeof` guard cannot cover it:
   * React Native's bundler transforms modules to CommonJS, where it has no
   * meaning, and the build fails at parse time. Node and Vite both accept it,
   * which is why nothing else here would notice.
   */
  it("emits no `import.meta`, which React Native's bundler cannot parse", () => {
    const offenders = sourceFiles('src').filter((path) =>
      /import\s*\.\s*meta/.test(stripComments(readFileSync(path, 'utf8'))),
    );
    expect(offenders).toEqual([]);
  });

  it('gates every capability React Native lacks behind a runtime check', () => {
    // `CompressionStream` is absent on Hermes. The gzip path must never be
    // reached by a feature test that assumes it exists.
    const client = stripComments(readFileSync('src/network/music-client.ts', 'utf8'));
    expect(client).toMatch(/typeof CompressionStream === 'undefined'/);
  });
});
