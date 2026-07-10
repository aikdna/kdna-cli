const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { error, EXIT } = require('./_common');

function cmdProject(args) {
  const getFlag = (name) => {
    const eq = args.find((a) => a.startsWith(name + '='));
    if (eq) return eq.slice(name.length + 1);
    const idx = args.indexOf(name);
    return idx >= 0 ? args[idx + 1] : null;
  };

  const posArgs = args.filter((a) => !a.startsWith('--'));
  const assetPath = posArgs[0];

  if (!assetPath || args.includes('--help') || args.includes('-h')) {
    process.stderr.write(
      'Usage: kdna project <asset-path> [options]\n' +
        '\n' +
        'Options:\n' +
        '  --shape=<shape>    Projection shape: answer-pattern|compact|scenario|full\n' +
        '                     (default: answer-pattern)\n' +
        '  --task=<task>      Consumption task type\n' +
        '  --context=<json>   Context JSON\n' +
        '  --as=<format>      Output format: json|prompt (default: prompt)\n',
    );
    if (args.includes('--help') || args.includes('-h')) {
      process.exit(0);
    }
    process.exit(EXIT.INPUT_ERROR);
  }

  const shape = getFlag('--shape') || 'answer-pattern';
  const task = getFlag('--task') || 'review';
  const contextRaw = getFlag('--context') || '';
  const as = getFlag('--as') || 'prompt';

  let context = {};
  if (contextRaw) {
    try {
      context = JSON.parse(contextRaw);
    } catch (_) {
      context = { raw: contextRaw };
    }
  }

  const abs = path.resolve(assetPath);
  let projectData = { path: assetPath, exists: fs.existsSync(abs) };

  if (projectData.exists) {
    try {
      const stat = fs.statSync(abs);
      const isFile = stat.isFile();
      const isDir = stat.isDirectory();
      projectData.type = isDir ? 'directory' : 'file';

      if (isDir) {
        const manifestPath = path.join(abs, 'kdna.json');
        if (fs.existsSync(manifestPath)) {
          const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          projectData.manifest = {
            asset_id: m.asset_id || null,
            asset_uid: m.asset_uid || null,
            title: m.title || null,
            version: m.version || null,
            access: m.access || 'public',
            creator: m.creator || null,
          };
        }
      } else if (isFile) {
        projectData.type = 'file';
        try {
          const core = require('@aikdna/kdna-core');
          const format = core.detectContainerFormat(abs);
          projectData.format = format;

          if (format === 'v1') {
            try {
              const m = core.inspect(abs);
              projectData.manifest = {
                asset_id: m.asset_id || null,
                asset_uid: m.asset_uid || null,
                title: m.title || null,
                version: m.version || null,
                access: m.access || 'public',
                creator: m.creator || null,
              };
            } catch (_) {}
          }
        } catch (_) {
          // kdna-core not available or not a kdna file
        }
      }
    } catch (_) {}
  }

  const projection = projectShape(projectData, shape, task, context, assetPath);

  if (as === 'json') {
    console.log(JSON.stringify(projection, null, 2));
  } else {
    console.log(formatPrompt(projection, shape));
  }

  process.exit(EXIT.OK);
}

function tryLoadProjection(absPath, shape) {
  try {
    const core = require('@aikdna/kdna-core');

    // The public Core API loads packaged .kdna assets. Source directories are
    // intentionally handled as manifest-only input here; callers can pack and
    // validate them before requesting a runtime projection.
    if (!fs.statSync(absPath).isFile()) return null;

    const profile = shape === 'scenario' || shape === 'full' ? shape : 'compact';
    const projection = core.loadAuthorized(absPath, { profile, as: 'prompt' });
    const content = projection?.text;
    if (typeof content === 'string' && content.trim()) {
      return { content, profile };
    }
  } catch (_) {}

  return null;
}

function projectShape(projectData, shape, task, context, assetPath) {
  const ts = new Date().toISOString();
  const base = {
    kdna_project: '0.1.0',
    shape,
    task,
    timestamp: ts,
    trace_id: generateTraceId(assetPath, shape, task, ts),
  };

  switch (shape) {
    case 'answer-pattern': {
      const absPath = projectData.path ? path.resolve(projectData.path) : null;
      const loaded = absPath ? tryLoadProjection(absPath, shape) : null;

      if (loaded) {
        return {
          ...base,
          answer: loaded.content,
          reasoning: buildReasoning(projectData, task),
          sources: buildSources(projectData),
          confidence: 'medium',
          alternatives: buildAlternatives(projectData, task),
          _loaded_from_payload: true,
          projection_profile: loaded.profile,
        };
      }

      return {
        ...base,
        answer: projectData.manifest?.title || 'No specific answer determined.',
        reasoning: buildReasoning(projectData, task),
        sources: buildSources(projectData),
        confidence: 'low',
        alternatives: buildAlternatives(projectData, task),
        _loaded_from_payload: false,
      };
    }
    case 'compact':
      return {
        ...base,
        title: projectData.manifest?.title || null,
        summary: projectData.manifest?.title
          ? `KDNA asset: ${projectData.manifest.title}`
          : 'No asset loaded.',
        mode: 'compact',
      };
    case 'scenario':
      return {
        ...base,
        title: projectData.manifest?.title || null,
        context: { task, ...context },
        projection: buildScenarioProjection(projectData, task),
        mode: 'scenario',
      };
    case 'full':
      return {
        ...base,
        asset: projectData.manifest || {},
        meta: {
          path: projectData.path,
          exists: projectData.exists,
          type: projectData.type || 'unknown',
          format: projectData.format || null,
        },
        mode: 'full',
      };
    default:
      return { ...base, error: `Unknown shape: ${shape}` };
  }
}

