const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { encryptLicensedEntry } = require('@aikdna/kdna-core');
const { machineFingerprint } = require('../src/cmds/license');
const { validateAuthoringProvenance } = require('../src/publish');

const CLI = path.resolve(__dirname, '..', 'src', 'cli.js');

function run(args, opts = {}) {
  try {
    return {
      ok: true,
      code: 0,
      stdout: execFileSync('node', [CLI, ...args], {
        encoding: 'utf8',
        timeout: 30000,
        env: { ...process.env, ...(opts.env || {}) },
        cwd: opts.cwd || process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    };
  } catch (e) {
    return {
      ok: false,
      code: e.status,
      stdout: (e.stdout || '').toString(),
      stderr: (e.stderr || '').toString(),
    };
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function createAsset(tmpRoot) {
  const source = path.join(tmpRoot, 'writing-source');
  fs.mkdirSync(source, { recursive: true });
  writeJson(path.join(source, 'kdna.json'), {
    format: 'kdna',
    format_version: '1.0',
    spec_version: '1.0-rc',
    name: '@aikdna/writing',
    version: '0.1.0',
    judgment_version: '2026.05',
    status: 'experimental',
    access: 'open',
    languages: ['en'],
    default_language: 'en',
    description: 'Writing judgment test asset.',
    core_insight: 'Writing quality is a structural judgment problem.',
    keywords: ['writing', 'review'],
    quality_badge: 'untested',
    author: { name: 'Test', id: 'test', pubkey: 'ed25519:test' },
    license: { type: 'CC-BY-4.0' },
    file_count: 2,
    files: ['KDNA_Core.json', 'KDNA_Patterns.json'],
  });
  writeJson(path.join(source, 'KDNA_Core.json'), {
    meta: {
      domain: 'writing',
      version: '0.1.0',
      purpose: 'Review writing structure.',
    },
    axioms: [
      {
        id: 'axiom_structure_first',
        one_sentence: 'Most writing problems are structural before they are stylistic.',
        applies_when: ['review this blog post for structural problems'],
        does_not_apply_when: ['only fix grammar'],
        failure_risk: 'Over-applies structural critique to copy editing.',
        status: 'locked',
        human_lock: {
          by: 'test',
          statement: 'Reviewed for test fixture packaging.',
          checked: {
            applies_when: true,
            does_not_apply_when: true,
            failure_risk: true,
          },
        },
      },
    ],
    ontology: [{ id: 'argument', one_sentence: 'A claim with a reason.' }],
    stances: [{ stance: 'Diagnose the argument before polishing prose.' }],
  });
  writeJson(path.join(source, 'KDNA_Patterns.json'), {
    misunderstandings: [
      {
        id: 'polish_first',
        wrong: 'Treat weak argument as wording trouble.',
        correct: 'Find the missing claim first.',
      },
    ],
    self_check: ['Did I identify the real argument?'],
  });
  fs.writeFileSync(
    path.join(source, 'README.md'),
    '## Scope\nWriting review.\n\n## Out of Scope\nGrammar only.\n',
  );

  const asset = path.join(tmpRoot, 'writing.kdna');
  const script = `import zipfile, os
src = ${JSON.stringify(source)}
out = ${JSON.stringify(asset)}
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as zf:
    zf.writestr(zipfile.ZipInfo('mimetype'), 'application/vnd.aikdna.kdna+zip', compress_type=zipfile.ZIP_STORED)
    for name in sorted(os.listdir(src)):
        zf.write(os.path.join(src, name), name)
`;
  execFileSync('python3', ['-c', script], { stdio: 'pipe' });
  return { source, asset };
}

function createLicensedAsset(tmpRoot) {
  const source = path.join(tmpRoot, 'licensed-source');
  fs.mkdirSync(source, { recursive: true });
  const licenseKey = 'KDNA-LIC-TEST-ACTIVATION';
  const fingerprint = machineFingerprint();
  const manifest = {
    format: 'kdna',
    format_version: '1.0',
    spec_version: '1.0-rc',
    name: '@aikdna/writing_pro',
    version: '0.2.0',
    judgment_version: '2026.05',
    status: 'experimental',
    access: 'licensed',
    languages: ['en'],
    default_language: 'en',
    description: 'Licensed writing test asset.',
    core_insight: 'Protected judgment stays inside the asset.',
    keywords: ['writing', 'licensed'],
    quality_badge: 'untested',
    author: { name: 'Test', id: 'test', pubkey: 'ed25519:test' },
    license: { type: 'KCL-1.0' },
    encryption: {
      profile: 'kdna-licensed-entry-v1',
      encrypted_entries: ['KDNA_Core.json', 'KDNA_Patterns.json'],
    },
  };
  const core = {
    meta: {
      domain: 'writing_pro',
      version: '0.2.0',
      purpose: 'Review protected writing structure.',
      created: '2026-05-27',
      load_condition: 'always',
    },
    axioms: [
      {
        id: 'licensed_axiom',
        one_sentence: 'Licensed judgment loads only after activation.',
        applies_when: ['review protected writing'],
        does_not_apply_when: ['public asset'],
        failure_risk: 'Leaking protected content.',
      },
    ],
    ontology: [{ id: 'protected_argument', one_sentence: 'A licensed argument.' }],
    stances: [{ stance: 'Keep licensed judgment in memory.' }],
  };
  const patterns = {
    meta: {
      domain: 'writing_pro',
      version: '0.2.0',
      purpose: 'Protected writing patterns.',
      created: '2026-05-27',
      load_condition: 'always',
    },
    misunderstandings: [
      {
        id: 'licensed_misread',
        wrong: 'Load protected entries without activation.',
        correct: 'Require a valid activation before loading protected entries.',
      },
    ],
    self_check: ['Did I keep protected judgment in memory?'],
  };

  writeJson(path.join(source, 'kdna.json'), manifest);
  writeJson(
    path.join(source, 'KDNA_Core.json'),
    encryptLicensedEntry(JSON.stringify(core), {
      entryName: 'KDNA_Core.json',
      manifest,
      licenseKey,
    }),
  );
  writeJson(
    path.join(source, 'KDNA_Patterns.json'),
    encryptLicensedEntry(JSON.stringify(patterns), {
      entryName: 'KDNA_Patterns.json',
      manifest,
      licenseKey,
    }),
  );

  const asset = path.join(tmpRoot, 'writing-pro.kdna');
  const script = `import zipfile, os
src = ${JSON.stringify(source)}
out = ${JSON.stringify(asset)}
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as zf:
    zf.writestr(zipfile.ZipInfo('mimetype'), 'application/vnd.aikdna.kdna+zip', compress_type=zipfile.ZIP_STORED)
    for name in sorted(os.listdir(src)):
        zf.write(os.path.join(src, name), name)
`;
  execFileSync('python3', ['-c', script], { stdio: 'pipe' });
  return { asset, licenseKey, fingerprint };
}

function trustedAuthoringManifest(overrides = {}) {
  const { authoring: authoringOverrides = {}, ...manifestOverrides } = overrides;
  return {
    quality_badge: 'tested',
    authoring: {
      created_by: 'community-studio',
      compiler: '@example/kdna-studio',
      compiler_version: '1.0.0',
      compiled_at: '2026-06-20T00:00:00.000Z',
      conformance: {
        passed: true,
        spec_version: '1.0',
      },
      asset_uid: 'urn:uuid:00000000-0000-4000-8000-000000000001',
      project_uid: 'project-001',
      build_id: 'build-001',
      domain_id: '@example/domain',
      content_digest: `sha256:${'a'.repeat(64)}`,
      human_confirmed: true,
      human_lock_count: 1,
      ...authoringOverrides,
    },
    ...manifestOverrides,
  };
}

test('trusted authoring gate accepts conformance metadata instead of a created_by whitelist', () => {
  const issues = validateAuthoringProvenance(trustedAuthoringManifest());
  assert.deepEqual(issues, []);
});

test('trusted authoring gate rejects missing conformance metadata', () => {
  const manifest = trustedAuthoringManifest({
    authoring: {
      conformance: undefined,
    },
  });
  const issues = validateAuthoringProvenance(manifest);
  assert.ok(
    issues.some((issue) => issue.includes('authoring.conformance.passed')),
    `expected conformance failure, got ${issues.join('; ')}`,
  );
});

test('local .kdna install stores immutable asset and runtime loads from package index', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-asset-store-'));
  const home = path.join(tmpRoot, 'home');
  const kdnaHome = path.join(home, '.kdna');
  fs.mkdirSync(home, { recursive: true });
  const { source, asset } = createAsset(tmpRoot);
  const env = { HOME: home, KDNA_HOME: kdnaHome };

  const install = run(['install', asset, '--yes'], { env });
  assert.ok(install.ok, `install failed: ${install.stderr}`);
  assert.match(install.stdout, /Installed @aikdna\/writing/);

  const indexPath = path.join(kdnaHome, 'index.json');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const entry = index.packages['@aikdna/writing'];
  assert.ok(
    entry.asset_path.endsWith(path.join('@aikdna', 'writing', '0.1.0', 'writing-0.1.0.kdna')),
  );
  assert.ok(fs.existsSync(entry.asset_path));
  assert.ok(fs.existsSync(entry.receipt_path));
  assert.match(entry.asset_digest, /^sha256:/);
  assert.match(entry.content_digest, /^sha256:/);
  assert.ok(!fs.existsSync(path.join(path.dirname(entry.asset_path), 'KDNA_Core.json')));

  const available = run(['available', '--json'], { env });
  assert.ok(available.ok, `available failed: ${available.stderr}`);
  const domains = JSON.parse(available.stdout);
  assert.equal(domains[0].name, '@aikdna/writing');
  assert.ok(domains[0].applies_when.length > 0);

  const load = run(['load', '@aikdna/writing'], { env });
  assert.ok(load.ok, `load failed: ${load.stderr}`);
  assert.match(load.stdout, /KDNA loaded: @aikdna\/writing/);
  assert.match(load.stdout, /Most writing problems are structural/);

  const directLoad = run(['load', asset], { env });
  assert.ok(directLoad.ok, `direct file load failed: ${directLoad.stderr}`);
  assert.match(directLoad.stdout, /KDNA loaded: @aikdna\/writing/);

  const directVerify = run(['verify', asset, '--structure', '--json'], { env });
  assert.ok(directVerify.ok, `direct file verify failed: ${directVerify.stderr}`);
  const verified = JSON.parse(directVerify.stdout);
  assert.equal(verified.name, '@aikdna/writing');
  assert.match(verified.asset_digest, /^sha256:/);

  const inspect = run(['inspect', asset, '--json'], { env });
  assert.ok(inspect.ok, `direct file inspect failed: ${inspect.stderr}`);
  const inspected = JSON.parse(inspect.stdout);
  assert.equal(inspected.name, '@aikdna/writing');
  assert.equal(inspected.format, 'kdna-zip');
  assert.ok(inspected.files.includes('KDNA_Core.json'));

  fs.mkdirSync(path.join(kdnaHome, 'registry'), { recursive: true });
  writeJson(path.join(kdnaHome, 'registry', 'domains.json'), {
    schema_version: '3.0',
    registry_version: '3.0.0-test',
    updated: '2026-05-27T00:00:00Z',
    trust: {
      model: 'kdna-registry-v1',
      snapshot: {
        registry_version: '3.0.0-test',
        generated_at: '2026-05-27T00:00:00Z',
        expires_at: '2099-01-01T00:00:00Z',
      },
      timestamp: {
        generated_at: '2026-05-27T00:00:00Z',
        expires_at: '2099-01-01T00:00:00Z',
      },
      revocations: [],
    },
    scopes: {
      '@aikdna': {
        type: 'official',
        description: 'Test scope',
        trust_pubkey: 'ed25519:test',
        registry_url: null,
        verified: true,
      },
    },
    domains: [
      {
        name: '@aikdna/writing',
        type: 'domain',
        version: '0.1.0',
        status: 'experimental',
        access: 'open',
        asset_url: 'https://example.com/writing.kdna',
        asset_digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        signature: 'ed25519:test',
        release_status: 'published_signed',
        author: { name: 'Test', id: 'test', pubkey: 'ed25519:test' },
      },
    ],
  });
  const trustVerify = run(['verify', '@aikdna/writing', '--trust', '--json'], { env });
  assert.equal(trustVerify.code, 3);
  const trust = JSON.parse(trustVerify.stdout);
  assert.ok(
    trust.layers.trust.errors.some((msg) => msg.includes('asset digest mismatch')),
    `expected digest mismatch, got ${trustVerify.stdout}`,
  );

  const info = run(['info', '@aikdna/writing'], { env });
  assert.ok(info.ok, `info failed: ${info.stderr}`);
  assert.match(info.stdout, /Asset:/);

  const directoryInstall = run(['install', source], { env });
  assert.equal(directoryInstall.code, 2);
  assert.match(directoryInstall.stderr, /Directory install is not supported/);

  const directoryInspect = run(['inspect', source], { env });
  assert.equal(directoryInspect.code, 2);
  assert.match(directoryInspect.stderr, /Directory inspection is a dev-only operation/);

  const devInspect = run(['dev', 'inspect', source], { env });
  assert.ok(devInspect.ok, `dev inspect failed: ${devInspect.stderr}`);
  assert.match(devInspect.stdout, /KDNA Domain/);

  const packedDir = path.join(tmpRoot, 'packed');
  const devPack = run(['dev', 'pack', source, '--out', packedDir], { env });
  assert.ok(devPack.ok, `dev pack failed: ${devPack.stderr}`);
  const packedAsset = path.join(packedDir, 'writing.kdna');
  assert.ok(fs.existsSync(packedAsset));
  const packedInspect = run(['inspect', packedAsset, '--json'], { env });
  assert.ok(packedInspect.ok, `packed asset inspect failed: ${packedInspect.stderr}`);
  assert.equal(JSON.parse(packedInspect.stdout).format, 'kdna-zip');
});

test('kdna dev pack does not require Human Lock for dev-only bundles', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-dev-pack-unlocked-'));
  const { source } = createAsset(tmpRoot);
  const corePath = path.join(source, 'KDNA_Core.json');
  const core = JSON.parse(fs.readFileSync(corePath, 'utf8'));
  for (const axiom of core.axioms) {
    axiom.status = 'draft';
    delete axiom.human_lock;
  }
  writeJson(corePath, core);

  const packedDir = path.join(tmpRoot, 'packed');
  const devPack = run(['dev', 'pack', source, '--out', packedDir]);
  assert.ok(devPack.ok, `dev pack should allow unlocked dev bundles: ${devPack.stderr}`);
  assert.doesNotMatch(`${devPack.stdout || ''}${devPack.stderr || ''}`, /Human Lock Gate: BLOCKED/);
  assert.ok(fs.existsSync(path.join(packedDir, 'writing.kdna')));
});

test('kdna publish rejects source directories and publishes existing .kdna assets', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-publish-sign-'));
  const { source, asset } = createAsset(tmpRoot);

  const sourcePublish = run(['publish', source]);
  assert.equal(sourcePublish.code, 2);
  assert.match(sourcePublish.stderr, /only accepts existing \.kdna assets/);

  const published = run(['publish', asset]);
  assert.ok(published.ok, `publish failed: ${published.stderr}`);
  assert.match(published.stdout, /Registry patch/);
  assert.match(published.stdout, /"asset_digest": "sha256:/);
});

test('licensed .kdna load requires installed activation and decrypts in memory', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-licensed-store-'));
  const home = path.join(tmpRoot, 'home');
  const kdnaHome = path.join(home, '.kdna');
  fs.mkdirSync(home, { recursive: true });
  const { asset, licenseKey, fingerprint } = createLicensedAsset(tmpRoot);
  const env = { HOME: home, KDNA_HOME: kdnaHome };

  const install = run(['install', asset, '--yes'], { env });
  assert.ok(install.ok, `install failed: ${install.stderr}`);

  const denied = run(['load', '@aikdna/writing_pro'], { env });
  assert.equal(denied.code, 3);
  assert.match(denied.stderr, /KDNA license required/);

  const verifyDenied = run(['verify', '@aikdna/writing_pro', '--structure', '--json'], { env });
  assert.equal(verifyDenied.code, 1);
  const verifyDeniedJson = JSON.parse(verifyDenied.stdout);
  assert.ok(
    verifyDeniedJson.layers.structure.errors.some((msg) => msg.includes('license required')),
    `expected license error, got ${verifyDenied.stdout}`,
  );

  const inspectDenied = run(['inspect', asset, '--json'], { env });
  assert.ok(
    inspectDenied.ok,
    `licensed inspect should show protected manifest: ${inspectDenied.stderr}`,
  );
  const inspectDeniedJson = JSON.parse(inspectDenied.stdout);
  assert.equal(inspectDeniedJson.protected, true);
  assert.equal(inspectDeniedJson.license_required, true);
  assert.equal(inspectDeniedJson.content.axioms, 0);

  const licensePath = path.join(tmpRoot, 'license.json');
  writeJson(licensePath, {
    version: '1.0',
    license_id: 'lic_test_activation',
    license_key: licenseKey,
    domain: '@aikdna/writing_pro',
    issued_to: 'test@example.com',
    require_machine_binding: true,
    machine_fingerprint: fingerprint,
  });
  const licenseInstall = run(['license', 'install', licensePath], { env });
  assert.ok(licenseInstall.ok, `license install failed: ${licenseInstall.stderr}`);

  const verified = run(['verify', '@aikdna/writing_pro', '--structure', '--json'], { env });
  assert.ok(verified.ok, `licensed verify failed: ${verified.stderr}\n${verified.stdout}`);
  const verifiedJson = JSON.parse(verified.stdout);
  assert.equal(verifiedJson.layers.structure.errors.length, 0);

  const inspectAllowed = run(['inspect', asset, '--json'], { env });
  assert.ok(
    inspectAllowed.ok,
    `licensed inspect failed after activation: ${inspectAllowed.stderr}`,
  );
  const inspectAllowedJson = JSON.parse(inspectAllowed.stdout);
  assert.equal(inspectAllowedJson.license_required, false);
  assert.equal(inspectAllowedJson.content.axioms, 1);

  const loaded = run(['load', '@aikdna/writing_pro'], { env });
  assert.ok(loaded.ok, `licensed load failed: ${loaded.stderr}`);
  assert.match(loaded.stdout, /KDNA loaded: @aikdna\/writing_pro/);
  assert.match(loaded.stdout, /Licensed judgment loads only after activation/);

  const traceDir = path.join(kdnaHome, 'traces');
  const traceFile = fs.readdirSync(traceDir).find((name) => name.endsWith('.jsonl'));
  assert.ok(traceFile, 'licensed load should create a trace file');
  const traceText = fs.readFileSync(path.join(traceDir, traceFile), 'utf8');
  assert.match(traceText, /"license_id":"lic_test_activation"/);
  assert.doesNotMatch(traceText, /KDNA-LIC-TEST-ACTIVATION/);

  const raw = run(['load', '@aikdna/writing_pro', '--as=raw'], { env });
  assert.equal(raw.code, 2);
  assert.match(raw.stderr, /ERR_RAW_LOAD_REMOVED/);
  assert.doesNotMatch(raw.stdout + raw.stderr, /ciphertext|KDNA-LIC-TEST-ACTIVATION/);
});
