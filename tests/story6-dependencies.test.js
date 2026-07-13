'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const core = require('@aikdna/kdna-core');
const cbor = require('cbor-x');

test('Story 6: dependencies semver and topological sorting logic', () => {
  // Test direct satisfies helper if available, or test via planLoad with mock resolver
  const mockResolveAsset = (name) => {
    const assets = {
      '@scope/dep-a': {
        version: '1.2.3',
        path: '/mock/dep-a.kdna',
        manifest: {
          kdna_version: '1.0',
          asset_id: 'kdna:domain:dep-a',
          asset_uid: 'urn:uuid:00000000-0000-4000-8000-000000000010',
          asset_type: 'domain',
          title: 'Dep A',
          version: '1.2.3',
          judgment_version: '1.0.0',
          creator: { name: 'Test' },
          compatibility: { min_loader_version: '1.0.0', profile: 'judgment-profile-v1' },
          payload: { path: 'payload.kdnab', encoding: 'cbor', encrypted: false },
          dependencies: {
            '@scope/dep-b': '^2.0.0',
          },
        },
      },
      '@scope/dep-b': {
        version: '2.5.1',
        path: '/mock/dep-b.kdna',
        manifest: {
          kdna_version: '1.0',
          asset_id: 'kdna:domain:dep-b',
          asset_uid: 'urn:uuid:00000000-0000-4000-8000-000000000011',
          asset_type: 'domain',
          title: 'Dep B',
          version: '2.5.1',
          judgment_version: '1.0.0',
          creator: { name: 'Test' },
          compatibility: { min_loader_version: '1.0.0', profile: 'judgment-profile-v1' },
          payload: { path: 'payload.kdnab', encoding: 'cbor', encrypted: false },
          dependencies: {},
        },
      },
    };
    return assets[name] || null;
  };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-story6-'));
  try {
    fs.writeFileSync(path.join(tmp, 'mimetype'), 'application/vnd.kdna.asset');

    const manifest = {
      kdna_version: '1.0',
      asset_id: 'kdna:bundle:test-bundle',
      asset_uid: 'urn:uuid:00000000-0000-4000-8000-000000000012',
      asset_type: 'bundle',
      title: 'Target Bundle',
      version: '1.0.0',
      judgment_version: '1.0.0',
      created_at: '2026-06-28T00:00:00Z',
      updated_at: '2026-06-28T00:00:00Z',
      creator: { name: 'Test' },
      compatibility: { min_loader_version: '1.0.0', profile: 'bundle-profile-v1' },
      payload: { path: 'payload.kdnab', encoding: 'cbor', encrypted: false },
      summary: 'Testing dependencies',
      description: 'Test bundle',
      languages: ['en'],
      default_language: 'en',
      license: 'Apache-2.0',
      status: 'stable',
      quality_badge: 'tested',
      dependencies: {
        '@scope/dep-a': '^1.0.0',
      },
    };
    fs.writeFileSync(path.join(tmp, 'kdna.json'), JSON.stringify(manifest, null, 2));

    const payload = {
      profile: 'bundle-profile-v1',
      components: [{ id: 'comp-a', path: './comp-a.kdna' }],
    };
    fs.writeFileSync(path.join(tmp, 'payload.kdnab'), cbor.encode(payload));
    fs.writeFileSync(
      path.join(tmp, 'checksums.json'),
      JSON.stringify(core.buildChecksums(tmp), null, 2),
    );
    const assetPath = `${tmp}.kdna`;
    core.pack(tmp, assetPath);

    // Run planLoad with mock resolveAsset callback
    const plan = core.planLoad(assetPath, { resolveAsset: mockResolveAsset });

    assert.equal(plan.state, 'ready');
    assert.equal(plan.can_load_now, true);
    assert.ok(Array.isArray(plan.resolved_dependencies));

    // Topological order: dep-b must be loaded BEFORE dep-a
    assert.equal(plan.resolved_dependencies.length, 2);
    assert.equal(plan.resolved_dependencies[0].name, '@scope/dep-b');
    assert.equal(plan.resolved_dependencies[1].name, '@scope/dep-a');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(`${tmp}.kdna`, { force: true });
  }
});

