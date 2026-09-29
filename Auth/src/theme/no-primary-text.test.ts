import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// HUGO-1815: `--uoa-color-primary` is a fill colour. A light brand primary (Hugo yellow) is
// unreadable as text on the page background, so text must use `--uoa-color-link` (or
// `--uoa-color-primary-text` on a primary fill). This guard stops the pattern coming back.
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

describe('primary colour is never used as text', () => {
  it('has no text-[var(--uoa-color-primary)] in Auth sources', () => {
    const offenders = sourceFiles(SRC).filter((file) =>
      /(?<![\w-])text-\[var\(--uoa-color-primary\)\]/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
  });

  it('scans a non-trivial number of files', () => {
    expect(sourceFiles(SRC).length).toBeGreaterThan(20);
  });
});
