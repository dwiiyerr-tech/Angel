from pathlib import Path


def replace_once(path, old, new, expected=1):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != expected:
        raise SystemExit(f"guard failed {path}: expected {expected} occurrence(s), found {count}")
    p.write_text(text.replace(old, new))


replace_once(
    'src/controlPlane/registry.js',
    "import { ROUTE_EDGE_MODEL_VERSION } from '../edge/routeEdgeModel.js';\nimport { ensureControlPlaneSchema } from './schema.js';",
    "import { ROUTE_EDGE_MODEL_VERSION } from '../edge/routeEdgeModel.js';\nimport { validateNeedleWeights } from '../edge/needleWeights.js';\nimport { ensureControlPlaneSchema } from './schema.js';",
)
replace_once(
    'src/controlPlane/registry.js',
    "  'flow_hard_price_change_pct',\n  'flow_hard_net_buyer_ratio',\n]);",
    "  'flow_hard_price_change_pct',\n  'flow_hard_net_buyer_ratio',\n  'needle_weights_json',\n]);",
)
replace_once(
    'src/controlPlane/registry.js',
    "    if (key === 'blocked_routes') {\n      value = normalizedBlockedRoutes(item.value);\n    } else {\n      const number = Number(item.value);",
    "    if (key === 'blocked_routes') {\n      value = normalizedBlockedRoutes(item.value);\n    } else if (key === 'needle_weights_json') {\n      value = canonicalJson(validateNeedleWeights(item.value));\n    } else {\n      const number = Number(item.value);",
)

replace_once(
    'src/controlPlane/challenger.js',
    "import { ensureControlPlaneSchema } from './schema.js';",
    "import { ensureControlPlaneSchema } from './schema.js';\nimport { evaluateNeedleWeightComparison } from '../edge/needleCalibration.js';\nimport { BASE_NEEDLE_WEIGHTS, parseNeedleWeights, scoreNeedleDimensions } from '../edge/needleWeights.js';",
)
replace_once(
    'src/controlPlane/challenger.js',
    "function parseBlockedRoutes(value) {",
    "function parsePayload(value) {\n  try { return JSON.parse(value || '{}'); } catch { return {}; }\n}\n\nfunction parseBlockedRoutes(value) {",
)
replace_once(
    'src/controlPlane/challenger.js',
    "  const sourceWeight = finite(candidate?.filters?.sourceWeight) ?? 1;\n  const liquidity = finite(candidate?.metrics?.liquidityUsd ?? candidate?.jupiterAsset?.liquidityUsd ?? candidate?.gmgn?.liquidity) ?? 0;",
    "  const sourceWeight = finite(candidate?.filters?.sourceWeight) ?? 1;\n  const needleDimensions = candidate?.needle?.dimensions || null;\n  const needleWeights = parseNeedleWeights(settings.needle_weights_json, BASE_NEEDLE_WEIGHTS);\n  const needleScore = needleDimensions ? scoreNeedleDimensions(needleDimensions, needleWeights) : null;\n  const liquidity = finite(candidate?.metrics?.liquidityUsd ?? candidate?.jupiterAsset?.liquidityUsd ?? candidate?.gmgn?.liquidity) ?? 0;",
)
replace_once(
    'src/controlPlane/challenger.js',
    "  const evidence = { liquidity, priceChange1h, netBuyerRatio, liquidityFloor, flowPriceFloor, flowNetFloor };",
    "  const evidence = { liquidity, priceChange1h, netBuyerRatio, liquidityFloor, flowPriceFloor, flowNetFloor, needleScore, needleWeights };",
)
replace_once(
    'src/controlPlane/challenger.js',
    "    edge: candidate?.edge?.combined || null,\n    quality: candidate?.edge?.quality || null,",
    "    edge: candidate?.edge?.combined || null,\n    quality: candidate?.edge?.quality || null,\n    needle: candidate?.needle || null,",
)
replace_once(
    'src/controlPlane/challenger.js',
    "    SELECT o.active_eligible, o.challenger_eligible, o.route, o.confidence,\n           p.realized_r, p.pnl_percent",
    "    SELECT o.active_eligible, o.challenger_eligible, o.route, o.confidence, o.payload_json,\n           p.realized_r, p.pnl_percent, p.mfe_r, p.mae_r, p.closed_at_ms",
)
old_eval = """  const evaluation = evaluateChallengerRows(rows, {\n    minSample: Number(proposal.min_test_sample || 30),\n    minAgeMs: Math.max(0, numSetting('control_plane_min_test_hours', 24)) * 60 * 60 * 1000,\n    startedAtMs: Number(proposal.test_started_at_ms || proposal.created_at_ms),\n    minimumExpectancyDeltaR: numSetting('control_plane_min_expectancy_delta_r', 0.05),\n  });"""
new_eval = """  const minSample = Number(proposal.min_test_sample || 30);\n  const minAgeMs = Math.max(0, numSetting('control_plane_min_test_hours', 24)) * 60 * 60 * 1000;\n  const startedAtMs = Number(proposal.test_started_at_ms || proposal.created_at_ms);\n  const needleWeightChange = (proposal?.proposal?.changes || []).some(change => change?.key === 'needle_weights_json');\n  let evaluation;\n  if (needleWeightChange) {\n    const control = configVersionByNumber(proposal.parent_version);\n    const challengerConfig = configVersionByNumber(proposal.proposed_version);\n    const activeWeights = parseNeedleWeights(control?.config?.settings?.needle_weights_json, BASE_NEEDLE_WEIGHTS);\n    const challengerWeights = parseNeedleWeights(challengerConfig?.config?.settings?.needle_weights_json, BASE_NEEDLE_WEIGHTS);\n    const needleRows = rows.map(row => {\n      const payload = parsePayload(row.payload_json);\n      const dimensions = payload?.needle?.dimensions;\n      if (!dimensions || finite(row.mfe_r) == null) return null;\n      return {\n        dimensions,\n        mfeR: finite(row.mfe_r),\n        maeR: finite(row.mae_r),\n        realizedR: finite(row.realized_r),\n        closedAtMs: finite(row.closed_at_ms),\n      };\n    }).filter(Boolean);\n    evaluation = {\n      evaluationType: 'needle_weight_ranking',\n      activeWeights,\n      challengerWeights,\n      ...evaluateNeedleWeightComparison(needleRows, activeWeights, challengerWeights, {\n        minSample,\n        minAgeMs,\n        startedAtMs,\n        minUtilityLift: numSetting('needle_challenger_min_utility_lift', 0.01),\n      }),\n    };\n  } else {\n    evaluation = evaluateChallengerRows(rows, {\n      minSample,\n      minAgeMs,\n      startedAtMs,\n      minimumExpectancyDeltaR: numSetting('control_plane_min_expectancy_delta_r', 0.05),\n    });\n  }"""
replace_once('src/controlPlane/challenger.js', old_eval, new_eval)

