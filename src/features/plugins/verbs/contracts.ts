/**
 * Primitive ("verb") contracts — DATA ONLY (plan §2 layer 2, §5).
 *
 * A primitive is first-party behaviour shipped inside the extension that a
 * declarative plugin can invoke through `{ "op": "native", "handler": "<name>",
 * "params": {…} }`. This module lists what each primitive is called, which
 * engine version first shipped it and what parameters it accepts, without
 * importing any implementation, so that:
 *   - `scripts/build-plugin-catalog.ts` (Bun, no DOM) can check a manifest's
 *     `requires.handlers` and `engine` against it (plan §5, §8);
 *   - `verbs/contracts.test.ts` can enforce D9 (a published parameter never
 *     changes type or becomes required) against a committed baseline.
 *
 * Rules (plan D9): parameters are only ever added, and only as optional; a
 * breaking change ships under a NEW primitive name.
 */
import type { SemanticSelectorKey } from '../sites/semanticKeys';

export type PrimitiveParamType = 'string' | 'number' | 'boolean' | 'selector';

export interface PrimitiveParamSpec {
  readonly type: PrimitiveParamType;
  readonly required: boolean;
  readonly description: string;
}

export interface PrimitiveContract {
  readonly name: string;
  /** Engine version that first shipped the primitive; `engine` of any manifest using it must be ≥ this. */
  readonly sinceEngine: string;
  /** Semantic keys the primitive reads from the site adapter (unless a param overrides them). */
  readonly semantic: readonly SemanticSelectorKey[];
  readonly params: Readonly<Record<string, PrimitiveParamSpec>>;
  readonly description: string;
}

export const PRIMITIVE_NAME_PATTERN = /^[a-z][a-zA-Z0-9]{1,39}$/;

export const PRIMITIVE_CONTRACTS: readonly PrimitiveContract[] = [
  {
    name: 'formulaCopy',
    sinceEngine: '1.3.0',
    semantic: [],
    params: {},
    description:
      'Click an inline or block formula to copy its LaTeX; hover shows it is clickable. Reads KaTeX / MathJax markup on the page.',
  },
  {
    name: 'vimInput',
    sinceEngine: '1.4.0',
    semantic: ['composer'],
    params: {
      composer: {
        type: 'selector',
        required: false,
        description:
          "Prompt input to attach Vim modal editing to; defaults to the site adapter's composer.",
      },
    },
    description: 'Vim-style modal editing and cursor navigation in the prompt composer.',
  },
  {
    name: 'turnNavigator',
    sinceEngine: '1.4.0',
    semantic: ['userTurn'],
    params: {
      turn: {
        type: 'selector',
        required: false,
        description: "User-turn elements to index; defaults to the site adapter's userTurn.",
      },
      conversationIdPattern: {
        type: 'string',
        required: false,
        description:
          "Path regular expression whose first group is the conversation id; defaults to the site adapter's conversationIdPattern.",
      },
      scrollContainer: {
        type: 'selector',
        required: false,
        description: 'Element that scrolls the conversation; auto-detected when absent.',
      },
      yieldWhen: {
        type: 'selector',
        required: false,
        description:
          'While this matches (an open side panel, an artifact frame), the onboarding guide stays closed.',
      },
      position: {
        type: 'string',
        required: false,
        description: 'Rail side: "right" (default) or "left".',
      },
    },
    description:
      'A compact conversation timeline with starred messages and search, built on the same code as the Claude timeline.',
  },
];

export function getPrimitiveContract(name: string): PrimitiveContract | undefined {
  return PRIMITIVE_CONTRACTS.find((contract) => contract.name === name);
}
