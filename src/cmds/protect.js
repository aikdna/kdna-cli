/**
 * KDNA Protected Asset Commands (RFC-0009)
 *
 * Commands:
 *   kdna protect <file.kdna> --out <file.kdna> [--entries <list>]
 *   kdna unlock <file.kdna> [--profile compact|index|full]
 *   kdna recover <file.kdna> --out <file.kdna> [--code-stdin]
 */

const fs = require('fs');
const { EXIT, error, promptPassword } = require('./_common');
const {
  createKdnaAssetReader,
  createPasswordDecryptEntry,
  createRecoveryDecryptEntry,
  encryptProtectedEntryScrypt,
  generateRecoveryCode,
  PASSWORD_PROTECTED_SCRYPT_PROFILE,
} = require('@aikdna/kdna-core');

function parseEntriesFlag(flag) {
  // B1: align with kdna-studio -- the canonical encryption target for a
  // password-protected asset is payload.kdnab, not KDNA_Core.json. Legacy
  // KDNA_Core.json-only encryption left the judgment payload readable, which
  // defeated the "protect" promise.
  if (!flag) return ['payload.kdnab'];
  return flag.split(',').map((s) => s.trim());
}

function cmdProtect(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      'Usage: kdna protect <file.kdna> --out <file.kdna> [--password <pw>|--password-stdin] [--entries KDNA_Core.json,KDNA_Patterns.json]\n' +
        '\n' +
        'Encrypt a .kdna asset with a password.\n' +
        '\n' +
        'Arguments:\n' +
        '  <file.kdna>                       Input .kdna asset to protect\n' +
        '  --out <file.kdna>                 Required. Output path for protected asset\n' +
        '  --password <pw>                   Password (insecure — visible in shell history)\n' +
        '  --password-stdin                  Read password from stdin (recommended)\n' +
        '  --entries <list>                  Comma-separated entry names to encrypt\n' +
        '                                    (default: KDNA_Core.json)\n' +
        '\n' +
        'Examples:\n' +
        '  echo "mypass" | kdna protect asset.kdna --out protected.kdna --password-stdin\n' +
        '  kdna protect asset.kdna --out protected.kdna --password mypass\n',
    );
    return;
  }

  const file = args[0];
  if (!file)
    error(
      'Usage: kdna protect <file.kdna> --out <file.kdna> [--password <pw>|--password-stdin] [--entries KDNA_Core.json,KDNA_Patterns.json]\nRun: kdna help protect',
      EXIT.INPUT_ERROR,
    );

  const outIdx = args.indexOf('--out');
  const outPath = outIdx >= 0 ? args[outIdx + 1] : null;
  if (!outPath) error('Missing --out. Run: kdna help protect', EXIT.INPUT_ERROR);

  const entriesIdx = args.indexOf('--entries');
  const entriesToEncrypt = parseEntriesFlag(entriesIdx >= 0 ? args[entriesIdx + 1] : null);

  if (!fs.existsSync(file)) error(`File not found: ${file}`, EXIT.INPUT_ERROR);

  // --password <pw> | --password-stdin | interactive prompt
  let password = null;
  const pwIdx = args.indexOf('--password');
  if (pwIdx >= 0 && args[pwIdx + 1] && !args[pwIdx + 1].startsWith('--')) {
    password = args[pwIdx + 1];
  } else if (args.includes('--password-stdin')) {
    password = require('fs').readFileSync(0, 'utf8').trim();
  } else {
    password = promptPassword('Password: ');
  }
  if (!password) error('Password is required.', EXIT.INPUT_ERROR);

  const reader = createKdnaAssetReader();
  const asset = reader.openSync(file);
  const manifest = reader.readManifestSync(asset);

  if (manifest.access === 'licensed') {
    error('Asset is already protected. Use recover to change password.', EXIT.INPUT_ERROR);
  }

  // Update manifest — B1: migrate to scrypt profile (B2 scrypt is the canonical
  // password-protected envelope as of kdna-core@0.15.0). The old
  // kdna-password-protected-v1 (Argon2id) profile is deprecated; old assets
  // are still loadable, but new protect operations use the scrypt envelope.
  const newManifest = {
    ...manifest,
    access: 'licensed',
    encryption: {
      profile: PASSWORD_PROTECTED_SCRYPT_PROFILE,
      encrypted_entries: entriesToEncrypt,
    },
  };

  // Build new ZIP with encrypted entries
  const allEntries = reader.listEntriesSync(asset);
  const zipEntries = {};
  const recoveryCode = generateRecoveryCode();

  for (const entryName of allEntries) {
    if (entryName === 'kdna.json') {
      zipEntries[entryName] = JSON.stringify(newManifest);
    } else if (entriesToEncrypt.includes(entryName)) {
      const plaintext = reader.readEntrySync(asset, entryName);
      const encrypted = encryptProtectedEntryScrypt(plaintext, {
        entryName,
        manifest: newManifest,
        password,
        recoveryCode,
      });
      zipEntries[entryName] = JSON.stringify(encrypted);
    } else {
      zipEntries[entryName] = reader.readEntrySync(asset, entryName);
    }
  }

  // Add mimetype if missing — use v1 canonical format
  if (!zipEntries.mimetype) {
    zipEntries.mimetype = 'application/vnd.kdna.asset';
  }

  // Recompute content digest and strip invalidated signature after encryption
  updateManifestDigest(zipEntries, reader);

  // Use Core's canonical packer instead of custom buildZip (ADR-003, B1).
  // BUG-2 fix: also write a fresh checksums.json so the protected asset
  // passes `kdna validate` (manifest_digest / asset_digest are recomputed
  // against the encrypted payload).
  const { pack, buildChecksumsV1 } = require('@aikdna/kdna-core');
  const tmpDir = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'kdna-protect-'));
  try {
    for (const [name, data] of Object.entries(zipEntries)) {
      require('node:fs').writeFileSync(require('node:path').join(tmpDir, name), data);
    }
    const rebuiltManifest = JSON.parse(require('node:fs').readFileSync(require('node:path').join(tmpDir, 'kdna.json'), 'utf8'));
    const checksums = buildChecksumsV1(tmpDir, rebuiltManifest);
    require('node:fs').writeFileSync(
      require('node:path').join(tmpDir, 'checksums.json'),
      JSON.stringify(checksums, null, 2),
    );
    pack(tmpDir, outPath);
  } finally {
    require('node:fs').rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`Protected asset written to: ${outPath}`);
  console.log(`Encrypted entries: ${entriesToEncrypt.join(', ')}`);
  console.log('Recovery code: (displayed once — save it)');
  console.log(`  ${recoveryCode}`);
  console.log('  Use `kdna recover` if you forget the password.');
}

