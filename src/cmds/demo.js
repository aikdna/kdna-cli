const fs = require('node:fs');
const path = require('node:path');

const DEMOS = {
  minimal: {
    fixture: 'minimal',
    label: 'Minimal KDNA Core demo',
  },
  judgment: {
    fixture: 'judgment',
    label: 'Content Review Judgment demo',
  },
};

function cmdDemo(args) {
  const force = args.includes('--force');
  const sub = args.filter((a) => !a.startsWith('--'))[0];

  const demo = DEMOS[sub];
  if (!demo) {
    const names = Object.keys(DEMOS).join('|');
    console.error(`Usage: kdna demo <${names}> <output-dir> [--force] [--password <pw>]`);
    console.error('  minimal   — minimal schema-shape demo (protocol debugging)');
    console.error('  judgment  — real judgment-content demo (recommended first-run)');
    console.error('  --password <pw> — create an encrypted licensed asset (sets access=licensed)');
    process.exit(2);
  }

  const dest = args.filter((a) => !a.startsWith('--'))[1];
  if (!dest) {
    console.error(`Usage: kdna demo ${sub} <output-dir> [--force] [--password <pw>]`);
    process.exit(2);
  }

  const srcDir = path.join(__dirname, '..', '..', 'fixtures', demo.fixture);
  const outDir = path.resolve(dest);

  if (!fs.existsSync(srcDir)) {
    console.error(`Fixture not found at ${srcDir}`);
    process.exit(1);
  }

  if (fs.existsSync(outDir)) {
    const existing = fs.readdirSync(outDir).filter((f) => f !== '.DS_Store');
    if (existing.length > 0 && !force) {
      console.error(`Target already exists and is not empty: ${outDir}`);
      console.error('Use --force to overwrite.');
      process.exit(2);
    }
  }

  fs.mkdirSync(outDir, { recursive: true });
  const copied = [];
  for (const f of fs.readdirSync(srcDir)) {
    const s = path.join(srcDir, f);
    const d = path.join(outDir, f);
    if (fs.statSync(s).isFile()) {
      fs.copyFileSync(s, d);
      copied.push(f);
    }
  }

  // Handle --password: encrypt the payload and set licensed access
  const passwordIndex = args.indexOf('--password');
  if (passwordIndex >= 0) {
    const password = args[passwordIndex + 1];
    if (!password) {
      console.error('Error: --password requires a value');
      process.exit(2);
    }

    const manifestPath = path.join(outDir, 'kdna.json');
    const payloadPath = path.join(outDir, 'payload.kdnab');
    if (!fs.existsSync(manifestPath) || !fs.existsSync(payloadPath)) {
      console.error('Error: fixture missing required entries for encryption');
      process.exit(1);
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    // Set up encryption metadata for a password-protected licensed asset.
    manifest.access = 'licensed';
    manifest.entitlement = { profile: 'password', offline: true, revocable: false };
    const core = require('@aikdna/kdna-core');
    if (
      typeof core.encryptProtectedEntry !== 'function' ||
      typeof core.generateRecoveryCode !== 'function' ||
      typeof core.buildChecksums !== 'function'
    ) {
      throw new Error('Current KDNA Core encryption and checksum APIs are required.');
    }
    manifest.encryption = {
      profile: core.PASSWORD_PROTECTED_PROFILE,
      profile_version: core.ENCRYPTION_PROFILE_VERSION,
      encrypted_entries: ['payload.kdnab'],
    };
    manifest.payload = manifest.payload || {};
    manifest.payload.encrypted = true;
    manifest.payload.encoding = 'cbor';

    // Encrypt the payload through the current Core profile.
    const cbor = require('cbor-x');
    const plaintext = fs.readFileSync(payloadPath);
    const recoveryCode = core.generateRecoveryCode();
    const envelope = core.encryptProtectedEntry(plaintext, {
      entryName: 'payload.kdnab',
      manifest,
      password,
      recoveryCode,
    });
    fs.writeFileSync(payloadPath, cbor.encode(envelope));

    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    // Rebuild checksums after encryption
    const newChecksums = core.buildChecksums(outDir);
    fs.writeFileSync(path.join(outDir, 'checksums.json'), JSON.stringify(newChecksums, null, 2));

    process.stdout.write(`  ${copied.length} file(s) copied, payload encrypted with password\n\n`);
    process.stdout.write(`${demo.label} (encrypted) created at: ${outDir}\n`);
    const shortCode = recoveryCode ? recoveryCode.substring(0, 19) : '';
    if (shortCode) process.stdout.write(`Recovery code: ${recoveryCode}\n\n`);
    process.stdout.write('Next:\n');
    process.stdout.write(`  kdna pack          ${dest} ${dest}.kdna\n`);
    process.stdout.write(`  kdna validate      ${dest}.kdna\n`);
    process.stdout.write(
      `  kdna load          ${dest}.kdna --password=<pw> --profile=compact --as=json\n`,
    );
    return;
  }

  for (const f of copied) process.stdout.write(`  ${f}\n`);
  process.stdout.write(`\n${demo.label} created at: ${outDir}\n\n`);
  process.stdout.write('Next:\n');
  process.stdout.write(`  kdna pack     ${dest} ${dest}.kdna\n`);
  process.stdout.write(`  kdna validate ${dest}.kdna\n`);
  process.stdout.write(`  kdna plan-load ${dest}.kdna\n`);
  process.stdout.write(`  kdna load     ${dest}.kdna --profile=compact --as=json\n`);
}

module.exports = { cmdDemo };
