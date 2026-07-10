/**
 * context-budget.js — Bundle context budget reporting (Story 8)
 *
 * Computes a context_budget_report for kdna plan-load output when a
 * Bundle manifest declares a context_budget. Answers:
 *
 *   "Do the resolved components fit within the declared token budget?"
 *
 * Token estimates are heuristic: they use the bundle's declared
 * per_component_estimate_tokens (default: 1000 tokens/component for the
 * compact load profile). Actual cost depends on domain content and the
 * profile used at load time.
 *
 * Strategies:
 *   warn                       — proceed; emit warning on stderr
 *   truncate_lowest_priority   — caller should drop lowest-priority
 *                                components to fit within budget
 *   error                      — block load (plan state → invalid)
 */

'use strict';

const DEFAULT_TOKENS_PER_COMPONENT = 1000;

/**
 * Compute a context_budget_report object to be merged into a LoadPlan.
 *
 * @param {object} budgetDecl  The context_budget object from the Bundle manifest.
 *   Required: budgetDecl.max_tokens (integer)
 *   Optional: budgetDecl.strategy ('warn'|'truncate_lowest_priority'|'error')
 *   Optional: budgetDecl.per_component_estimate_tokens (integer)
 * @param {Array}  resolvedDeps  Array of resolved dependency objects from planLoad.
 *   Each entry has: { name, version, path }
 * @returns {object} context_budget_report
 */
function computeContextBudget(budgetDecl, resolvedDeps) {
  const maxTokens = budgetDecl.max_tokens;
  const strategy = budgetDecl.strategy || 'warn';
  const perComponentTokens =
    budgetDecl.per_component_estimate_tokens || DEFAULT_TOKENS_PER_COMPONENT;

  const components = (resolvedDeps || []).map((dep, i) => ({
    name: dep.name,
    version: dep.version || null,
    estimated_tokens: perComponentTokens,
    estimation_basis: budgetDecl.per_component_estimate_tokens
      ? 'bundle_declared_per_component'
      : 'default_compact_profile',
    load_order: i + 1,
  }));

  const totalEstimatedTokens = components.reduce((sum, c) => sum + c.estimated_tokens, 0);
  const overBudget = totalEstimatedTokens > maxTokens;

  let budgetAction = 'none';
  if (overBudget) {
    if (strategy === 'error') {
      budgetAction = 'block_load';
    } else if (strategy === 'truncate_lowest_priority') {
      budgetAction = 'truncate_lowest_priority_components';
    } else {
      budgetAction = 'warn_only';
    }
  }

  return {
    declared_max_tokens: maxTokens,
    strategy,
    total_estimated_tokens: totalEstimatedTokens,
    over_budget: overBudget,
    budget_action: budgetAction,
    components,
    estimation_note:
      'Token estimates use bundle-declared per_component_estimate_tokens or the ' +
      'default (1000 tokens/component, compact profile). Actual cost depends on ' +
      'domain content and the load profile used at runtime.',
  };
}

module.exports = { computeContextBudget, DEFAULT_TOKENS_PER_COMPONENT };
