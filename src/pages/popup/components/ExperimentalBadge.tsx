import React from 'react';

/** The "experiment" glyph shown beside settings that are still experimental. */
export function ExperimentalBadge({ title }: { title: string }) {
  return (
    <span
      className="material-symbols-outlined cursor-help text-[16px] leading-none opacity-50 transition-opacity hover:opacity-100"
      title={title}
      style={{ fontVariationSettings: "'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 20" }}
    >
      experiment
    </span>
  );
}
