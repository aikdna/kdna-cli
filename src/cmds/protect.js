/**
 * KDNA Protected Asset Commands (RFC-0009)
 *
 * Commands:
 *   kdna protect <file.kdna> --out <file.kdna> [--entries <list>]
 *   kdna protect unlock <file.kdna> [--profile compact|index|full]
 *   kdna protect recover <file.kdna> --out <file.kdna> [--code-stdin]
 */

const fs = require('fs');
const cbor = require('cbor-x');
const { EXIT, error, promptPassword, resolvePassword } = require('./_common');
const {
  createKdnaAssetReader,
  createPasswordDecryptEntry,
  createPasswordDecryptEntryScrypt,
  createRecoveryDecryptEntry,
  ENCRYPTION_PROFILE_VERSION,
  encryptProtectedEntry,
  generateRecoveryCode,
  PASSWORD_PROTECTED_PROFILE,
  PASSWORD_PROTECTED_SCRYPT_PROFILE,
  pack: packAsset,
  buildChecksums,
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
      'Usage: kdna protect <file.kdna> --out <file.kdna> [--password <pw>|--password-stdin] [--entries payload.kdnab]\n' +
        '\n' +
        'Encrypt a .kdna asset with a password.\n' +
        '\n' +
        'Arguments:\n' +
        '  <file.kdna>                       Input .kdna asset to protect\n' +
        '  --out <file.kdna>                 Required. Output path for protected asset\n' +
        '  --password <pw>                   Password (insecure — visible in shell history)\n' +
        '  --password-stdin                  Read password from stdin (preferred)\n' +
        '  --entries payload.kdnab           Entry to encrypt (the only supported target)\n' +
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
      'Usage: kdna protect <file.kdna> --out <file.kdna> [--password <pw>|--password-stdin] [--entries payload.kdnab]\nRun: kdna help protect',
      EXIT.INPUT_ERROR,
    );

  const outIdx = args.indexOf('--out');
  const outPath = outIdx >= 0 ? args[outIdx + 1] : null;
  if (!outPath) error('Missing --out. Run: kdna help protect', EXIT.INPUT_ERROR);

  const entriesIdx = args.indexOf('--entries');
  const entriesToEncrypt = parseEntriesFlag(entriesIdx >= 0 ? args[entriesIdx + 1] : null);
  if (entriesToEncrypt.length !== 1 || entriesToEncrypt[0] !== 'payload.kdnab') {
    error('Only payload.kdnab can be encrypted.', EXIT.INPUT_ERROR);
  }

  if (!fs.existsSync(file)) error(`File not found: ${file}`, EXIT.INPUT_ERROR);

  // Resolve the password via the shared helper (--password-stdin,
  // KDNA_PASSWORD, --password, interactive prompt — in that order).
  // Bug (#60): this block used to be duplicated in cmdUnlock below;
  // the two paths could drift independently. The helper makes them
  // share a single implementation.
  const password = resolvePassword(args);
  if (!password) error('Password is required.', EXIT.INPUT_ERROR);

  const reader = createKdnaAssetReader();
  const asset = reader.openSync(file);
  const manifest = reader.readManifestSync(asset);

  if (manifest.access === 'licensed') {
    error('Asset is already protected. Use recover to change password.', EXIT.INPUT_ERROR);
  }

  // New protected assets use the Argon2id profile shared by JavaScript and
  // Swift runtimes. JavaScript Core keeps the earlier scrypt profile readable
  // as an explicit compatibility input.
  const newManifest = {
    ...manifest,
    access: 'licensed',
    payload: { ...manifest.payload, encrypted: true },
    encryption: {
      profile: PASSWORD_PROTECTED_PROFILE,
      profile_version: ENCRYPTION_PROFILE_VERSION,
      encrypted_entries: entriesToEncrypt,
    },
  };
  for (const stale of ['signature', 'content_digest', 'asset_digest', 'container_sha256']) {
    delete newManifest[stale];
  }

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
      zipEntries[entryName] = cbor.encode(encrypted);
    } else {
      zipEntries[entryName] = reader.readEntrySync(asset, entryName);
    }
  }

  // Add the single current KDNA media type if missing.
  if (!zipEntries.mimetype) {
    zipEntries.mimetype = 'application/vnd.kdna.asset';
  }

  // Use Core's canonical packer instead of custom buildZip (ADR-003, B1).
  // BUG-2 fix: also write a fresh checksums.json so the protected asset
  // passes `kdna validate` (manifest_digest / asset_digest are recomputed
  // against the encrypted payload).
  const { pack, buildChecksums } = require('@aikdna/kdna-core');
  const tmpDir = require('node:fs').mkdtempSync(
    require('node:path').join(require('node:os').tmpdir(), 'kdna-protect-'),
  );
  try {
    for (const [name, data] of Object.entries(zipEntries)) {
      require('node:fs').writeFileSync(require('node:path').join(tmpDir, name), data);
    }
    const rebuiltManifest = JSON.parse(
      require('node:fs').readFileSync(require('node:path').join(tmpDir, 'kdna.json'), 'utf8'),
    );
    const checksums = buildChecksums(tmpDir, rebuiltManifest);
    require('node:fs').writeFileSync(
      require('node:path').join(tmpDir, 'checksums.json'),
      JSON.stringify(checksums, null, 2),
    );
    pack(tmpDir, outPath);
  } finally {
    try {
      require('node:fs').rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {
      process.stderr.write(`Warning: failed to clean up temp directory ${tmpDir}: ${e.message}\n`);
    }
  }
  console.log(`Encrypted entries: ${entriesToEncrypt.join(', ')}`);
  console.log('Recovery code: (displayed once — save it)');
  console.log(`  ${recoveryCode}`);
  console.log('  Use `kdna recover` if you forget the password.');
}

