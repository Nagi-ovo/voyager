import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BASELINE_PATH, checkFileSizes, updateBaseline } from '../check-file-size.mjs';

let root: string;

function writeSource(relative: string, lines: number): void {
  const full = path.join(root, relative);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, `${Array.from({ length: lines }, (_, i) => `// ${i}`).join('\n')}\n`);
}

function writeBaseline(files: Record<string, number>, limit = 10): void {
  const full = path.join(root, BASELINE_PATH);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, JSON.stringify({ limit, files }));
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'voyager-file-size-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('file-size ratchet', () => {
  it('fails a new file over the limit that is not in the baseline', () => {
    writeBaseline({});
    writeSource('src/big.ts', 12);
    writeSource('src/small.tsx', 3);

    const result = checkFileSizes(root);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('src/big.ts has 12 lines');
  });

  it('fails a baselined file that grew, passes one that held or shrank', () => {
    writeBaseline({ 'src/grew.ts': 11, 'src/held.ts': 11, 'src/shrank.ts': 15 });
    writeSource('src/grew.ts', 12);
    writeSource('src/held.ts', 11);
    writeSource('src/shrank.ts', 11);

    const result = checkFileSizes(root);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('src/grew.ts grew from 11 to 12');
    expect(result.shrunk).toEqual(['src/shrank.ts']);
  });

  it('treats a baselined file that dropped under the limit or was deleted as tightenable', () => {
    writeBaseline({ 'src/now-small.ts': 20, 'src/gone.ts': 20 });
    writeSource('src/now-small.ts', 5);

    const result = checkFileSizes(root);
    expect(result.errors).toEqual([]);
    expect(result.shrunk.sort()).toEqual(['src/gone.ts', 'src/now-small.ts']);
  });

  it('update lowers or removes entries but never raises one', () => {
    writeBaseline({ 'src/shrank.ts': 15, 'src/grew.ts': 11, 'src/now-small.ts': 20 });
    writeSource('src/shrank.ts', 12);
    writeSource('src/grew.ts', 14);
    writeSource('src/now-small.ts', 4);
    writeSource('src/new-big.ts', 13);

    updateBaseline(root);
    const written = JSON.parse(readFileSync(path.join(root, BASELINE_PATH), 'utf8'));
    expect(written).toEqual({
      limit: 10,
      files: { 'src/grew.ts': 11, 'src/new-big.ts': 13, 'src/shrank.ts': 12 },
    });
  });
});
