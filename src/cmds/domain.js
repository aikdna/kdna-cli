const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { error, readJson, writeJson, EXIT } = require('./_common');
const KDNA_DOMAIN_FILES = new Set([
  'KDNA_Core.json',
  'KDNA_Patterns.json',
  'KDNA_Scenarios.json',
  'KDNA_Cases.json',
  'KDNA_Reasoning.json',
  'KDNA_Evolution.json',
]);

function readKDNAContentFiles(abs) {
  const dataMap = {};
  const parseErrors = [];
  for (const f of fs.readdirSync(abs).filter((name) => KDNA_DOMAIN_FILES.has(name))) {
    try {
      dataMap[f] = JSON.parse(fs.readFileSync(path.join(abs, f), 'utf8'));
    } catch (e) {
      dataMap[f] = null;
      parseErrors.push(`${f}: ${e.message}`);
    }
  }
  return { dataMap, parseErrors };
}

function loadSchemaMap(schemaDir) {
  const fileToSchema = {
    'KDNA_Core.json': 'KDNA_Core.schema.json',
    'KDNA_Patterns.json': 'KDNA_Patterns.schema.json',
    'KDNA_Scenarios.json': 'KDNA_Scenarios.schema.json',
    'KDNA_Cases.json': 'KDNA_Cases.schema.json',
    'KDNA_Reasoning.json': 'KDNA_Reasoning.schema.json',
    'KDNA_Evolution.json': 'KDNA_Evolution.schema.json',
  };

  const schemaMap = {};
  const loadedSchemas = [];
  const missingSchemas = [];
  for (const schemaFile of Object.values(fileToSchema)) {
    const schemaPath = path.join(schemaDir, schemaFile);
    if (fs.existsSync(schemaPath)) {
      try {
        schemaMap[schemaFile] = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
        loadedSchemas.push(schemaFile);
      } catch {
        missingSchemas.push(schemaFile);
      }
    } else {
      missingSchemas.push(schemaFile);
    }
  }

  return { schemaMap, loadedSchemas, missingSchemas };
}

function validateDomainDirectory(abs, schemaMap, schemaOnly) {
  const { lintDomain, validateDomainSchema, validateCrossFile } = require('@aikdna/kdna-core');
  const { dataMap, parseErrors } = readKDNAContentFiles(abs);
  const errors = parseErrors.map((msg) => `JSON parse error in ${msg}`);
  const warnings = [];

  if (!schemaOnly) {
    const lintResult = lintDomain(dataMap);
    errors.push(...lintResult.errors);
    warnings.push(...lintResult.warnings);
  }

  const schemaResult = validateDomainSchema(dataMap, schemaMap);
  errors.push(...schemaResult.errors);
  warnings.push(...schemaResult.warnings);

  const crossResult = validateCrossFile(dataMap);
  errors.push(...crossResult.errors);
  warnings.push(...crossResult.warnings);

  return {
    path: abs,
    valid: errors.length === 0,
    files: Object.keys(dataMap).filter((k) => dataMap[k]).length,
    errors,
    warnings,
  };
}

function isClusterDirectory(abs) {
  const manifest = readJson(path.join(abs, 'kdna.json'));
  return !!(
    manifest?.cluster ||
    fs.existsSync(path.join(abs, 'KDNA_Cluster.json')) ||
    fs.existsSync(path.join(abs, 'cluster_manifest.json'))
  );
}

function validateClusterDirectory(abs, schemaMap, schemaOnly) {
  const manifest = readJson(path.join(abs, 'kdna.json')) || {};
  const clusterManifest = readJson(path.join(abs, 'KDNA_Cluster.json')) || {};
  const fallbackManifest = readJson(path.join(abs, 'cluster_manifest.json')) || {};
  const subDomains = manifest.sub_domains || fallbackManifest.domains || [];
  const errors = [];
  const warnings = [];

  if (!Array.isArray(subDomains) || subDomains.length === 0) {
    errors.push('Cluster has no sub_domains/domains list to validate');
  }

  const domains = [];
  for (const name of subDomains) {
    const domainPath = path.join(abs, name);
    if (!fs.existsSync(domainPath) || !fs.statSync(domainPath).isDirectory()) {
      errors.push(`Cluster sub-domain not found: ${name}`);
      continue;
    }
    const result = validateDomainDirectory(domainPath, schemaMap, schemaOnly);
    domains.push({ name, ...result });
    warnings.push(...result.warnings.map((w) => `${name}: ${w}`));
    errors.push(...result.errors.map((e) => `${name}: ${e}`));
  }

  if (!manifest.cluster && !clusterManifest.name && !fallbackManifest.name) {
    warnings.push('Cluster metadata is minimal: no cluster marker or cluster name found');
  }

  return {
    path: abs,
    valid: errors.length === 0,
    cluster: true,
    domains,
    files: domains.reduce((sum, d) => sum + d.files, 0),
    errors,
    warnings,
  };
}