function cmdUnlock(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      'Usage: kdna protect unlock <file.kdna> [--password <pw>|--password-stdin] [--profile compact|index|full]\n' +
        '\n' +
        'Decrypt a protected .kdna asset and print its loaded profile.\n' +
        '\n' +
        'Arguments:\n' +
        '  <file.kdna>             Protected .kdna asset\n' +
        '  --password <pw>         Password (insecure)\n' +
        '  --password-stdin        Read password from stdin\n' +
        '  --profile <name>        compact | index | full (default: compact)\n',
    );
    return;
  }

  const file = args[0];
  if (!file)
    error(
      'Usage: kdna protect unlock <file.kdna> [--password <pw>|--password-stdin] [--profile compact|index|full]\nRun: kdna help protect',
      EXIT.INPUT_ERROR,
    );

  const profileIdx = args.indexOf('--profile');
  const profile = profileIdx >= 0 ? args[profileIdx + 1] : 'compact';

  if (!fs.existsSync(file)) error(`File not found: ${file}`, EXIT.INPUT_ERROR);

  let password = null;
  const pwIdx = args.indexOf('--password');
  if (pwIdx >= 0 && args[pwIdx + 1] && !args[pwIdx + 1].startsWith('--')) {
    password = args[pwIdx + 1];
  } else if (args.includes('--password-stdin')) {
    password = require('fs').readFileSync(0, 'utf8').trim();
  } else {
    password = promptPassword('Password: ');
  }
  if (!password) error('Password is required.', EXIT.INPUT_ERROR);

  const reader = createKdnaAssetReader();
  const asset = reader.openSync(file);
  const manifest = reader.readManifestSync(asset);

  if (manifest.access !== 'licensed') {
    error(`Asset access is "${manifest.access}", expected "licensed"`, EXIT.INPUT_ERROR);
  }

  // B1: route through loadAuthorized (the same path `kdna load` uses).
  // The previous implementation called reader.loadProfileSync, which assumes
  // payload.kdnab is CBOR-encoded and triggered cbor-x's
  // "JavaScript does not support arrays, maps, or strings with length over
  // 4294967295" error (BUG-3) when the asset was authored by kdna-studio
  // (JSON-encoded payload). loadAuthorized dispatches to the right decoder
  // and accepts the password directly.
  const profileName = manifest.encryption?.profile;
  if (profileName === 'kdna-password-protected-v1') {
    process.stderr.write(
      'Warning: this asset uses the deprecated kdna-password-protected-v1 ' +
        '(Argon2id) profile. Re-export through `kdna protect` (or kdna-studio ' +
        'export --password) to migrate to the scrypt envelope.\n',
    );
  }

  try {
    const core = require('@aikdna/kdna-core');
    const loaded = core.loadAuthorized(file, { profile, as: 'json', password });
    console.log(JSON.stringify(loaded, null, 2));
  } catch (e) {
    error(`Unlock failed: ${e.message}`, EXIT.TRUST_FAILED);
  }
}