replace_once(
    'src/pipeline/momentumFilter.js',
    "    candidate.filters.needleEvidenceCoverage = needle.evidenceCoveragePercent;\n    candidate.filters.needleDimensions = Object.fromEntries(",
    "    candidate.filters.needleEvidenceCoverage = needle.evidenceCoveragePercent;\n    candidate.filters.needleChallengerScore = needle.challenger?.score ?? null;\n    candidate.filters.needleChallengerReady = Boolean(needle.challenger?.promotionReady);\n    candidate.filters.needleDimensions = Object.fromEntries(",
)
replace_once(
    'src/pipeline/momentumFilter.js',
    "      version: 'needle-score-v1',",
    "      version: 'needle-score-v2',",
)

replace_once(
    'src/telegram/format.js',
    "  const needleScore = Number(candidate.needle?.score);\n  const lines = [",
    "  const needleScore = Number(candidate.needle?.score);\n  const needleChallengerScore = Number(candidate.needle?.challenger?.score);\n  const lines = [",
    expected=1,
)
replace_once(
    'src/telegram/format.js',
    "    Number.isFinite(needleScore)\n      ? `🪡 Needle: <b>${needleScore.toFixed(1)}/100 · ${escapeHtml(candidate.needle?.classification || 'UNRANKED')}</b> · Evidence ${Number(candidate.needle?.evidenceCoveragePercent || 0).toFixed(0)}%`\n      : null,",
    "    Number.isFinite(needleScore)\n      ? `🪡 Needle: <b>${needleScore.toFixed(1)}/100 · ${escapeHtml(candidate.needle?.classification || 'UNRANKED')}</b> · Evidence ${Number(candidate.needle?.evidenceCoveragePercent || 0).toFixed(0)}%`\n      : null,\n    candidate.needle?.challenger?.suggestionReady && Number.isFinite(needleChallengerScore)\n      ? `🧪 Needle challenger: <b>${needleChallengerScore.toFixed(1)}/100</b> · ${candidate.needle?.challenger?.promotionReady ? 'OOS READY' : 'learning'} · n=${Number(candidate.needle?.challenger?.usableSample || 0)}`\n      : null,",
)

# Remove temporary patch machinery so the final branch diff stays clean.
Path('scripts/_tmp_patch_needle_calibration.py').unlink(missing_ok=True)
Path('.github/workflows/_tmp_patch_needle_calibration.yml').unlink(missing_ok=True)