// ─── Validate ────────────────────────────────────────────────────────

function cmdValidate(dir, schemaOnly, jsonMode = false) {
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    error(`Not a directory: ${abs}`, EXIT.INPUT_ERROR);
  }

  // Resolve schemas from @aikdna/kdna-core package
  const SCHEMA_DIR = path.join(
    path.dirname(require.resolve('@aikdna/kdna-core/package.json')),
    'schema',
  );

  const { schemaMap, loadedSchemas, missingSchemas } = loadSchemaMap(SCHEMA_DIR);

  if (missingSchemas.length) {
    console.log(
      `  Note: ${missingSchemas.length} schema file(s) not found (optional file schemas): ${missingSchemas.join(', ')}`,
    );
    console.log(`  Schema dir: ${SCHEMA_DIR}`);
  }

  const result = isClusterDirectory(abs)
    ? validateClusterDirectory(abs, schemaMap, schemaOnly)
    : validateDomainDirectory(abs, schemaMap, schemaOnly);
  const { errors, warnings } = result;
  const validCount = result.files;
  const schemaInfo = schemaOnly
    ? ` (schema-only mode, ${loadedSchemas.length} schemas loaded)`
    : '';

  if (jsonMode) {
    const payload = {
      path: abs,
      valid: errors.length === 0,
      files: validCount,
      cluster: !!result.cluster,
      domains: result.domains,
      schemas_loaded: loadedSchemas.length,
      schema_only: schemaOnly,
      errors,
      warnings,
    };
    console.log(JSON.stringify(payload, null, 2));
    process.exit(errors.length ? EXIT.VALIDATION_FAILED : EXIT.OK);
  }

  if (warnings.length) {
    console.log('Warnings:');
    warnings.forEach((w) => console.log(`  - ${w}`));
  }
  if (errors.length) {
    console.error('Errors:');
    errors.forEach((e) => console.error(`  - ${e}`));
    process.exit(EXIT.VALIDATION_FAILED);
  }

  if (result.cluster) {
    console.log(
      `✓ KDNA cluster valid: ${abs} (${result.domains.length} domains, ${validCount} KDNA files, schema OK${schemaInfo})`,
    );
  } else {
    console.log(`✓ KDNA domain valid: ${abs} (${validCount} files, schema OK${schemaInfo})`);
  }
}

// ─── Pack / Unpack (.kdna ZIP container) ──────────────────────────────────

