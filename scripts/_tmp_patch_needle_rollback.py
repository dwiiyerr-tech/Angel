from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"guard failed {path}: expected 1 occurrence, found {count}")
    p.write_text(text.replace(old, new))

replace_once(
    'src/controlPlane/registry.js',
    """    for (const key of CONTROL_PLANE_PROPOSABLE_SETTINGS) {\n      if (target.config?.settings?.[key] !== undefined) setSetting(key, target.config.settings[key]);\n    }\n    const actualHash = hashJson(currentManagedConfig());""",
    """    for (const key of CONTROL_PLANE_PROPOSABLE_SETTINGS) {\n      if (target.config?.settings?.[key] !== undefined) {\n        setSetting(key, target.config.settings[key]);\n      } else {\n        // A child config may introduce a newly managed setting (for example\n        // Needle weights) that did not exist in its parent. Rollback must\n        // restore absence as well as values or the parent config hash cannot\n        // be reconstructed exactly. This runs only after forcing PAPER mode.\n        db.prepare('DELETE FROM settings WHERE key = ?').run(key);\n      }\n    }\n    const actualHash = hashJson(currentManagedConfig());""",
)

replace_once(
    'test/unit/test_strategy_control_plane.js',
    """cleanControlPlane();\nresetControlPlaneSchemaForTests();\nensureControlPlaneSchema();\n\nconst originalMode = setting('trading_mode', 'dry_run');""",
    """cleanControlPlane();\nresetControlPlaneSchemaForTests();\nensureControlPlaneSchema();\n// Simulate upgrading an older active config that predates Needle v2. The\n// parent legitimately has no needle_weights_json key.\ndb.prepare(\"DELETE FROM settings WHERE key = 'needle_weights_json'\").run();\n\nconst originalMode = setting('trading_mode', 'dry_run');""",
)

replace_once(
    'test/unit/test_strategy_control_plane.js',
    """assert.equal(activeConfigVersion().version, 1);\n\nconst analyst = deterministicStrategyAnalysis({""",
    """assert.equal(activeConfigVersion().version, 1);\n\n// Regression: a child may introduce a setting that the parent did not have.\n// Promotion writes it; rollback must delete it again to reconstruct the exact\n// immutable parent hash.\nconst needleWeights = JSON.stringify({\n  safety: 20, devQuality: 10, holderDistribution: 10, organicFlow: 11,\n  liquidityStructure: 10, narrative: 7, earlyAsymmetry: 13,\n  runnerProbability: 12, expectedR: 7,\n});\nconst needleProposal = createStrategyProposal({\n  changes: [{ key: 'needle_weights_json', value: needleWeights, rationale: 'rollback regression' }],\n  evidence: { ...evidence, totalClosed: 100 },\n  analysis: { rationale: 'rollback newly introduced setting' },\n  source: 'unit_test',\n  analystMode: 'deterministic',\n  actor: 'unit_test',\n});\napproveProposalForTest(needleProposal.proposalId, 'unit_test');\ndb.prepare(\"UPDATE strategy_proposals SET status = 'promotion_ready' WHERE id = ?\").run(needleProposal.proposalId);\ndb.prepare(\"UPDATE config_versions SET status = 'promotion_ready' WHERE version = ?\").run(needleProposal.proposedVersion);\nconst needlePromoted = promoteProposal(needleProposal.proposalId, 'unit_test');\nassert.equal(needlePromoted.version, needleProposal.proposedVersion);\nassert.ok(setting('needle_weights_json', ''), 'promotion must persist Needle weights');\nconst needleRolledBack = rollbackToParent(1, 'needle setting absence regression', 'unit_test');\nassert.equal(needleRolledBack.version, 1);\nassert.equal(setting('needle_weights_json', ''), '', 'rollback must restore parent absence, not leave child-only setting behind');\n\nconst analyst = deterministicStrategyAnalysis({""",
)

Path('scripts/_tmp_patch_needle_rollback.py').unlink(missing_ok=True)
Path('.github/workflows/_tmp_patch_needle_rollback.yml').unlink(missing_ok=True)
