const fs = require("node:fs");
const path = require("node:path");

let _schema = null;

function loadSchema() {
  if (_schema) return _schema;
  const schemaPath = path.join(__dirname, "..", "schema", "trace-v1.schema.json");
  _schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  return _schema;
}

function validateTrace(trace) {
  const errors = [];

  if (!trace || typeof trace !== "object") {
    return { valid: false, errors: ["trace must be an object"] };
  }

  if (trace.kdna_trace !== "1.0.0") {
    errors.push("kdna_trace must be \"1.0.0\"");
  }

  if (typeof trace.trace_id !== "string" || !/^[0-9a-f]{32}$/.test(trace.trace_id)) {
    errors.push("trace_id must be a 32-character hex string");
  }

  if (typeof trace.timestamp !== "string") {
    errors.push("timestamp must be a string");
  }

  if (typeof trace.operation !== "string" || trace.operation.length === 0) {
    errors.push("operation is required");
  }

  if (!trace.decision || typeof trace.decision !== "object") {
    errors.push("decision is required and must be an object");
  } else {
    if (!trace.decision.primary || typeof trace.decision.primary !== "object") {
      errors.push("decision.primary is required");
    }
    if (!Array.isArray(trace.decision.rejected)) {
      errors.push("decision.rejected must be an array");
    }
    if (typeof trace.decision.budget_profile !== "string") {
      errors.push("decision.budget_profile is required");
    }
  }

  if (trace.cost) {
    if (trace.cost.tokens_consumed != null && typeof trace.cost.tokens_consumed !== "number") {
      errors.push("cost.tokens_consumed must be a number");
    }
    if (trace.cost.chars_consumed != null && typeof trace.cost.chars_consumed !== "number") {
      errors.push("cost.chars_consumed must be a number");
    }
    if (trace.cost.assets_loaded != null && typeof trace.cost.assets_loaded !== "number") {
      errors.push("cost.assets_loaded must be a number");
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = { validateTrace, loadSchema };
