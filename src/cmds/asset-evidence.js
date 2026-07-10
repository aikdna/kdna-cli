const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { error, EXIT } = require('./_common');

function cmdAssetEvidence(args) {
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
      'Usage: kdna asset-evidence <asset-path> [options]\n' +
        '\n' +
        'Options:\n' +
        '  --out=<path>           Output evidence manifest path\n' +
        '  --as=<json|md>         Format (default: json)\n',
    );
    if (args.includes('--help') || args.includes('-h')) {
      process.exit(0);
    }
    process.exit(EXIT.INPUT_ERROR);
  }

  const outPath = getFlag('--out');
  const as = getFlag('--as') || 'json';

  const abs = path.resolve(assetPath);
  const evidence = buildEvidence(abs);

  const output =
    as === 'json' ? JSON.stringify(evidence, null, 2) : formatEvidenceMarkdown(evidence);

  if (outPath) {
    fs.writeFileSync(path.resolve(outPath), output + '\n');
  } else {
    process.stdout.write(output + '\n');
  }
}

function buildEvidence(abs) {
  let manifest = null;
  let isDir = false;
  const sidecarFiles = [];
  const checksums = {};

  try {
    const stat = fs.statSync(abs);
    isDir = stat.isDirectory();
  } catch (_) {}

  if (isDir) {
    const mfPath = path.join(abs, 'kdna.json');
    if (fs.existsSync(mfPath)) {
      try {
        manifest = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
      } catch (_) {}
    }

    for (const entry of fs.readdirSync(abs)) {
      if (fs.statSync(path.join(abs, entry)).isFile()) {
        sidecarFiles.push(entry);
        try {
          const content = fs.readFileSync(path.join(abs, entry));
          const hash = crypto.createHash('sha256').update(content).digest('hex');
          checksums[entry] = `sha256:${hash}`;
        } catch (_) {}
      }
    }
  } else {
    try {
      const core = require('@aikdna/kdna-core');
      const m = core.inspect(abs);
      if (m) manifest = m;
      sidecarFiles.push(path.basename(abs));
      try {
        const content = fs.readFileSync(abs);
        const hash = crypto.createHash('sha256').update(content).digest('hex');
        checksums[path.basename(abs)] = `sha256:${hash}`;
      } catch (_) {}
    } catch (_) {
      sidecarFiles.push(path.basename(abs));
    }
  }

  return {
    kdna_asset_evidence: '0.1.0',
    asset: {
      id: manifest?.asset_id || manifest?.asset_uid || path.basename(abs),
      version: manifest?.version || 'unknown',
      access: manifest?.access || 'public',
    },
    integrity: {
      checksums,
      sidecar_files: sidecarFiles,
    },
    compatibility: {
      kdna_core_version: '>=0.15.0',
      kdna_cli_version: getCliVersion(),
    },
    regression_fixtures: {
      available: false,
      note: 'Public-safe fixtures are not yet available for this asset.',
    },
    evidence: {
      generated_at: new Date().toISOString(),
      generated_by: 'kdna-cli asset-evidence',
      tool_version: getCliVersion(),
    },
  };
}

function getCliVersion() {
  try {
    return require(path.join(__dirname, '..', '..', 'package.json')).version;
  } catch (_) {
    return 'unknown';
  }
}

function formatEvidenceMarkdown(evidence) {
  const lines = [];
  const a = evidence.asset;

  lines.push('# KDNA Asset Evidence');
  lines.push(`- **Asset ID:** ${a.id}`);
  lines.push(`- **Version:** ${a.version}`);
  lines.push(`- **Access:** ${a.access}`);
  lines.push(`- **Generated:** ${evidence.evidence.generated_at}`);
  lines.push(`- **Tool:** ${evidence.evidence.tool_version}`);
  lines.push('');

  lines.push('## Integrity');
  lines.push(`- **Sidecar files:** ${evidence.integrity.sidecar_files.length}`);
  for (const f of evidence.integrity.sidecar_files) {
    lines.push(`  - ${f}`);
  }
  lines.push('');

  lines.push('## Compatibility');
  lines.push(`- **kdna-core:** ${evidence.compatibility.kdna_core_version}`);
  lines.push(`- **kdna-cli:** ${evidence.compatibility.kdna_cli_version}`);
  lines.push('');

  lines.push('## Regression Fixtures');
  lines.push(`- **Available:** ${evidence.regression_fixtures.available ? 'yes' : 'no'}`);
  lines.push(`- **Note:** ${evidence.regression_fixtures.note}`);
  lines.push('');

  lines.push('## Checksums');
  if (Object.keys(evidence.integrity.checksums).length > 0) {
    for (const [file, hash] of Object.entries(evidence.integrity.checksums)) {
      lines.push(`- **${file}:** ${hash}`);
    }
  } else {
    lines.push('- No checksums computed');
  }

  return lines.join('\n');
}

module.exports = { cmdAssetEvidence };