test('Story 6: circular dependency throwing error', () => {
  const mockResolveAsset = (name) => {
    const assets = {
      '@scope/dep-a': {
        version: '1.0.0',
        path: '/mock/dep-a.kdna',
        manifest: {
          kdna_version: '1.0',
          asset_id: 'kdna:domain:dep-a',
          asset_uid: 'urn:uuid:00000000-0000-4000-8000-000000000010',
          asset_type: 'domain',
          title: 'Dep A',
          version: '1.0.0',
          judgment_version: '1.0.0',
          creator: { name: 'Test' },
          compatibility: { min_loader_version: '1.0.0', profile: 'judgment-profile-v1' },
          payload: { path: 'payload.kdnab', encoding: 'cbor', encrypted: false },
          dependencies: {
            '@scope/dep-b': '^1.0.0',
          },
        },
      },
      '@scope/dep-b': {
        version: '1.0.0',
        path: '/mock/dep-b.kdna',
        manifest: {
          kdna_version: '1.0',
          asset_id: 'kdna:domain:dep-b',
          asset_uid: 'urn:uuid:00000000-0000-4000-8000-000000000011',
          asset_type: 'domain',
          title: 'Dep B',
          version: '1.0.0',
          judgment_version: '1.0.0',
          creator: { name: 'Test' },
          compatibility: { min_loader_version: '1.0.0', profile: 'judgment-profile-v1' },
          payload: { path: 'payload.kdnab', encoding: 'cbor', encrypted: false },
          dependencies: {
            '@scope/dep-a': '^1.0.0',
          },
        },
      },
    };
    return assets[name] || null;
  };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-story6-circular-'));
  try {
    fs.writeFileSync(path.join(tmp, 'mimetype'), 'application/vnd.kdna.asset');

    const manifest = {
      kdna_version: '1.0',
      asset_id: 'kdna:bundle:test-bundle',
      asset_uid: 'urn:uuid:00000000-0000-4000-8000-000000000012',
      asset_type: 'bundle',
      title: 'Target Bundle',
      version: '1.0.0',
      judgment_version: '1.0.0',
      created_at: '2026-06-28T00:00:00Z',
      updated_at: '2026-06-28T00:00:00Z',
      creator: { name: 'Test' },
      compatibility: { min_loader_version: '1.0.0', profile: 'bundle-profile-v1' },
      payload: { path: 'payload.kdnab', encoding: 'cbor', encrypted: false },
      summary: 'Testing dependencies',
      description: 'Test bundle',
      languages: ['en'],
      default_language: 'en',
      license: 'Apache-2.0',
      status: 'stable',
      quality_badge: 'tested',
      dependencies: {
        '@scope/dep-a': '^1.0.0',
      },
    };
    fs.writeFileSync(path.join(tmp, 'kdna.json'), JSON.stringify(manifest, null, 2));

    const payload = {
      profile: 'bundle-profile-v1',
      components: [{ id: 'comp-a', path: './comp-a.kdna' }],
    };
    fs.writeFileSync(path.join(tmp, 'payload.kdnab'), cbor.encode(payload));
    fs.writeFileSync(
      path.join(tmp, 'checksums.json'),
      JSON.stringify(core.buildChecksums(tmp), null, 2),
    );
    const assetPath = `${tmp}.kdna`;
    core.pack(tmp, assetPath);

    const plan = core.planLoad(assetPath, { resolveAsset: mockResolveAsset });

    assert.equal(plan.state, 'invalid');
    assert.equal(plan.can_load_now, false);

    const circularIssue = plan.issues.find(
      (issue) => issue.code === 'KDNA_DEPENDENCY_RESOLUTION_FAILED',
    );
    assert.ok(circularIssue);
    assert.match(circularIssue.message, /Circular dependency detected/i);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(`${tmp}.kdna`, { force: true });
  }
});

test('Story 6: unsatisfied/mismatched dependency throwing error', () => {
  const mockResolveAsset = (name) => {
    const assets = {
      '@scope/dep-a': {
        version: '0.9.0', // satisfies ^1.0.0 ? No!
        path: '/mock/dep-a.kdna',
        manifest: {
          kdna_version: '1.0',
          asset_id: 'kdna:domain:dep-a',
          asset_uid: 'urn:uuid:00000000-0000-4000-8000-000000000010',
          asset_type: 'domain',
          title: 'Dep A',
          version: '0.9.0',
          judgment_version: '1.0.0',
          creator: { name: 'Test' },
          compatibility: { min_loader_version: '1.0.0', profile: 'judgment-profile-v1' },
          payload: { path: 'payload.kdnab', encoding: 'cbor', encrypted: false },
          dependencies: {},
        },
      },
    };
    return assets[name] || null;
  };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-story6-mismatch-'));
  try {
    fs.writeFileSync(path.join(tmp, 'mimetype'), 'application/vnd.kdna.asset');

    const manifest = {
      kdna_version: '1.0',
      asset_id: 'kdna:bundle:test-bundle',
      asset_uid: 'urn:uuid:00000000-0000-4000-8000-000000000012',
      asset_type: 'bundle',
      title: 'Target Bundle',
      version: '1.0.0',
      judgment_version: '1.0.0',
      created_at: '2026-06-28T00:00:00Z',
      updated_at: '2026-06-28T00:00:00Z',
      creator: { name: 'Test' },
      compatibility: { min_loader_version: '1.0.0', profile: 'bundle-profile-v1' },
      payload: { path: 'payload.kdnab', encoding: 'cbor', encrypted: false },
      summary: 'Testing dependencies',
      description: 'Test bundle',
      languages: ['en'],
      default_language: 'en',
      license: 'Apache-2.0',
      status: 'stable',
      quality_badge: 'tested',
      dependencies: {
        '@scope/dep-a': '^1.0.0',
      },
    };
    fs.writeFileSync(path.join(tmp, 'kdna.json'), JSON.stringify(manifest, null, 2));

    const payload = {
      profile: 'bundle-profile-v1',
      components: [{ id: 'comp-a', path: './comp-a.kdna' }],
    };
    fs.writeFileSync(path.join(tmp, 'payload.kdnab'), cbor.encode(payload));
    fs.writeFileSync(
      path.join(tmp, 'checksums.json'),
      JSON.stringify(core.buildChecksums(tmp), null, 2),
    );
    const assetPath = `${tmp}.kdna`;
    core.pack(tmp, assetPath);

    const plan = core.planLoad(assetPath, { resolveAsset: mockResolveAsset });

    assert.equal(plan.state, 'invalid');
    assert.equal(plan.can_load_now, false);

    const issue = plan.issues.find((issue) => issue.code === 'KDNA_DEPENDENCY_RESOLUTION_FAILED');
    assert.ok(issue);
    assert.match(issue.message, /Dependency mismatch/i);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(`${tmp}.kdna`, { force: true });
  }
});
