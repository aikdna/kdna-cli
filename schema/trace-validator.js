const fs = require('node:fs');
const path = require('node:path');

let _schema = null;

const NON_NEGATIVE_INTEGER_COST_FIELDS = [
  'tokens_consumed',
  'chars_consumed',
  'projection_chars',
  'projection_chars_delivered',
  'assets_loaded',
];
const CHARS_CONSUMED_BASES = new Set([
  'not_observed',
  'agent_host_report',
  'independent_measurement',
]);
const PROJECTION_CHAR_DELIVERY_BASES = new Set([
  'runtime_serialized_projection',
  'not_delivered',
  'delivery_unconfirmed',
  'withheld_by_budget',
  'not_reported',
]);

function loadSchema() {
  if (_schema) return _schema;
  const schemaPath = path.join(__dirname, '..', 'schema', 'trace-v1.schema.json');
  _schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  return _schema;
}

function validateTrace(trace) {
  const errors = [];

  if (!trace || typeof trace !== 'object') {
    return { valid: false, errors: ['trace must be an object'] };
  }

  if (trace.kdna_trace !== '1.0.0') {
    errors.push('kdna_trace must be "1.0.0"');
  }

  if (typeof trace.trace_id !== 'string' || !/^[0-9a-f]{32}$/.test(trace.trace_id)) {
    errors.push('trace_id must be a 32-character hex string');
  }

  if (typeof trace.timestamp !== 'string') {
    errors.push('timestamp must be a string');
  }

  if (typeof trace.operation !== 'string' || trace.operation.length === 0) {
    errors.push('operation is required');
  }

  if (!trace.decision || typeof trace.decision !== 'object') {
    errors.push('decision is required and must be an object');
  } else {
    if (!trace.decision.primary || typeof trace.decision.primary !== 'object') {
      errors.push('decision.primary is required');
    }
    if (!Array.isArray(trace.decision.rejected)) {
      errors.push('decision.rejected must be an array');
    }
    if (typeof trace.decision.budget_profile !== 'string') {
      errors.push('decision.budget_profile is required');
    }
  }

  if (trace.cost) {
    for (const field of NON_NEGATIVE_INTEGER_COST_FIELDS) {
      if (
        trace.cost[field] != null &&
        (!Number.isInteger(trace.cost[field]) || trace.cost[field] < 0)
      ) {
        errors.push(`cost.${field} must be a non-negative integer`);
      }
    }
    if (
      trace.cost.chars_consumed_basis != null &&
      (typeof trace.cost.chars_consumed_basis !== 'string' ||
        !CHARS_CONSUMED_BASES.has(trace.cost.chars_consumed_basis))
    ) {
      errors.push(
        `cost.chars_consumed_basis must be one of: ${[...CHARS_CONSUMED_BASES].join(', ')}`,
      );
    }
    if (
      trace.cost.projection_char_delivery_basis != null &&
      (typeof trace.cost.projection_char_delivery_basis !== 'string' ||
        !PROJECTION_CHAR_DELIVERY_BASES.has(trace.cost.projection_char_delivery_basis))
    ) {
      errors.push(
        `cost.projection_char_delivery_basis must be one of: ${[
          ...PROJECTION_CHAR_DELIVERY_BASES,
        ].join(', ')}`,
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = { validateTrace, loadSchema };
