/**
 * KDNA Protected Asset Commands (RFC-0009)
 *
 * Commands:
 *   kdna protect <file.kdna> --out <file.kdna> [--entries <list>]
 *   kdna unlock <file.kdna> [--profile compact|index|full]
 *   kdna recover <file.kdna> --out <file.kdna> [--code-stdin]
 */

const fs = require('fs');
const path = require('path');
const { EXIT, error, promptPassword } = require('./_common');
const {
  createKdnaAssetReader,
  createPasswordDecryptEntry,
  createRecoveryDecryptEntry,
  encryptProtectedEntry,
  generateRecoveryCode,
} = require('@aikdna/kdna-core');

function parseEntriesFlag(flag) {
  if (!flag) return ['KDNA_Core.json'];
  return flag.split(',').map((s) => s.trim());
}

function cmdProtect(args) {
  const file = args[0];
  if (!file)
    error(
      'Usage: kdna protect <file.kdna> --out <file.kdna> [--entries KDNA_Core.json,KDNA_Patterns.json]',
      EXIT.INPUT_ERROR,
    );

  const outIdx = args.indexOf('--out');
  const outPath = outIdx >= 0 ? args[outIdx + 1] : null;
  if (!outPath) error('Missing --out', EXIT.INPUT_ERROR);

  const entriesIdx = args.indexOf('--entries');
  const entriesToEncrypt = parseEntriesFlag(entriesIdx >= 0 ? args[entriesIdx + 1] : null);

  if (!fs.existsSync(file)) error(`File not found: ${file}`, EXIT.INPUT_ERROR);

  const password = promptPassword('Password: ');
  if (!password) error('Password is required.', EXIT.INPUT_ERROR);

  const reader = createKdnaAssetReader();
  const asset = reader.openSync(file);
  const manifest = reader.readManifestSync(asset);

  if (manifest.access === 'protected') {
    error('Asset is already protected. Use recover to change password.', EXIT.INPUT_ERROR);
  }

  // Update manifest
  const newManifest = {
    ...manifest,
    access: 'protected',
    encryption: { profile: 'kdna-password-protected-v1', encrypted_entries: entriesToEncrypt },
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
      const encrypted = encryptProtectedEntry(plaintext, {
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

  // Add mimetype if missing
  if (!zipEntries.mimetype) {
    zipEntries.mimetype = 'application/vnd.aikdna.kdna+zip';
  }

  // Recompute content digest and strip invalidated signature after encryption
  updateManifestDigest(zipEntries, reader);

  const zipBuffer = buildZip(zipEntries);
  fs.writeFileSync(outPath, zipBuffer);

  console.log(`Protected asset written to: ${outPath}`);
  console.log(`Encrypted entries: ${entriesToEncrypt.join(', ')}`);
  console.log('Recovery code: (displayed once — save it)');
  console.log(`  ${recoveryCode}`);
  console.log('  Use `kdna recover` if you forget the password.');
}

function cmdUnlock(args) {
  const file = args[0];
  if (!file)
    error('Usage: kdna unlock <file.kdna> [--profile compact|index|full]', EXIT.INPUT_ERROR);

  const profileIdx = args.indexOf('--profile');
  const profile = profileIdx >= 0 ? args[profileIdx + 1] : 'compact';

  if (!fs.existsSync(file)) error(`File not found: ${file}`, EXIT.INPUT_ERROR);

  const password = promptPassword('Password: ');
  if (!password) error('Password is required.', EXIT.INPUT_ERROR);

  const reader = createKdnaAssetReader();
  const asset = reader.openSync(file);
  const manifest = reader.readManifestSync(asset);

  if (manifest.access !== 'protected') {
    error(`Asset access is "${manifest.access}", expected "protected"`, EXIT.INPUT_ERROR);
  }

  const decryptEntry = createPasswordDecryptEntry({ password });

  try {
    const loaded = reader.loadProfileSync(asset, profile, { decryptEntry });
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

  if (manifest.access !== 'protected') {
    error(`Asset access is "${manifest.access}", expected "protected"`, EXIT.INPUT_ERROR);
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

      // Re-encrypt with new password and new recovery code
      const encrypted = encryptProtectedEntry(plaintext, {
        entryName,
        manifest: {
          ...manifest,
          encryption: { ...manifest.encryption, encrypted_entries: entriesToEncrypt },
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
    zipEntries.mimetype = 'application/vnd.aikdna.kdna+zip';
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
