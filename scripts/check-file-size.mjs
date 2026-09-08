import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * File-size ratchet for `src/**\/*.{ts,tsx}`.
 *
 * Files already over the limit are listed in the baseline with their current
 * line count. The check fails when a file over the limit is missing from the
 * baseline (a new oversized file) or has grown past its recorded count. A
 * file that shrank passes; `--update` lowers its entry or drops it once it is
 * back under the limit. `--update` never raises a count: growing an oversized
 * file is a review decision, so edit the baseline by hand in that PR.
 */

export const DEFAULT_LIMIT = 1000;
export const BASELINE_PATH = 'scripts/file-size-baseline.json';
const SOURCE_ROOT = 'src';
const EXTENSIONS = new Set(['.ts', '.tsx']);

function listSourceFiles(root) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory).sort()) {
      const full = path.join(directory, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== 'node_modules') walk(full);
      } else if (EXTENSIONS.has(path.extname(entry))) {
        files.push(full);
      }
    }
  };
  if (existsSync(root)) walk(root);
  return files;
}

function countLines(filePath) {
  const text = readFileSync(filePath, 'utf8');
  if (text.length === 0) return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

function readBaseline(baselinePath) {
  if (!existsSync(baselinePath)) return { limit: DEFAULT_LIMIT, files: {} };
  const parsed = JSON.parse(readFileSync(baselinePath, 'utf8'));
  return {
    limit: typeof parsed.limit === 'number' ? parsed.limit : DEFAULT_LIMIT,
    files: parsed.files && typeof parsed.files === 'object' ? parsed.files : {},
  };
}

/** Measure every source file over the limit and compare it with the baseline. */
export function checkFileSizes(repositoryRoot = process.cwd()) {
  const baselinePath = path.join(repositoryRoot, BASELINE_PATH);
  const baseline = readBaseline(baselinePath);
  const errors = [];
  const shrunk = [];
  const oversized = {};

  for (const absolute of listSourceFiles(path.join(repositoryRoot, SOURCE_ROOT))) {
    const relative = path.relative(repositoryRoot, absolute).split(path.sep).join('/');
    const lines = countLines(absolute);
    if (lines <= baseline.limit) {
      if (relative in baseline.files) shrunk.push(relative);
      continue;
    }
    oversized[relative] = lines;
    const recorded = baseline.files[relative];
    if (recorded === undefined) {
      errors.push(
        `${relative} has ${lines} lines, over the ${baseline.limit}-line limit. Split it, or add it to ${BASELINE_PATH} in this PR with a reason in the description.`,
      );
    } else if (lines > recorded) {
      errors.push(
        `${relative} grew from ${recorded} to ${lines} lines. Move the new code into a new file, or raise its entry in ${BASELINE_PATH} deliberately in this PR.`,
      );
    } else if (lines < recorded) {
      shrunk.push(relative);
    }
  }

  for (const relative of Object.keys(baseline.files)) {
    if (!(relative in oversized) && !shrunk.includes(relative)) {
      if (!existsSync(path.join(repositoryRoot, relative))) shrunk.push(relative);
    }
  }

  return { limit: baseline.limit, errors, shrunk, oversized };
}

/** Rewrite the baseline from the current tree; only ever lowers or removes entries. */
export function updateBaseline(repositoryRoot = process.cwd()) {
  const baselinePath = path.join(repositoryRoot, BASELINE_PATH);
  const previous = readBaseline(baselinePath);
  const { oversized } = checkFileSizes(repositoryRoot);
  const files = {};
  for (const [relative, lines] of Object.entries(oversized).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const recorded = previous.files[relative];
    files[relative] = recorded === undefined ? lines : Math.min(recorded, lines);
  }
  const next = { limit: previous.limit, files };
  writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function main() {
  if (process.argv.includes('--update')) {
    const next = updateBaseline();
    console.log(
      `Baseline written: ${Object.keys(next.files).length} files over ${next.limit} lines.`,
    );
    return;
  }
  const result = checkFileSizes();
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(`::error::${error}`);
    process.exit(1);
  }
  const tracked = Object.keys(result.oversized).length;
  console.log(`File sizes OK: ${tracked} files over ${result.limit} lines, none grew.`);
  if (result.shrunk.length > 0) {
    console.log(
      `${result.shrunk.length} baseline entries can be tightened: run \`bun run filesize:update\` (${result.shrunk.join(', ')}).`,
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