function cmdUnlock(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      'Usage: kdna protect unlock <file.kdna> [--password <pw>|--password-stdin] [--out <file.kdna>] [--profile compact|index|full]\n' +
        '\n' +
        'Decrypt a protected .kdna asset. With --out, write the decrypted asset\n' +
        'to a new file (the original stays encrypted on disk). Without --out,\n' +
        'print the loaded profile JSON to stdout (one-shot decryption view).\n' +
        '\n' +
        'Arguments:\n' +
        '  <file.kdna>             Protected .kdna asset\n' +
        '  --password <pw>         Password (insecure)\n' +
        '  --password-stdin        Read password from stdin\n' +
        '  --out <file.kdna>        Write decrypted asset to this path\n' +
        '  --profile <name>        compact | index | full (default: compact)\n' +
        '\n' +
        'Examples:\n' +
        '  echo "pw" | kdna protect unlock protected.kdna --password-stdin --out clear.kdna\n' +
        '  kdna protect unlock protected.kdna --password pw > loaded.json\n',
    );
    return;
  }

  const file = args[0];
  if (!file)
    error(
      'Usage: kdna protect unlock <file.kdna> [--password <pw>|--password-stdin] [--out <file.kdna>] [--profile compact|index|full]\nRun: kdna help protect',
      EXIT.INPUT_ERROR,
    );

  const profileIdx = args.indexOf('--profile');
  const profile = profileIdx >= 0 ? args[profileIdx + 1] : 'compact';
  const outIdx = args.indexOf('--out');
  const outPath = outIdx >= 0 ? args[outIdx + 1] : null;
  if (outIdx >= 0 && !outPath)
    error('Missing value for --out. Run: kdna help protect', EXIT.INPUT_ERROR);

  if (!fs.existsSync(file)) error(`File not found: ${file}`, EXIT.INPUT_ERROR);

  // Resolve the password via the shared helper (--password-stdin,
  // KDNA_PASSWORD, --password, interactive prompt — in that order).
  // Bug (#60): this block used to be a verbatim copy of the
  // cmdProtect block above. The helper makes the two paths share a
  // single implementation so they can never drift.
  const password = resolvePassword(args);
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
  if (profileName === PASSWORD_PROTECTED_SCRYPT_PROFILE) {
    process.stderr.write(
      'Warning: this asset uses the compatibility scrypt password profile. ' +
        'Unlock and protect it again to write the current Argon2id profile.\n',
    );
  }

  try {
    const core = require('@aikdna/kdna-core');
    const loaded = core.loadAuthorized(file, { profile, as: 'json', password });
    if (outPath) {
      // Write a decrypted, re-packed .kdna (same shape as the input but
      // with manifest.access = public so subsequent kdna load does not
      // require a password). This is the canonical "unlock" semantic:
      // the original stays encrypted; the output is the unprotected copy.
      //
      // Implementation: walk the source asset entry-by-entry, decrypting
      // each entry listed in encryption.encrypted_entries using the declared
      // password profile, and copy through the rest unchanged. Strip
      // access/encryption from the manifest so the unlocked copy is a
      // normal public asset. Re-pack with checksums.
      const reader2 = createKdnaAssetReader();
      const asset2 = reader2.openSync(file);
      const origManifest = reader2.readManifestSync(asset2);
      const decryptEntry =
        profileName === PASSWORD_PROTECTED_SCRYPT_PROFILE
          ? createPasswordDecryptEntryScrypt({ password })
          : createPasswordDecryptEntry({ password });
      const encryptedEntries = origManifest.encryption?.encrypted_entries || [];
      const tmpDir = require('node:fs').mkdtempSync(
        require('node:path').join(require('node:os').tmpdir(), 'kdna-unlock-'),
      );
      try {
        // Strip access/encryption/entitlement from the manifest so the
        // unlocked copy is a normal public asset. (entitlement.profile
        // is inferred from encryption.profile in planLoad; without
        // removing it the unlocked asset would still be expected to
        // require a password.) Also flip payload.encrypted = false
        // because the payload is now stored in plaintext; recompute
        // payload.digest against the new (decrypted) bytes.
        const kdnaJson = { ...origManifest, access: 'public' };
        delete kdnaJson.encryption;
        delete kdnaJson.entitlement;
        if (kdnaJson.payload) {
          kdnaJson.payload.encrypted = false;
        }
        require('node:fs').writeFileSync(
          require('node:path').join(tmpDir, 'kdna.json'),
          JSON.stringify(kdnaJson, null, 2),
        );
        for (const entryName of reader2.listEntriesSync(asset2)) {
          if (entryName === 'kdna.json') continue;
          const buf = reader2.readEntrySync(asset2, entryName);
          if (encryptedEntries.includes(entryName)) {
            const plain = decryptEntry({ entryName, ciphertext: buf, manifest: origManifest });
            require('node:fs').writeFileSync(require('node:path').join(tmpDir, entryName), plain);
            // Recompute payload digest against the decrypted plaintext
            // so payload.digest matches what is now in the .kdna.
            if (entryName === 'payload.kdnab' && kdnaJson.payload) {
              const crypto = require('node:crypto');
              const newDigest = 'sha256:' + crypto.createHash('sha256').update(plain).digest('hex');
              kdnaJson.payload.digest = newDigest;
            }
          } else {
            require('node:fs').writeFileSync(require('node:path').join(tmpDir, entryName), buf);
          }
        }
        // Re-write the (now-updated) kdna.json so payload.digest change is on disk.
        require('node:fs').writeFileSync(
          require('node:path').join(tmpDir, 'kdna.json'),
          JSON.stringify(kdnaJson, null, 2),
        );
        // Compute checksums for the unlocked copy.
        const checksums = buildChecksums(tmpDir, kdnaJson);
        require('node:fs').writeFileSync(
          require('node:path').join(tmpDir, 'checksums.json'),
          JSON.stringify(checksums, null, 2),
        );
        packAsset(tmpDir, outPath);
        console.error(`Unlocked asset written to: ${outPath}`);
      } finally {
        try {
          require('node:fs').rmSync(tmpDir, { recursive: true, force: true });
        } catch (e) {
          process.stderr.write(
            `Warning: failed to clean up temp directory ${tmpDir}: ${e.message}\n`,
          );
        }
      }
    } else {
      console.log(JSON.stringify(loaded, null, 2));
    }
  } catch (e) {
    error(`Unlock failed: ${e.message}`, EXIT.TRUST_FAILED);
  }
}

