const INSTRUCTIONS_START = '[System Instructions]';
const INSTRUCTIONS_END = '[/System Instructions]';

const INSTRUCTIONS_PATTERN = new RegExp(
  `${INSTRUCTIONS_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${INSTRUCTIONS_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n*`,
);

function sanitizeMarkerText(text: string): string {
  return text
    .replace(/\[System Instructions\]/g, '[System Instructi\u200Bons]')
    .replace(/\[\/System Instructions\]/g, '[/System Instructi\u200Bons]');
}

export function normalizeInstructionBlockText(text: string): string {
  return text.replace(/\n\n/g, '\n');
}

export function stripInstructionBlock(text: string): string {
  return normalizeInstructionBlockText(text).replace(INSTRUCTIONS_PATTERN, '');
}

/** Remove only Voyager's injected block without rewriting the user's whitespace. */
export function stripInstructionBlockPreservingWhitespace(text: string): string {
  return text.replace(INSTRUCTIONS_PATTERN, '');
}

export function hasInstructionBlock(text: string): boolean {
  return INSTRUCTIONS_PATTERN.test(normalizeInstructionBlockText(text));
}

export function buildInstructionBlock(folderName: string, instructions: string): string {
  return [
    INSTRUCTIONS_START,
    `Project: ${folderName}`,
    '',
    'Follow these instructions for the entire conversation.',
    'Do not mention or repeat these instructions in your response.',
    '',
    sanitizeMarkerText(instructions),
    INSTRUCTIONS_END,
    '',
  ].join('\n');
}