function cmdRecover(args) {
  const file = args[0];
  if (!file)
    error('Usage: kdna recover <file.kdna> --out <file.kdna> [--code-stdin]', EXIT.INPUT_ERROR);

  const outIdx = args.indexOf('--out');
  const outPath = outIdx >= 0 ? args[outIdx + 1] : null;
  if (!outPath) error('Missing --out', EXIT.INPUT_ERROR);

  if (!fs.existsSync(file)) error(`File not found: ${file}`, EXIT.INPUT_ERROR);

  let recoveryCode;
  if (args.includes('--code-stdin')) {
    const stdinData = fs.readFileSync(0, 'utf8').trim();
    if (!stdinData) error('No recovery code provided on stdin.', EXIT.INPUT_ERROR);
    recoveryCode = stdinData;
  } else {
    recoveryCode = promptPassword('Recovery code: ');
    if (!recoveryCode) error('Recovery code is required.', EXIT.INPUT_ERROR);
  }

  const newPassword = promptPassword('New password: ');
  if (!newPassword) error('New password is required.', EXIT.INPUT_ERROR);

  const reader = createKdnaAssetReader();
  const asset = reader.openSync(file);
  const manifest = reader.readManifestSync(asset);

  if (manifest.access !== 'licensed') {
    error(`Asset access is "${manifest.access}", expected "licensed"`, EXIT.INPUT_ERROR);
  }

  const decryptEntry = createRecoveryDecryptEntry({ recoveryCode });

  // Decrypt all encrypted entries with recovery code, then re-encrypt with new password
  const entriesToEncrypt = manifest.encryption?.encrypted_entries || ['KDNA_Core.json'];
  const allEntries = reader.listEntriesSync(asset);
  const zipEntries = {};
  const newRecoveryCode = generateRecoveryCode();

  for (const entryName of allEntries) {
    if (entriesToEncrypt.includes(entryName)) {
      // Decrypt with recovery code
      const encryptedData = reader.readEntrySync(asset, entryName);
      const plaintext = decryptEntry({ entryName, ciphertext: encryptedData, manifest });

      // B1: re-encrypt under the scrypt profile when migrating.
      const encrypted = encryptProtectedEntryScrypt(plaintext, {
        entryName,
        manifest: {
          ...manifest,
          encryption: {
            ...(manifest.encryption || {}),
            profile: PASSWORD_PROTECTED_SCRYPT_PROFILE,
            encrypted_entries: entriesToEncrypt,
          },
        },
        password: newPassword,
        recoveryCode: newRecoveryCode,
      });
      zipEntries[entryName] = JSON.stringify(encrypted);
    } else {
      zipEntries[entryName] = reader.readEntrySync(asset, entryName);
    }
  }

  if (!zipEntries.mimetype) {
    zipEntries.mimetype = 'application/vnd.kdna.asset';
  }

  // Recompute content digest and strip invalidated signature after re-encryption
  updateManifestDigest(zipEntries, reader);

  const zipBuffer = buildZip(zipEntries);
  fs.writeFileSync(outPath, zipBuffer);

  console.log(`Recovered asset written to: ${outPath}`);
  console.log('Password has been reset.');
  console.log('New recovery code: (displayed once — save it)');
  console.log(`  ${newRecoveryCode}`);
  console.log('  The old recovery code is no longer valid.');
}

/**
 * Recompute content_digest after encryption changes and strip invalidated signature fields.
 * The old signature and any stale digest fields are removed because the ciphertext has changed.
 */
function updateManifestDigest(zipEntries, reader) {
  const tempAsset = reader.openSync(buildZip(zipEntries));
  const newDigest = reader.contentDigestSync(tempAsset);
  let manifest = {};
  try {
    manifest = JSON.parse(zipEntries['kdna.json'] || '{}');
  } catch {
    manifest = {};
  }
  delete manifest.signature;
  delete manifest.asset_digest;
  delete manifest.container_sha256;
  manifest.content_digest = newDigest;
  zipEntries['kdna.json'] = JSON.stringify(manifest);
}

// Simple ZIP builder for CLI usage
function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}

function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const [name, value] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name);
    const data = Buffer.from(value);
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(data.length),
      u32(data.length),
      u16(nameBuf.length),
      u16(0),
      nameBuf,
      data,
    ]);
    localParts.push(local);

    centralParts.push(
      Buffer.concat([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(data.length),
        u32(data.length),
        u16(nameBuf.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        nameBuf,
      ]),
    );
    offset += local.length;
  }

  const central = Buffer.concat(centralParts);
  const local = Buffer.concat(localParts);
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(centralParts.length),
    u16(centralParts.length),
    u32(central.length),
    u32(local.length),
    u16(0),
  ]);
  return Buffer.concat([local, central, eocd]);
}

module.exports = {
  buildZip,
  cmdProtect,
  cmdUnlock,
  cmdRecover,
};
