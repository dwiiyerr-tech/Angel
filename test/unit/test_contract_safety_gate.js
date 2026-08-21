import assert from 'node:assert/strict';
import {
  applyContractSafetyGate,
  evaluateContractSafetyEvidence,
} from '../../src/execution/contractSafetyGate.js';

console.log('[test_contract_safety_gate] Starting deterministic contract-safety tests...');

function safeCandidate(overrides = {}) {
  const base = {
    token: { mint: 'SafeMint1111111111111111111111111111111111' },
    metrics: { marketCapUsd: 80_000, liquidityUsd: 20_000, holderCount: 500 },
    jupiterAsset: {
      _dataQuality: { stale: false, ageMs: 1000 },
      audit: {
        mintAuthorityDisabled: true,
        freezeAuthorityDisabled: true,
        topHoldersPercentage: 30,
        devBalancePercentage: 2,
        botHoldersPercentage: 10,
        sniperPct: 5,
        devMigrations: 3,
        lpBurned: true,
      },
    },
    executionRefresh: { refreshedAtMs: Date.now() },
    filters: { passed: true, failures: [], opportunityWarnings: [] },
  };
  return {
    ...base,
    ...overrides,
    token: { ...base.token, ...(overrides.token || {}) },
    metrics: { ...base.metrics, ...(overrides.metrics || {}) },
    jupiterAsset: {
      ...base.jupiterAsset,
      ...(overrides.jupiterAsset || {}),
      audit: overrides.jupiterAsset?.audit === null
        ? null
        : { ...base.jupiterAsset.audit, ...(overrides.jupiterAsset?.audit || {}) },
    },
    executionRefresh: { ...base.executionRefresh, ...(overrides.executionRefresh || {}) },
    filters: { ...base.filters, ...(overrides.filters || {}) },
  };
}

const safeRugcheck = {
  score: 100,
  scoreNormalised: 100,
  hasCriticalRisk: false,
  risks: [],
};

assert.equal(evaluateContractSafetyEvidence({
  candidate: safeCandidate(), rugcheck: safeRugcheck, moneyMode: true, stage: 'pre_execution',
}).passed, true);

for (const [name, auditPatch, expected] of [
  ['mint authority', { mintAuthorityDisabled: false }, /mint authority/],
  ['freeze authority', { freezeAuthorityDisabled: false }, /freeze authority/],
  ['top holders', { topHoldersPercentage: 55 }, /top holders/],
  ['dev balance', { devBalancePercentage: 25 }, /dev balance/],
  ['bot holders', { botHoldersPercentage: 75 }, /bot holders/],
  ['snipers', { sniperPct: 80 }, /sniper concentration/],
  ['serial dev', { devMigrations: 120 }, /developer migrations/],
]) {
  const result = evaluateContractSafetyEvidence({
    candidate: safeCandidate({ jupiterAsset: { audit: auditPatch } }),
    rugcheck: safeRugcheck,
    moneyMode: true,
    stage: 'pre_execution',
  });
  assert.equal(result.passed, false, `${name} must fail closed`);
  assert.match(result.failures.join('; '), expected);
}

const missingAuditMoney = evaluateContractSafetyEvidence({
  candidate: safeCandidate({ jupiterAsset: { audit: null } }),
  rugcheck: safeRugcheck,
  moneyMode: true,
  stage: 'pre_execution',
});
assert.equal(missingAuditMoney.passed, false);
assert.match(missingAuditMoney.failures.join('; '), /audit unavailable/);

const missingAuditDry = evaluateContractSafetyEvidence({
  candidate: safeCandidate({ jupiterAsset: { audit: null } }),
  moneyMode: false,
  stage: 'screening',
});
assert.equal(missingAuditDry.passed, true, 'dry-run may collect unknown audit data');
assert.match(missingAuditDry.warnings.join('; '), /audit unavailable/);

const rugDanger = evaluateContractSafetyEvidence({
  candidate: safeCandidate(),
  rugcheck: { ...safeRugcheck, hasCriticalRisk: true, risks: [{ level: 'danger', name: 'test' }] },
  moneyMode: true,
  stage: 'pre_execution',
});
assert.equal(rugDanger.passed, false);
assert.match(rugDanger.failures.join('; '), /RugCheck reports danger\/critical risk/);

const rugUnavailable = evaluateContractSafetyEvidence({
  candidate: safeCandidate(),
  rugcheck: { error: true, message: 'timeout' },
  moneyMode: true,
  stage: 'pre_execution',
});
assert.equal(rugUnavailable.passed, false);
assert.match(rugUnavailable.failures.join('; '), /RugCheck unavailable/);

const staleRefresh = evaluateContractSafetyEvidence({
  candidate: safeCandidate({ executionRefresh: { refreshedAtMs: Date.now() - 31_000 } }),
  rugcheck: safeRugcheck,
  moneyMode: true,
  stage: 'pre_execution',
});
assert.equal(staleRefresh.passed, false);
assert.match(staleRefresh.failures.join('; '), /pre-execution refresh stale/);

const lowCapUnburned = evaluateContractSafetyEvidence({
  candidate: safeCandidate({
    metrics: { marketCapUsd: 40_000 },
    jupiterAsset: { audit: { lpBurned: false } },
  }),
  rugcheck: safeRugcheck,
  moneyMode: true,
  stage: 'pre_execution',
});
assert.equal(lowCapUnburned.passed, false);
assert.match(lowCapUnburned.failures.join('; '), /liquidity is explicitly unburned/);

const mutationCandidate = safeCandidate();
const applied = await applyContractSafetyGate(mutationCandidate, {
  moneyMode: true,
  stage: 'pre_execution',
  fetchRugcheck: false,
  rugcheckOverride: { ...safeRugcheck, scoreNormalised: 700 },
});
assert.equal(applied.passed, false);
assert.equal(mutationCandidate.filters.passed, false);
assert.match(mutationCandidate.filters.failures.join('; '), /RugCheck normalized score/);

console.log('[test_contract_safety_gate] SUCCESS: contract authority, concentration, RugCheck, LP, freshness, and unknown-data rules verified.');
