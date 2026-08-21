import { checkRugScore } from '../enrichment/rugcheck.js';

export const CONTRACT_SAFETY_LIMITS = Object.freeze({
  maxTopHoldersPercent: 50,
  maxDevBalancePercent: 20,
  maxBotHoldersPercent: 70,
  maxSniperPercent: 70,
  maxDevMigrations: 100,
  maxRugcheckNormalizedScore: 500,
  preExecutionFreshnessMs: 30_000,
});

const REQUIRED_MONEY_AUDIT_FIELDS = Object.freeze([
  'mintAuthorityDisabled',
  'freezeAuthorityDisabled',
  'topHoldersPercentage',
  'devBalancePercentage',
  'botHoldersPercentage',
  'devMigrations',
]);

function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeBoolean(value) {
  if (value === true || value === false) return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  return null;
}

function uniqueStrings(values = []) {
  return [...new Set(values.filter(Boolean).map(String))];
}

function riskLevel(risk) {
  return String(risk?.level || '').trim().toLowerCase();
}

export function evaluateContractSafetyEvidence({
  candidate,
  rugcheck = null,
  moneyMode = false,
  stage = 'screening',
  atMs = Date.now(),
} = {}) {
  const failures = [];
  const warnings = [];
  const audit = candidate?.jupiterAsset?.audit || null;
  const mint = candidate?.token?.mint || '';
  const mcap = nullableNumber(candidate?.metrics?.marketCapUsd);

  if (!mint) failures.push('contract safety: missing mint');

  if (candidate?.jupiterAsset?._dataQuality?.stale) {
    failures.push('contract safety: Jupiter asset data is stale');
  }

  const mintAuthorityDisabled = normalizeBoolean(audit?.mintAuthorityDisabled);
  const freezeAuthorityDisabled = normalizeBoolean(audit?.freezeAuthorityDisabled);
  if (mintAuthorityDisabled === false) {
    failures.push('contract safety: mint authority is still enabled');
  }
  if (freezeAuthorityDisabled === false) {
    failures.push('contract safety: freeze authority is still enabled');
  }

  const topHoldersPercentage = nullableNumber(audit?.topHoldersPercentage);
  if (topHoldersPercentage != null && topHoldersPercentage >= CONTRACT_SAFETY_LIMITS.maxTopHoldersPercent) {
    failures.push(`contract safety: top holders ${topHoldersPercentage.toFixed(1)}% >= ${CONTRACT_SAFETY_LIMITS.maxTopHoldersPercent}%`);
  }

  const devBalancePercentage = nullableNumber(audit?.devBalancePercentage);
  if (devBalancePercentage != null && devBalancePercentage >= CONTRACT_SAFETY_LIMITS.maxDevBalancePercent) {
    failures.push(`contract safety: dev balance ${devBalancePercentage.toFixed(1)}% >= ${CONTRACT_SAFETY_LIMITS.maxDevBalancePercent}%`);
  }

  const botHoldersPercentage = nullableNumber(audit?.botHoldersPercentage);
  if (botHoldersPercentage != null && botHoldersPercentage >= CONTRACT_SAFETY_LIMITS.maxBotHoldersPercent) {
    failures.push(`contract safety: bot holders ${botHoldersPercentage.toFixed(1)}% >= ${CONTRACT_SAFETY_LIMITS.maxBotHoldersPercent}%`);
  }

  const sniperPct = nullableNumber(audit?.sniperPct);
  if (sniperPct != null && sniperPct >= CONTRACT_SAFETY_LIMITS.maxSniperPercent) {
    failures.push(`contract safety: sniper concentration ${sniperPct.toFixed(1)}% >= ${CONTRACT_SAFETY_LIMITS.maxSniperPercent}%`);
  }

  const devMigrations = nullableNumber(audit?.devMigrations);
  if (devMigrations != null && devMigrations >= CONTRACT_SAFETY_LIMITS.maxDevMigrations) {
    failures.push(`contract safety: developer migrations ${devMigrations} >= ${CONTRACT_SAFETY_LIMITS.maxDevMigrations}`);
  }

  const lpBurned = normalizeBoolean(audit?.lpBurned ?? candidate?.lpBurned);
  if (mcap != null && mcap < 50_000 && lpBurned === false) {
    failures.push('contract safety: low-cap liquidity is explicitly unburned');
  }

  const missingAuditFields = REQUIRED_MONEY_AUDIT_FIELDS.filter(key => {
    const value = audit?.[key];
    if (key === 'mintAuthorityDisabled' || key === 'freezeAuthorityDisabled') return normalizeBoolean(value) === null;
    return nullableNumber(value) === null;
  });

  if (!audit) {
    (moneyMode ? failures : warnings).push('contract safety: Jupiter audit unavailable');
  } else if (missingAuditFields.length > 0) {
    const message = `contract safety: incomplete audit (${missingAuditFields.join(', ')})`;
    (moneyMode ? failures : warnings).push(message);
  }

  if (rugcheck) {
    const criticalRisks = Array.isArray(rugcheck.risks)
      ? rugcheck.risks.filter(risk => ['danger', 'critical'].includes(riskLevel(risk)))
      : [];
    if (rugcheck.hasCriticalRisk || criticalRisks.length > 0) {
      failures.push('contract safety: RugCheck reports danger/critical risk');
    }

    const normalizedScore = nullableNumber(rugcheck.scoreNormalised);
    const rawScore = nullableNumber(rugcheck.score);
    if (rugcheck.error) {
      (moneyMode ? failures : warnings).push(`contract safety: RugCheck unavailable${rugcheck.message ? ` (${rugcheck.message})` : ''}`);
    } else if (normalizedScore == null || rawScore == null) {
      (moneyMode ? failures : warnings).push('contract safety: RugCheck score incomplete');
    } else if (normalizedScore > CONTRACT_SAFETY_LIMITS.maxRugcheckNormalizedScore) {
      failures.push(`contract safety: RugCheck normalized score ${normalizedScore} > ${CONTRACT_SAFETY_LIMITS.maxRugcheckNormalizedScore}`);
    }
  } else if (moneyMode) {
    failures.push('contract safety: RugCheck evidence unavailable');
  } else {
    warnings.push('contract safety: RugCheck not required in dry-run screening');
  }

  if (moneyMode && stage === 'pre_execution') {
    const refreshedAtMs = nullableNumber(candidate?.executionRefresh?.refreshedAtMs);
    const ageMs = refreshedAtMs == null ? null : Number(atMs) - refreshedAtMs;
    if (refreshedAtMs == null) {
      failures.push('contract safety: pre-execution market refresh missing');
    } else if (ageMs < -5_000 || ageMs > CONTRACT_SAFETY_LIMITS.preExecutionFreshnessMs) {
      failures.push(`contract safety: pre-execution refresh stale (${Math.max(0, ageMs)}ms)`);
    }
  }

  return {
    passed: failures.length === 0,
    failures: uniqueStrings(failures),
    warnings: uniqueStrings(warnings),
    missingAuditFields,
    auditComplete: Boolean(audit) && missingAuditFields.length === 0,
    moneyMode: Boolean(moneyMode),
    stage,
  };
}