function cmdPack(dir, outputDir) {
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    error(`Not a directory: ${abs}`, EXIT.INPUT_ERROR);
  }

  const core = readJson(path.join(abs, 'KDNA_Core.json'));
  const pat = readJson(path.join(abs, 'KDNA_Patterns.json'));
  if (!core) error('KDNA_Core.json not found or invalid');
  if (!pat) error('KDNA_Patterns.json not found or invalid');

  // Human Lock Gate — check judgment-class cards before packing
  const { checkHumanLock } = require('../publish');
  const hl = checkHumanLock(abs);
  if (!hl.passed) {
    console.error('Human Lock Gate: BLOCKED');
    for (const issue of hl.issues) {
      console.error(`  ✗ ${issue}`);
    }
    console.error('Judgment-class cards must be locked with valid Human Lock before packing.');
    console.error('Use kdna publish --check for details.');
    process.exit(EXIT.HUMAN_LOCK_REQUIRED);
  }

  const domainName = core.meta?.domain || path.basename(abs);

  // Ensure kdna.json manifest exists (generate if missing)
  let manifest = readJson(path.join(abs, 'kdna.json'));
  if (!manifest) {
    const jsonCount = fs
      .readdirSync(abs)
      .filter((f) => f.endsWith('.json') && f !== 'kdna.json').length;
    manifest = {
      kdna_spec: '1.0-rc',
      name: domainName,
      version: core.meta?.version || '0.1.0',
      status: 'experimental',
      access: 'open',
      language: 'en',
      author: { name: '', id: '' },
      license: { type: 'CC-BY-4.0' },
      description: core.meta?.purpose || `${domainName} domain cognition`,
      file_count: jsonCount,
      created: core.meta?.created || new Date().toISOString().slice(0, 10),
      updated: new Date().toISOString().slice(0, 10),
    };
    writeJson(path.join(abs, 'kdna.json'), manifest);
  }

  // Create ZIP container — try python3, then zip command, then Node.js native
  const outName = `${domainName}.kdna`;
  const outPath = outputDir ? path.join(outputDir, outName) : path.join(process.cwd(), outName);
  if (outputDir && !fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  let packed = false;

  // Strategy 1: python3 zipfile (built-in on macOS, most Linux) — use temp file
  const tmpPyFile = path.join(
    fs.existsSync('/tmp') ? '/tmp' : require('os').tmpdir(),
    `kdna-pack-${Date.now()}.py`,
  );
  try {
    const pyScript = `import zipfile, os
src = ${JSON.stringify(abs)}
out = ${JSON.stringify(outPath)}
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as zf:
    for f in sorted(os.listdir(src)):
        fp = os.path.join(src, f)
        if os.path.isfile(fp) and (f.endswith('.json') or f in ('README.md', 'LICENSE', 'kdna.json')):
            zf.write(fp, f)
`;
    fs.writeFileSync(tmpPyFile, pyScript);
    execSync(`python3 ${tmpPyFile}`, { stdio: 'pipe' });
    packed = true;
  } catch {
    /* Strategy 1 failed, try next */
  } finally {
    try {
      fs.unlinkSync(tmpPyFile);
    } catch {
      /* cleanup */
    }
  }

  // Strategy 2: system zip command
  if (!packed) {
    const cwd = process.cwd();
    try {
      process.chdir(abs);
      execSync(
        `zip -q -r "${outPath}" *.json README.md LICENSE 2>/dev/null || zip -q -r "${outPath}" *.json`,
        { stdio: 'pipe' },
      );
      process.chdir(cwd);
      packed = true;
    } catch {
      process.chdir(cwd);
    }
  }

  // #22: Strategy 3 — Node.js native ZIP (no external dependencies)
  if (!packed) {
    try {
      createNodeZip(abs, outPath);
      packed = true;
    } catch {
      /* last attempt failed */
    }
  }

  if (!packed) {
    const platform = process.platform;
    const hints = {
      darwin: 'macOS includes python3 — ensure it is in PATH.',
      linux: 'Install python3 or zip: apt install python3 / yum install python3 / apk add python3',
      win32: 'Install python3 from python.org, or use WSL.',
    };
    error(`Cannot create ZIP.\n${hints[platform] || 'Install python3 or zip command.'}`);
  }

  const fileCount = manifest.file_count || 0;
  console.log(`✓ Packed: ${outPath}`);
  console.log(`  Domain: ${domainName} v${manifest.version}`);
  console.log(`  Files: ${fileCount} KDNA JSONs`);
  console.log(`  Container: ZIP (DEFLATE)`);
}

