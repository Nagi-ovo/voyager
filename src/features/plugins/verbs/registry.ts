/**
 * Primitive registry — the whitelist behind the `native` op (plan §5).
 *
 * Keyed by primitive NAME (not plugin id: that is the separate, first-party
 * `nativeHandlers` binding for builtin plugins, left untouched until P4).
 * Every entry is first-party code bundled in the extension; a manifest can
 * only pick one by name and pass validated parameters.
 */
import { PRIMITIVE_CONTRACTS } from './contracts';
import { formulaCopyPrimitive } from './formulaCopy';
import { turnNavigatorPrimitive } from './turnNavigator';
import type { Primitive } from './types';
import { vimInputPrimitive } from './vimInput';

const PRIMITIVES: ReadonlyMap<string, Primitive<never>> = new Map<string, Primitive<never>>([
  [formulaCopyPrimitive.contract.name, formulaCopyPrimitive as Primitive<never>],
  [vimInputPrimitive.contract.name, vimInputPrimitive as Primitive<never>],
  [turnNavigatorPrimitive.contract.name, turnNavigatorPrimitive as Primitive<never>],
]);

export function getPrimitive(name: string): Primitive<never> | undefined {
  return PRIMITIVES.get(name);
}

export function hasPrimitive(name: string): boolean {
  return PRIMITIVES.has(name);
}

export function listPrimitiveNames(): readonly string[] {
  return [...PRIMITIVES.keys()];
}

/** Every declared contract must have an implementation and vice versa. */
export function verifyPrimitiveRegistry(): string[] {
  const problems: string[] = [];
  for (const contract of PRIMITIVE_CONTRACTS) {
    if (!PRIMITIVES.has(contract.name))
      problems.push(`contract "${contract.name}" has no primitive`);
  }
  for (const name of PRIMITIVES.keys()) {
    if (!PRIMITIVE_CONTRACTS.some((contract) => contract.name === name)) {
      problems.push(`primitive "${name}" has no contract`);
    }
  }
  return problems;
}
