/**
 * Environment-aware preflight for an already deterministic Cluster plan.
 *
 * Routing remains pure in cluster-engine.js. This layer checks the current
 * package store and Core LoadPlan without exposing package paths in the plan.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function normalizePackageName(assetId) {
  const protocolName = String(assetId || '').match(/^kdna:([^:]+):(.+)$/);
  return protocolName ? `@${protocolName[1]}/${protocolName[2]}` : assetId;
}

function checkReference(ref, dependencies = {}) {
  const core = dependencies.core || require('@aikdna/kdna-core');
  const resolveAsset = dependencies.resolveAsset || require('./package-store').resolveAsset;
  const packageName = normalizePackageName(ref.asset_id);
  let resolved = resolveAsset(packageName);

  if (!resolved?.asset_path) {
    const expanded = String(packageName || '').replace(/^~/, process.env.HOME || '');
    const localPath = path.resolve(expanded);
    if (fs.existsSync(localPath)) resolved = { asset_path: localPath };
  }

  if (!resolved?.asset_path) {
    return { available: false, loadable: false, state: 'not_installed', digest_verified: false };
  }

  try {
    const loadPlan = core.planLoad(resolved.asset_path);
    const expectedDigest = ref.digest || null;
    const artifactDigest =
      'sha256:' +
      crypto.createHash('sha256').update(fs.readFileSync(resolved.asset_path)).digest('hex');
    const digestMatches = expectedDigest ? String(expectedDigest) === String(artifactDigest) : null;
    const loadable = loadPlan?.can_load_now === true && loadPlan?.checks?.overall_valid === true;
    return {
      available: true,
      loadable,
      state: loadPlan?.state || 'unknown',
      digest_verified: loadPlan?.checks?.checksums_valid === true && digestMatches !== false,
      declared_digest_matches: digestMatches,
    };
  } catch (_) {
    return { available: true, loadable: false, state: 'invalid', digest_verified: false };
  }
}

function preflightClusterPlan(inputPlan, dependencies = {}) {
  const plan = JSON.parse(JSON.stringify(inputPlan));
  if (plan.mode !== 'cluster' || !plan.selection?.primary) return plan;

  plan.load_plan_ref = plan.load_plan_ref || {};
  plan.load_plan_ref.preflight = { status: 'checked', members: [] };
  plan.warnings = [...(plan.warnings || [])];
  plan.degradations = [...(plan.degradations || [])];

  const primary = plan.selection.primary;
  const primaryCheck = checkReference(primary, dependencies);
  plan.load_plan_ref.preflight.members.push({
    asset_id: primary.asset_id,
    role: 'primary',
    ...primaryCheck,
  });

  if (!primaryCheck.loadable || !primaryCheck.digest_verified) {
    plan.load_plan_ref.status = 'blocked';
    plan.load_plan_ref.issues = [
      ...(plan.load_plan_ref.issues || []),
      {
        code: !primaryCheck.available
          ? 'PRIMARY_UNAVAILABLE'
          : !primaryCheck.loadable
            ? 'PRIMARY_NOT_LOADABLE'
            : 'PRIMARY_DIGEST_MISMATCH',
        severity: 'blocking',
        blocking: true,
        asset_id: primary.asset_id,
      },
    ];
    plan.applicability = { decision: 'blocked', confidence: 'none' };
    plan.budget.assets_consumed = 0;
    return plan;
  }

  const retainedAdvisors = [];
  for (const advisor of plan.selection.advisors || []) {
    const check = checkReference(advisor, dependencies);
    plan.load_plan_ref.preflight.members.push({
      asset_id: advisor.asset_id,
      role: 'advisor',
      required: advisor.required === true,
      ...check,
    });
    if (check.loadable && check.digest_verified) {
      retainedAdvisors.push(advisor);
      continue;
    }

    const optional = advisor.required !== true;
    const canDegrade =
      optional && plan.degradation_policy?.optional_advisor_unavailable === 'continue_with_warning';
    if (canDegrade) {
      plan.selection.rejected = [
        ...(plan.selection.rejected || []),
        {
          asset_id: advisor.asset_id,
          role: 'advisor',
          rejection_reason: 'optional_advisor_unavailable',
          rejection_policy: 'continue_with_warning',
        },
      ];
      plan.degradations.push({
        asset_id: advisor.asset_id,
        role: 'advisor',
        reason: check.state,
        action: 'continued_without_optional_advisor',
      });
      plan.warnings.push(
        `Optional advisor "${advisor.asset_id}" is unavailable; continuing with the verified primary.`,
      );
      continue;
    }

    plan.load_plan_ref.status = 'blocked';
    plan.load_plan_ref.issues = [
      ...(plan.load_plan_ref.issues || []),
      {
        code: optional ? 'OPTIONAL_ADVISOR_UNAVAILABLE' : 'REQUIRED_ADVISOR_UNAVAILABLE',
        severity: 'blocking',
        blocking: true,
        asset_id: advisor.asset_id,
      },
    ];
    plan.applicability = { decision: 'blocked', confidence: 'none' };
    plan.budget.assets_consumed = 0;
    return plan;
  }

  plan.selection.advisors = retainedAdvisors;
  plan.budget.assets_consumed = 1 + retainedAdvisors.length;
  plan.load_plan_ref.status = 'ready';
  plan.load_plan_ref.preflight.status = plan.degradations.length ? 'degraded' : 'passed';
  return plan;
}

module.exports = { checkReference, preflightClusterPlan };
