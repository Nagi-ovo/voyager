import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('compact timeline alignment', () => {
  const css = readFileSync(resolve(process.cwd(), 'public/contentStyle.css'), 'utf8');

  it('shares the ruler inward-edge anchor on both viewport sides', () => {
    expect(css).toMatch(
      /\.gemini-timeline-bar\.timeline-style-compact \.timeline-dot::after\s*\{[^}]*right: 50%;[^}]*left: auto;[^}]*transform: translateY\(-50%\);/s,
    );
    expect(css).toMatch(
      /\.gemini-timeline-bar\.timeline-style-compact\.gv-timeline-ruler-inward-right\s+\.timeline-dot::after\s*\{[^}]*right: auto;[^}]*left: 50%;/s,
    );
  });
});