// #22: Node.js-native ZIP creator (zero dependencies, fallback when python3/zip unavailable)
function createNodeZip(srcDir, outPath) {
  const zlib = require('zlib');
  const files = fs
    .readdirSync(srcDir)
    .filter((f) => f.endsWith('.json'))
    .concat(['README.md', 'LICENSE'].filter((f) => fs.existsSync(path.join(srcDir, f))));

  const centralDir = [];
  const fileData = [];
  let offset = 0;

  for (const f of files) {
    const raw = fs.readFileSync(path.join(srcDir, f));
    const crc = crc32(raw);
    const compressed = zlib.deflateRawSync(raw);
    const useStore = compressed.length >= raw.length;

    const nameBytes = Buffer.from(f, 'utf8');
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // local file header signature
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0x0800, 6); // general purpose bit flag (UTF-8)
    localHeader.writeUInt16LE(useStore ? 0 : 8, 8); // compression method: stored or deflated
    // skip mod time, mod date
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(useStore ? raw.length : compressed.length, 18); // compressed size
    localHeader.writeUInt32LE(raw.length, 22); // uncompressed size
    localHeader.writeUInt16LE(nameBytes.length, 26);

    const stored = useStore ? raw : compressed;

    fileData.push(Buffer.concat([localHeader, nameBytes, stored]));
    offset += localHeader.length + nameBytes.length + stored.length;

    // Central directory entry
    const cdEntry = Buffer.alloc(46);
    cdEntry.writeUInt32LE(0x02014b50, 0); // central dir signature
    cdEntry.writeUInt16LE(20, 4); // version made by
    cdEntry.writeUInt16LE(20, 6); // version needed
    cdEntry.writeUInt16LE(0x0800, 8); // UTF-8
    cdEntry.writeUInt16LE(useStore ? 0 : 8, 10);
    cdEntry.writeUInt32LE(crc, 16);
    cdEntry.writeUInt32LE(useStore ? raw.length : compressed.length, 20);
    cdEntry.writeUInt32LE(raw.length, 24);
    cdEntry.writeUInt16LE(nameBytes.length, 28);
    cdEntry.writeUInt32LE(offset - stored.length - nameBytes.length - localHeader.length, 42);
    centralDir.push(Buffer.concat([cdEntry, nameBytes]));
  }

  const cdOffset = offset;
  const cdSize = centralDir.reduce((s, e) => s + e.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with CD
  eocd.writeUInt16LE(files.length, 8); // entries on disk
  eocd.writeUInt16LE(files.length, 10); // total entries
  eocd.writeUInt32LE(cdSize, 12); // CD size
  eocd.writeUInt32LE(cdOffset, 16); // CD offset
  eocd.writeUInt16LE(0, 20); // comment length

  const all = Buffer.concat([...fileData, ...centralDir, eocd]);
  fs.writeFileSync(outPath, all);
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function cmdUnpack(filePath, force) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    error(`Not a file: ${abs}`, EXIT.INPUT_ERROR);
  }
  if (!abs.endsWith('.kdna')) {
    error(`Not a .kdna file: ${abs}`, EXIT.INPUT_ERROR);
  }

  const domainName = path.basename(abs, '.kdna');
  const outDir = path.join(path.dirname(abs), domainName);

  if (fs.existsSync(outDir)) {
    if (!force)
      error(`Directory already exists: ${outDir}\nUse --force to overwrite.`, EXIT.INPUT_ERROR);
    fs.rmSync(outDir, { recursive: true, force: true });
  }

  fs.mkdirSync(outDir, { recursive: true });

  // Unzip using python3 zipfile (built-in) — use temp file to avoid -c multiline escaping issues
  const tmpUnpackPy = path.join(
    fs.existsSync('/tmp') ? '/tmp' : require('os').tmpdir(),
    `kdna-unpack-${Date.now()}.py`,
  );
  try {
    const script = `import zipfile, os
zf = zipfile.ZipFile(${JSON.stringify(abs)}, 'r')
zf.extractall(${JSON.stringify(outDir)})
zf.close()
`;
    fs.writeFileSync(tmpUnpackPy, script);
    execSync(`python3 ${tmpUnpackPy}`, { stdio: 'pipe' });
  } catch {
    // Fallback: use system unzip
    try {
      execSync(`unzip -q -o "${abs}" -d "${outDir}"`, { stdio: 'pipe' });
    } catch {
      error('Cannot unpack ZIP. Install python3 or unzip command.');
    }
  } finally {
    try {
      fs.unlinkSync(tmpUnpackPy);
    } catch {
      /* cleanup */
    }
  }

  console.log(`✓ Unpacked: ${outDir}`);
  const files = fs.readdirSync(outDir);
  console.log(`  Files: ${files.length}`);
  files.forEach((f) => console.log(`    ${f}`));
}

// ─── Inspect .kdna file (ZIP container) ──────────────────────────────────