function cmdRecover(args) {
  const file = args[0];
  if (!file)
    error(
      'Usage: kdna recover <file.kdna> --out <file.kdna> [--code-stdin] [--password <new-password>|--password-stdin]',
      EXIT.INPUT_ERROR,
    );

  const outIdx = args.indexOf('--out');
  const outPath = outIdx >= 0 ? args[outIdx + 1] : null;
  if (!outPath) error('Missing --out', EXIT.INPUT_ERROR);

  if (!fs.existsSync(file)) error(`File not found: ${file}`, EXIT.INPUT_ERROR);

  let recoveryCode;
  if (args.includes('--code-stdin')) {
    // Same TTY-hang guard as --password-stdin: refuse up front rather
    // than blocking on stdin in an interactive session.
    if (process.stdin.isTTY) {
      error(
        '--code-stdin requires the recovery code to be piped in on stdin.\n' +
          'Example:  echo "<recovery-code>" | kdna recover <file.kdna> --out <out.kdna> --code-stdin',
        EXIT.INPUT_ERROR,
      );
    }
    const stdinData = fs.readFileSync(0, 'utf8').trim();
    if (!stdinData) error('No recovery code provided on stdin.', EXIT.INPUT_ERROR);
    recoveryCode = stdinData;
  } else {
    recoveryCode = promptPassword('Recovery code: ');
    if (!recoveryCode) error('Recovery code is required.', EXIT.INPUT_ERROR);
  }

  const newPassword = resolvePassword(args, { prompt: 'New password: ' });
  if (!newPassword) error('New password is required.', EXIT.INPUT_ERROR);

  const reader = createKdnaAssetReader();
  const asset = reader.openSync(file);
  const manifest = reader.readManifestSync(asset);

  if (manifest.access !== 'licensed') {
    error(`Asset access is "${manifest.access}", expected "licensed"`, EXIT.INPUT_ERROR);
  }

  if (manifest.encryption?.profile === PASSWORD_PROTECTED_SCRYPT_PROFILE) {
    error(
      'This compatibility scrypt asset has no recovery slot. Unlock it with its password, then protect it again to create an Argon2id recovery slot.',
      EXIT.INPUT_ERROR,
    );
  }

  const decryptEntry = createRecoveryDecryptEntry({ recoveryCode });

  // Decrypt all encrypted entries with recovery code, then re-encrypt with new password
  const entriesToEncrypt = manifest.encryption?.encrypted_entries || ['payload.kdnab'];
  if (entriesToEncrypt.length !== 1 || entriesToEncrypt[0] !== 'payload.kdnab') {
    error('Only payload.kdnab can be encrypted.', EXIT.INPUT_ERROR);
  }
  const allEntries = reader.listEntriesSync(asset);
  const zipEntries = {};
  const newRecoveryCode = generateRecoveryCode();
  const newManifest = {
    ...manifest,
    payload: { ...manifest.payload, encrypted: true },
    encryption: {
      ...(manifest.encryption || {}),
      profile: PASSWORD_PROTECTED_PROFILE,
      profile_version: ENCRYPTION_PROFILE_VERSION,
      encrypted_entries: entriesToEncrypt,
    },
  };

  for (const entryName of allEntries) {
    if (entryName === 'kdna.json') {
      zipEntries[entryName] = JSON.stringify(newManifest);
    } else if (entriesToEncrypt.includes(entryName)) {
      // Decrypt with recovery code
      const encryptedData = reader.readEntrySync(asset, entryName);
      const plaintext = decryptEntry({ entryName, ciphertext: encryptedData, manifest });

      // Re-encrypt under the current cross-language Argon2id profile.
      const encrypted = encryptProtectedEntry(plaintext, {
        entryName,
        manifest: newManifest,
        password: newPassword,
        recoveryCode: newRecoveryCode,
      });
      zipEntries[entryName] = cbor.encode(encrypted);
    } else {
      zipEntries[entryName] = reader.readEntrySync(asset, entryName);
    }
  }

  if (!zipEntries.mimetype) {
    zipEntries.mimetype = 'application/vnd.kdna.asset';
  }

  // Bug (#65): prior version used the custom buildZip helper and
  // wrote no checksums.json, so the recovered asset failed
  // `kdna validate` immediately after recovery (the verifier expects
  // checksums.json next to the manifest). The fix uses Core's
  // canonical packer (the same path `cmdProtect` already uses) and
  // emits checksums.json for the re-encrypted manifest.
  const tmpDir = require('node:fs').mkdtempSync(
    require('node:path').join(require('node:os').tmpdir(), 'kdna-recover-'),
  );
  try {
    for (const [name, data] of Object.entries(zipEntries)) {
      require('node:fs').writeFileSync(require('node:path').join(tmpDir, name), data);
    }
    // Recompute the manifest's content_digest against the final ZIP
    // and write checksums.json so validators accept the recovered
    // asset.
    const recoveredManifest = JSON.parse(
      require('node:fs').readFileSync(require('node:path').join(tmpDir, 'kdna.json'), 'utf8'),
    );
    const checksums = buildChecksums(tmpDir, recoveredManifest);
    require('node:fs').writeFileSync(
      require('node:path').join(tmpDir, 'checksums.json'),
      JSON.stringify(checksums, null, 2),
    );
    packAsset(tmpDir, outPath);
  } finally {
    try {
      require('node:fs').rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {
      process.stderr.write(`Warning: failed to clean up temp directory ${tmpDir}: ${e.message}\n`);
    }
  }

  console.log(`Recovered asset written to: ${outPath}`);
  console.log('Password has been reset.');
  console.log('New recovery code: (displayed once — save it)');
  console.log(`  ${newRecoveryCode}`);
  console.log('  The old recovery code is no longer valid.');
}

module.exports = {
  cmdProtect,
  cmdUnlock,
  cmdRecover,
};
