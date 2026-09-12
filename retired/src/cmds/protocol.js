const { readFileSync } = require('fs');
const path = require('path');
const { error, EXIT } = require('./_common');

const SCHEMA_DIR = path.join(
  path.dirname(require.resolve('@aikdna/kdna-core/package.json')),
  '..',
  '..',
  'specs',
);

const SCHEMAS = {
  'artifact-envelope': 'artifact-envelope.schema.json',
  'stage-definition': 'stage-definition.schema.json',
  'fidelity-result': 'fidelity-result.schema.json',
  'product-runtime': 'product-runtime.schema.json',
};

function validate(args) {
  const file = args.filter((a) => !a.startsWith('--'))[1];
  const schemaName = args.includes('--schema') ? args[args.indexOf('--schema') + 1] : null;

  if (!file) {
    error('Usage: kdna protocol validate <file.json> [--schema <name>]', EXIT.INPUT_ERROR);
  }

  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    error(`Failed to read or parse ${file}: ${e.message}`, EXIT.INPUT_ERROR);
  }

  const schemasToCheck = schemaName ? [schemaName] : Object.keys(SCHEMAS);
  let passed = 0;
  let failed = 0;

  for (const name of schemasToCheck) {
    const schemaFile = SCHEMAS[name];
    if (!schemaFile) {
      error(
        `Unknown schema: ${name}. Available: ${Object.keys(SCHEMAS).join(', ')}`,
        EXIT.INPUT_ERROR,
      );
    }

    try {
      const schemaPath = path.join(SCHEMA_DIR, schemaFile);
      const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
      const { validate: ajvValidate } = loadAjv();
      const valid = ajvValidate(schema, data);
      if (valid) {
        console.log(`  ✓ ${name} (${schemaFile})`);
        passed++;
      } else {
        console.log(`  ✗ ${name} (${schemaFile})`);
        failed++;
      }
    } catch (e) {
      console.log(`  ✗ ${name}: ${e.message}`);
      failed++;
    }
  }

  if (failed > 0) {
    error(`Validation failed: ${failed}/${passed + failed} schema(s)`, EXIT.VALIDATION_FAILED);
  }
  console.log(`Validation passed: ${passed}/${passed + failed} schema(s)`);
}

function inspect(args) {
  const file = args.filter((a) => !a.startsWith('--'))[1];
  if (!file) {
    error('Usage: kdna protocol inspect <file.json>', EXIT.INPUT_ERROR);
  }

  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    error(`Failed to read ${file}: ${e.message}`, EXIT.INPUT_ERROR);
  }

  if (args.includes('--json')) {
    console.log(JSON.stringify(summarize(data), null, 2));
  } else {
    const summary = summarize(data);
    console.log(`Type: ${summary.type}`);
    if (summary.artifact_type) console.log(`Artifact: ${summary.artifact_type}`);
    if (summary.generator)
      console.log(`Generator: ${summary.generator.engine} v${summary.generator.version}`);
    if (summary.source_kdna_count) console.log(`KDNA domains: ${summary.source_kdna_count}`);
    if (summary.stages_count) console.log(`Stages: ${summary.stages_count}`);
    if (summary.quality) console.log(`Quality: ${summary.quality}`);
    if (summary.fidelity) console.log(`Fidelity: ${summary.fidelity}`);
    if (summary.review) console.log(`Review: ${summary.review}`);
  }
}

function summarize(data) {
  const summary = { type: 'unknown' };

  if (data.format === 'kdna-pipeline') {
    summary.type = 'pipeline';
    summary.stages_count = data.stages?.length || 0;
    if (data.pipeline_kdna) summary.kdna_mode = data.pipeline_kdna.mode;
    if (data.artifacts?.enabled) summary.artifacts_enabled = true;
    if (data.trace?.enabled) summary.trace_enabled = true;
  } else if (data.artifact_id && data.artifact_type) {
    summary.type = 'artifact';
    summary.artifact_type = data.artifact_type;
    if (data.generator) summary.generator = data.generator;
    summary.source_kdna_count = data.source_kdna?.length || 0;
    if (data.quality?.overall_result) summary.quality = data.quality.overall_result;
    if (data.review?.status) summary.review = data.review.status;
    if (data.quality?.fidelity?.score !== undefined)
      summary.fidelity = `${data.quality.fidelity.score} (v${data.quality.fidelity.protocol_version})`;
  } else if (
    data.fidelity_id &&
    (data.protocol_version !== undefined || data.protocolVersion !== undefined)
  ) {
    summary.type = 'fidelity_result';
    summary.overall_score = data.overall_score ?? data.overallScore;
    summary.passed = data.passed;
    const cmp = data.comparison;
    if (cmp) {
      if (cmp.blind_delta !== undefined) summary.blind_delta = cmp.blind_delta;
      else if (cmp.blindDelta !== undefined) summary.blind_delta = cmp.blindDelta;
    }
  } else if (data.format === 'kdna-product-runtime') {
    summary.type = 'product_runtime';
    if (data.schedule) summary.schedule_type = data.schedule.type;
    if (data.selection) summary.selection_type = data.selection.type;
  }

  return summary;
}

let _ajv = null;
function loadAjv() {
  if (_ajv) return _ajv;
  try {
    const Ajv = require('ajv');
    const addFormats = require('ajv-formats');
    const ajv = new Ajv({ allErrors: true, strict: false, validateSchema: false });
    addFormats(ajv);
    _ajv = { ajv, validate: (schema, data) => ajv.validate(schema, data) };
  } catch {
    _ajv = {
      validate: () => {
        throw new Error('ajv not installed. Run: npm install ajv ajv-formats');
      },
    };
  }
  return _ajv;
}

function cmdProtocol(args) {
  const sub = args[1];
  const rest = args.slice(1);

  switch (sub) {
    case 'validate':
      validate(rest);
      break;
    case 'inspect':
      inspect(rest);
      break;
    default:
      error(
        'Usage: kdna protocol <validate|inspect> [file]\n' +
          '  kdna protocol validate <file.json> [--schema <name>]\n' +
          '  kdna protocol inspect <file.json> [--json]\n' +
          '\nSchemas: ' +
          Object.keys(SCHEMAS).join(', '),
        EXIT.INPUT_ERROR,
      );
  }
}

module.exports = { cmdProtocol };
