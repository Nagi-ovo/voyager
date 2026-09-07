import { describe, expect, it } from 'vitest';

import { PLUGIN_ENGINE_VERSION } from '../constants';
import { engineSatisfied, parseSemver } from '../semver';
import { PRIMITIVE_CONTRACTS, PRIMITIVE_NAME_PATTERN, getPrimitiveContract } from './contracts';
import baseline from './paramsBaseline.json';
import { listPrimitiveNames, verifyPrimitiveRegistry } from './registry';

interface BaselineParam {
  readonly type: string;
  readonly required: boolean;
}
interface BaselinePrimitive {
  readonly sinceEngine: string;
  readonly params: Readonly<Record<string, BaselineParam>>;
}
const published = (baseline as { primitives: Record<string, BaselinePrimitive> }).primitives;

describe('primitive contracts (plan D9: only ever add, only optional)', () => {
  it('every published primitive still exists with the same sinceEngine', () => {
    for (const [name, entry] of Object.entries(published)) {
      const contract = getPrimitiveContract(name);
      expect(contract, `primitive ${name} was published and must not disappear`).toBeDefined();
      expect(contract?.sinceEngine).toBe(entry.sinceEngine);
    }
  });

  it('no published param changed type or became required, and new params are optional', () => {
    for (const [name, entry] of Object.entries(published)) {
      const contract = getPrimitiveContract(name)!;
      for (const [param, spec] of Object.entries(entry.params)) {
        const current = contract.params[param];
        expect(current, `${name}.${param} was published and must not disappear`).toBeDefined();
        expect(current.type).toBe(spec.type);
        if (!spec.required) expect(current.required).toBe(false);
      }
      for (const [param, spec] of Object.entries(contract.params)) {
        if (!(param in entry.params)) {
          expect(spec.required, `${name}.${param} is new and must be optional`).toBe(false);
        }
      }
    }
  });

  it('every contract is in the baseline (append it when a primitive ships)', () => {
    for (const contract of PRIMITIVE_CONTRACTS) {
      expect(published[contract.name], `add ${contract.name} to paramsBaseline.json`).toBeDefined();
    }
  });

  it('names are camelCase identifiers and sinceEngine never exceeds the current engine', () => {
    for (const contract of PRIMITIVE_CONTRACTS) {
      expect(contract.name).toMatch(PRIMITIVE_NAME_PATTERN);
      expect(parseSemver(contract.sinceEngine)).not.toBeNull();
      expect(engineSatisfied(`>=${contract.sinceEngine}`, PLUGIN_ENGINE_VERSION)).toBe(true);
    }
  });

  it('the registry implements exactly the declared contracts', () => {
    expect(verifyPrimitiveRegistry()).toEqual([]);
    expect([...listPrimitiveNames()].sort()).toEqual(
      PRIMITIVE_CONTRACTS.map((contract) => contract.name).sort(),
    );
  });
});