function inspectKdnaFile(filePath, jsonMode = false) {
  const abs = path.resolve(filePath);
  fs.statSync(abs); // verify file exists

  // Detect format: ZIP container (binary header PK\x03\x04) vs text
  const head = Buffer.alloc(4);
  const fd = fs.openSync(abs, 'r');
  fs.readSync(fd, head, 0, 4, 0);
  fs.closeSync(fd);
  const isZip = head[0] === 0x50 && head[1] === 0x4b;
  if (!isZip) error('Invalid .kdna asset: expected ZIP container');

  const { listContainerEntries, readContainerJson } = require('../package-store');
  const { licenseDecryptOptionsForManifest } = require('./license');
  const presentFiles = listContainerEntries(abs).filter(
    (f) => (f.startsWith('KDNA_') && f.endsWith('.json')) || f === 'README.md' || f === 'LICENSE',
  );
  const manifest = readContainerJson(abs, 'kdna.json') || {};
  const encryptedEntries = Array.isArray(manifest.encryption?.encrypted_entries)
    ? manifest.encryption.encrypted_entries
    : [];
  let decryptOptions = {};
  let decryptError = null;
  if (encryptedEntries.length) {
    const licensed = licenseDecryptOptionsForManifest(manifest);
    if (licensed.ok) decryptOptions = { decryptEntry: licensed.decryptEntry };
    else decryptError = licensed.error;
  }

  let core = null;
  let patterns = null;
  try {
    core = decryptError ? null : readContainerJson(abs, 'KDNA_Core.json', decryptOptions);
    patterns = decryptError ? null : readContainerJson(abs, 'KDNA_Patterns.json', decryptOptions);
  } catch (e) {
    if (!encryptedEntries.length) error(`Cannot inspect .kdna asset: ${e.message}`);
    decryptError = e.message;
  }

  if (!core && !encryptedEntries.includes('KDNA_Core.json')) {
    error('KDNA_Core.json not found in container');
  }

  const m = manifest || {};
  const c = core || {};
  const p = patterns || {};

  if (jsonMode) {
    const result = {
      name: m.name || c.meta?.domain || path.basename(abs, '.kdna'),
      format: 'kdna-zip',
      spec: m.spec_version || m.kdna_spec || null,
      version: m.version || null,
      status: m.status || 'experimental',
      access: m.access || 'open',
      author: m.author?.name || null,
      license: m.license?.type || null,
      created: m.created || c.meta?.created || null,
      description: m.description || c.meta?.purpose || null,
      protected: encryptedEntries.length > 0,
      encrypted_entries: encryptedEntries,
      license_required: !!decryptError,
      content: {
        axioms: (c.axioms || []).length,
        ontology: (c.ontology || []).length,
        frameworks: (c.frameworks || []).length,
        stances: (c.stances || []).length,
        banned_terms: (p.terminology?.banned_terms || []).length,
        misunderstandings: (p.misunderstandings || []).length,
        self_checks: (p.self_check || []).length,
      },
      files: presentFiles,
    };
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log('═'.repeat(50));
  console.log(`  ${m.name || c.meta?.domain || path.basename(abs, '.kdna')} — KDNA Domain`);
  console.log('═'.repeat(50));
  console.log('');
  console.log(`  Format:      .kdna (ZIP container)`);
  console.log(`  Spec:        ${m.spec_version || m.kdna_spec || '0.4'}`);
  console.log(`  Version:     ${m.version || '?'}`);
  console.log(`  Status:      ${m.status || 'experimental'}`);
  console.log(`  Access:      ${m.access || 'open'}`);
  console.log(`  Author:      ${m.author?.name || '?'}`);
  console.log(`  License:     ${m.license?.type || '?'}`);
  console.log(`  Created:     ${m.created || c.meta?.created || '?'}`);
  console.log(`  Description: ${m.description || c.meta?.purpose || '?'}`);
  if (encryptedEntries.length) {
    console.log(`  Protected:   ${encryptedEntries.join(', ')}`);
    if (decryptError) console.log(`  Activation:  required (${decryptError})`);
  }
  console.log('');
  console.log('  ── Content ──');
  console.log(`  Axioms:             ${(c.axioms || []).length}`);
  console.log(`  Ontology concepts:  ${(c.ontology || []).length}`);
  console.log(`  Frameworks:         ${(c.frameworks || []).length}`);
  console.log(`  Stances:            ${(c.stances || []).length}`);
  console.log(`  Banned terms:       ${(p.terminology?.banned_terms || []).length}`);
  console.log(`  Misunderstandings:  ${(p.misunderstandings || []).length}`);
  console.log(`  Self-checks:        ${(p.self_check || []).length}`);
  console.log('');
  console.log('  ── Files ──');
  presentFiles.forEach((f) => console.log(`    ${f}`));
  console.log('');
  console.log('═'.repeat(50));
}

// ─── Inspect ───────────────────────────────────────────────────────────

function cmdInspect(dir, jsonMode = false, locale = null, options = {}) {
  const abs = path.resolve(dir);
  const stat = fs.existsSync(abs) ? fs.statSync(abs) : null;
  if (!stat) error(`Path not found: ${abs}`, EXIT.INPUT_ERROR);

  // Single .kdna file
  if (stat.isFile() && abs.endsWith('.kdna')) {
    inspectKdnaFile(abs, jsonMode, locale);
    return;
  }

  if (stat.isDirectory() && !options.allowDirectory) {
    error(
      'Directory inspection is a dev-only operation. Use: kdna dev inspect <source-dir>',
      EXIT.INPUT_ERROR,
    );
  }

  // Dev source directory
  if (!stat.isDirectory()) error(`Not a KDNA domain: ${abs}`, EXIT.INPUT_ERROR);

  const core = readJson(path.join(abs, 'KDNA_Core.json'));
  const manifest = readJson(path.join(abs, 'kdna.json'));

  if (!core) {
    error(`Not a KDNA domain (KDNA_Core.json not found in ${abs})`, EXIT.INPUT_ERROR);
  }

  const m = manifest || {};
  const c = core;
  const pat = readJson(path.join(abs, 'KDNA_Patterns.json'));
  const sce = readJson(path.join(abs, 'KDNA_Scenarios.json'));
  const cas = readJson(path.join(abs, 'KDNA_Cases.json'));
  const rea = readJson(path.join(abs, 'KDNA_Reasoning.json'));
  const evo = readJson(path.join(abs, 'KDNA_Evolution.json'));

  const expected = [
    'KDNA_Core.json',
    'KDNA_Patterns.json',
    'KDNA_Scenarios.json',
    'KDNA_Cases.json',
    'KDNA_Reasoning.json',
    'KDNA_Evolution.json',
  ];
  const filesPresent = expected.filter((f) => fs.existsSync(path.join(abs, f)));

  // Governance metadata (with locale support)
  let kdnaCard = readJson(path.join(abs, 'KDNA_CARD.json'));
  if (locale && !kdnaCard) {
    kdnaCard = readJson(path.join(abs, 'locales', locale, 'KDNA_CARD.json'));
  }
  if (locale && kdnaCard) {
    const localeCard = readJson(path.join(abs, 'locales', locale, 'KDNA_CARD.json'));
    if (localeCard) kdnaCard = localeCard;
  }

  if (jsonMode) {
    const result = {
      name: m.name || c.meta?.domain || path.basename(abs),
      version: m.version || c.meta?.version || null,
      status: m.status || 'experimental',
      access: m.access || 'open',
      language: m.language || c.meta?.language || null,
      author: m.author?.name || null,
      author_id: m.author?.id || null,
      license: m.license?.type || null,
      created: c.meta?.created || null,
      description: m.description || c.meta?.purpose || null,
      files: filesPresent,
      content: {
        axioms: (c.axioms || []).length,
        ontology: (c.ontology || []).length,
        frameworks: (c.frameworks || []).length,
        core_structures: (c.core_structure || []).length,
        stances: (c.stances || []).length,
        preferred_terms: (
          pat?.terminology?.preferred_terms ||
          pat?.terminology?.standard_terms ||
          []
        ).length,
        banned_terms: (pat?.terminology?.banned_terms || []).length,
        misunderstandings: (pat?.misunderstandings || []).length,
        self_checks: (pat?.self_check || []).length,
        scenarios: sce ? (sce.scenes || []).length : 0,
        cases: cas ? (cas.cases || []).length : 0,
        reasoning_chains: rea ? (rea.reasoning_chains || []).length : 0,
        evolution_stages: evo ? (evo.stages || []).length : 0,
      },
      axioms: (c.axioms || []).map((a) => a.one_sentence || null).filter(Boolean),
    };

    // Add governance + locale data
    if (kdnaCard) {
      result.governance = {
        risk_level: kdnaCard.risk_level || null,
        review_status: kdnaCard.review_status || null,
        intended_use: kdnaCard.intended_use || [],
        out_of_scope: kdnaCard.out_of_scope || [],
        known_limitations: kdnaCard.known_limitations || [],
        requires_expert_review: kdnaCard.requires_expert_review || false,
      };
      if (locale) {
        result.governance.display_name = kdnaCard.display_name || null;
        result.governance.summary = kdnaCard.summary || null;
        result.governance.locale = locale;
      }
    }
    // Add i18n info from kdna.json
    if (m.languages) result.languages = m.languages;
    if (m.default_language) result.default_language = m.default_language;
    if (m.i18n_level) result.i18n_level = m.i18n_level;

    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log('═'.repeat(50));
  console.log(`  ${m.name || c.meta?.domain || path.basename(abs)} — KDNA Domain`);
  console.log('═'.repeat(50));
  console.log('');
  console.log(`  Version:     ${m.version || c.meta?.version || '?'}`);
  console.log(`  Status:      ${m.status || 'experimental'}`);
  console.log(`  Access:      ${m.access || 'open'}`);
  console.log(`  Language:    ${m.language || c.meta?.language || '?'}`);
  console.log(`  Author:      ${m.author?.name || '?'}`);
  if (m.author?.id) console.log(`               ${m.author.id}`);
  console.log(`  License:     ${m.license?.type || '?'}`);
  console.log(`  Created:     ${c.meta?.created || '?'}`);
  console.log(`  Description: ${m.description || c.meta?.purpose || '?'}`);
  console.log('');

  console.log('  ── File Set ──');
  for (const f of expected) {
    const exists = fs.existsSync(path.join(abs, f));
    console.log(`  ${exists ? '✓' : '○'} ${f}`);
  }

  console.log('');
  console.log('  ── Content ──');
  console.log(`  Axioms:             ${(c.axioms || []).length}`);
  console.log(`  Ontology concepts:  ${(c.ontology || []).length}`);
  console.log(`  Frameworks:         ${(c.frameworks || []).length}`);
  console.log(`  Core structures:    ${(c.core_structure || []).length}`);
  console.log(`  Stances:            ${(c.stances || []).length}`);

  if (pat) {
    const preferred = pat.terminology?.preferred_terms || pat.terminology?.standard_terms || [];
    console.log(`  Preferred terms:    ${preferred.length}`);
    console.log(`  Banned terms:       ${(pat.terminology?.banned_terms || []).length}`);
    console.log(`  Misunderstandings:  ${(pat.misunderstandings || []).length}`);
    console.log(`  Self-checks:        ${(pat.self_check || []).length}`);
  }

  if (sce) console.log(`  Scenarios:          ${(sce.scenes || []).length}`);

  if (cas) console.log(`  Cases:              ${(cas.cases || []).length}`);

  if (rea) console.log(`  Reasoning chains:   ${(rea.reasoning_chains || []).length}`);

  if (evo) console.log(`  Evolution stages:   ${(evo.stages || []).length}`);

  if (kdnaCard) {
    const displayName = kdnaCard.display_name || '';
    const summary = kdnaCard.summary || '';
    console.log('');
    console.log('  ── Governance ──');
    if (displayName && locale) console.log(`  Display name:   ${displayName}`);
    if (summary && locale) console.log(`  Summary:        ${summary}`);
    console.log(`  Risk level:     ${kdnaCard.risk_level || '?'}`);
    console.log(`  Review status:  ${kdnaCard.review_status || '?'}`);
    if (kdnaCard.intended_use?.length)
      console.log(
        `  Intended use:   ${kdnaCard.intended_use[0]}${kdnaCard.intended_use.length > 1 ? ` (+${kdnaCard.intended_use.length - 1} more)` : ''}`,
      );
    if (kdnaCard.out_of_scope?.length)
      console.log(
        `  Out of scope:   ${kdnaCard.out_of_scope[0]}${kdnaCard.out_of_scope.length > 1 ? ` (+${kdnaCard.out_of_scope.length - 1} more)` : ''}`,
      );
    if (kdnaCard.known_limitations?.length)
      console.log(
        `  Limitations:    ${kdnaCard.known_limitations[0]}${kdnaCard.known_limitations.length > 1 ? ` (+${kdnaCard.known_limitations.length - 1} more)` : ''}`,
      );
    if (kdnaCard.requires_expert_review) console.log(`  ⚠ Expert review required`);
  }

  console.log('');
  console.log('  ── Axioms ──');
  for (const a of c.axioms || []) {
    console.log(`  • ${a.one_sentence}`);
  }

  console.log('');
  console.log('═'.repeat(50));
}

// ─── KDNA Card (locale-aware) ────────────────────────────────────

function readCardFromDirectory(abs, locale = null) {
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return null;
  let card = readJson(path.join(abs, 'KDNA_CARD.json'));

  if (locale) {
    const localeCard = readJson(path.join(abs, 'locales', locale, 'KDNA_CARD.json'));
    if (localeCard) {
      card = { ...card, ...localeCard };
    }
  }

  return card;
}

function cmdCard(dir, jsonMode = false, locale = null, options = {}) {
  const abs = path.resolve(dir);
  const stat = fs.existsSync(abs) ? fs.statSync(abs) : null;
  if (!stat) error(`Path not found: ${abs}`, EXIT.INPUT_ERROR);

  if (stat.isDirectory() && !options.allowDirectory) {
    error(
      'Directory card inspection is a dev-only operation. Use: kdna dev card <source-dir>',
      EXIT.INPUT_ERROR,
    );
  }

  let card = null;
  if (stat.isFile() && abs.endsWith('.kdna')) {
    const { readContainerJson } = require('../package-store');
    card = readContainerJson(abs, 'KDNA_CARD.json') || null;
    if (locale) {
      const localeCard = readContainerJson(abs, `locales/${locale}/KDNA_CARD.json`) || null;
      if (localeCard) card = { ...card, ...localeCard };
    }
  } else if (stat.isDirectory()) {
    card = readCardFromDirectory(abs, locale);
  } else {
    error(`Not a .kdna asset: ${abs}`, EXIT.INPUT_ERROR);
  }

  if (!card) {
    error(
      `No KDNA_CARD.json found in ${abs}${locale ? ` or locales/${locale}/` : ''}`,
      EXIT.INPUT_ERROR,
    );
  }

  if (jsonMode) {
    console.log(JSON.stringify(card, null, 2));
    return;
  }

  console.log('═'.repeat(60));
  console.log(`  KDNA Card${locale ? ` (${locale})` : ''}`);
  console.log('═'.repeat(60));
  console.log('');
  if (card.display_name) console.log(`  Display name:   ${card.display_name}`);
  console.log(`  Domain:         ${card.name || '?'}`);
  console.log(`  Version:        ${card.version || '?'}`);
  console.log(`  Risk level:     ${card.risk_level || '?'}`);
  console.log(`  Quality:        ${card.quality_badge || '?'}`);
  console.log(`  Review:         ${card.review_status || '?'}`);
  console.log(`  License:        ${card.license || '?'}`);
  if (card.summary) console.log(`  Summary:        ${card.summary}`);
  console.log('');
  if (card.intended_use?.length) {
    console.log('  ── Intended Use ──');
    card.intended_use.forEach((u) => console.log(`  ✓ ${u}`));
    console.log('');
  }
  if (card.out_of_scope?.length) {
    console.log('  ── Out of Scope ──');
    card.out_of_scope.forEach((o) => console.log(`  ✗ ${o}`));
    console.log('');
  }
  if (card.known_limitations?.length) {
    console.log('  ── Known Limitations ──');
    card.known_limitations.forEach((l) => console.log(`  ⚠ ${l}`));
    console.log('');
  }
  if (card.risk_warnings?.length) {
    console.log('  ── Risk Warnings ──');
    card.risk_warnings.forEach((w) => console.log(`  ⚡ ${w}`));
    console.log('');
  }
  if (card.author_responsibility) {
    console.log(`  Author: ${card.author_responsibility}`);
    console.log('');
  }
  if (card.provenance) {
    console.log('  ── Provenance ──');
    console.log(`  Studio:    ${card.provenance.studio_core || '?'}`);
    console.log(`  Version:   ${card.provenance.studio_core_version || '?'}`);
    console.log(`  Built:     ${card.provenance.built_at || '?'}`);
    if (card.provenance.content_fingerprint)
      console.log(`  Fingerprint: ${card.provenance.content_fingerprint}`);
    console.log('');
  }
  console.log('═'.repeat(60));
}

module.exports = {
  cmdValidate,
  cmdPack,
  cmdUnpack,
  cmdInspect,
  cmdCard,
};