export async function applyContractSafetyGate(candidate, {
  moneyMode = false,
  stage = 'screening',
  fetchRugcheck = moneyMode,
  rugcheckOverride,
  atMs = Date.now(),
} = {}) {
  let rugcheck = rugcheckOverride;
  if (rugcheck === undefined && fetchRugcheck) {
    try {
      rugcheck = candidate?.token?.mint
        ? await checkRugScore(candidate.token.mint)
        : { error: true, message: 'missing mint' };
    } catch (error) {
      rugcheck = { error: true, message: error.message };
    }
  }
  if (rugcheck === undefined) rugcheck = null;

  const assessment = evaluateContractSafetyEvidence({
    candidate,
    rugcheck,
    moneyMode,
    stage,
    atMs,
  });

  const priorFilters = candidate.filters || {};
  const priorFailures = Array.isArray(priorFilters.failures) ? priorFilters.failures : [];
  const priorWarnings = Array.isArray(priorFilters.opportunityWarnings) ? priorFilters.opportunityWarnings : [];
  candidate.contractSafety = {
    ...assessment,
    checkedAtMs: atMs,
    rugcheck,
  };
  candidate.filters = {
    ...priorFilters,
    passed: priorFilters.passed !== false && assessment.passed,
    failures: uniqueStrings([...priorFailures, ...assessment.failures]),
    opportunityWarnings: uniqueStrings([...priorWarnings, ...assessment.warnings]),
  };

  return assessment;
}

export async function assertContractSafetyForMoneyMode(candidate, { stage = 'pre_execution', atMs = Date.now() } = {}) {
  const assessment = await applyContractSafetyGate(candidate, {
    moneyMode: true,
    stage,
    fetchRugcheck: true,
    atMs,
  });
  if (!assessment.passed) {
    throw new Error(`Contract safety gate rejected entry: ${assessment.failures.join('; ')}`);
  }
  return assessment;
}