function buildReasoning(projectData, task) {
  const steps = [];
  if (projectData.manifest?.asset_id) {
    steps.push(`Loaded asset: ${projectData.manifest.asset_id}`);
  }
  if (projectData.manifest?.version) {
    steps.push(`Asset version: ${projectData.manifest.version}`);
  }
  steps.push(`Task: ${task}`);
  if (projectData.manifest?.title) {
    steps.push(`Projection based on: ${projectData.manifest.title}`);
  }
  return steps;
}

function buildSources(projectData) {
  const sources = [];
  if (projectData.manifest?.asset_id) {
    sources.push({
      type: 'kdna-asset',
      id: projectData.manifest.asset_id,
      version: projectData.manifest.version || 'unknown',
    });
  }
  if (projectData.path) {
    sources.push({
      type: 'local-path',
      path: projectData.path,
    });
  }
  return sources;
}

function estimateConfidence(projectData) {
  if (!projectData.manifest) return 'low';
  if (projectData.manifest.access === 'remote') return 'pending';
  if (projectData.manifest.version) return 'medium';
  return 'low';
}

function buildAlternatives(projectData, task) {
  if (!projectData.manifest) {
    return [{ answer: 'No asset found. Check the path or install the asset.', reason: 'missing' }];
  }
  return [
    {
      answer: `Direct load via kdna load ${projectData.path}`,
      reason: 'Alternative: full load with all profiles',
    },
    {
      answer: `Review via kdna plan-load ${projectData.path}`,
      reason: 'Alternative: pre-flight only, no judgment payload',
    },
  ];
}

function buildScenarioProjection(projectData, task) {
  if (!projectData.manifest) {
    return { scenario: 'empty', description: 'No asset found for scenario projection.' };
  }
  return {
    scenario: task,
    asset: projectData.manifest.asset_id || 'unknown',
    version: projectData.manifest.version || 'unknown',
    description: `Scenario projection of ${projectData.manifest.title || 'asset'} for task "${task}"`,
  };
}

function generateTraceId(assetPath, shape, task, timestamp) {
  return crypto
    .createHash('sha256')
    .update(`${assetPath}:${shape}:${task}:${timestamp}`)
    .digest('hex')
    .slice(0, 32);
}

function formatPrompt(projection, shape) {
  const lines = [];
  lines.push(`# kdna project — shape=${shape}`);
  lines.push(`# trace: ${projection.trace_id || 'none'}`);
  lines.push('');

  switch (shape) {
    case 'answer-pattern':
      lines.push('## Answer');
      lines.push(projection.answer || 'No answer.');
      lines.push('');
      if (projection.reasoning && projection.reasoning.length > 0) {
        lines.push('## Reasoning');
        for (const step of projection.reasoning) {
          lines.push('- ' + step);
        }
        lines.push('');
      }
      if (projection.sources && projection.sources.length > 0) {
        lines.push('## Sources');
        for (const s of projection.sources) {
          lines.push(`- [${s.type}] ${s.id || s.path || ''}`);
        }
        lines.push('');
      }
      lines.push(`## Confidence: ${projection.confidence || 'unknown'}`);
      lines.push('');
      if (projection.alternatives && projection.alternatives.length > 0) {
        lines.push('## Alternatives');
        for (const alt of projection.alternatives) {
          lines.push(`- ${alt.answer}`);
          lines.push(`  (${alt.reason})`);
        }
        lines.push('');
      }
      break;

    case 'compact':
      lines.push(projection.summary || 'No summary.');
      lines.push(`Title: ${projection.title || 'untitled'}`);
      break;

    case 'scenario':
      lines.push('## Scenario Projection');
      if (projection.projection) {
        const p = projection.projection;
        lines.push(`- Asset: ${p.asset || 'unknown'}`);
        lines.push(`- Version: ${p.version || 'unknown'}`);
        lines.push(`- ${p.description || ''}`);
      }
      break;

    case 'full':
      lines.push('## Full Projection');
      if (projection.asset) {
        lines.push(`- asset_id: ${projection.asset.asset_id || 'unknown'}`);
        lines.push(`- title: ${projection.asset.title || 'untitled'}`);
        lines.push(`- version: ${projection.asset.version || 'unknown'}`);
        lines.push(`- access: ${projection.asset.access || 'public'}`);
      }
      if (projection.meta) {
        lines.push(`- path: ${projection.meta.path}`);
        lines.push(`- exists: ${projection.meta.exists}`);
        lines.push(`- type: ${projection.meta.type}`);
      }
      break;

    default:
      lines.push(`Unknown shape: ${shape}`);
  }

  return lines.join('\n');
}

module.exports = { cmdProject };
