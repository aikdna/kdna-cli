const fs = require('node:fs');
const path = require('node:path');

function cmdDemo(args) {
  const force = args.includes('--force');
  const sub = args.filter((a) => !a.startsWith('--'))[0];
  if (sub !== 'minimal') {
    console.error('Usage: kdna demo minimal <output-dir> [--force]');
    console.error('  Copies the minimal v1 fixture to the target directory for first-run testing.');
    process.exit(2);
  }
  const dest = args.filter((a) => !a.startsWith('--'))[1];
  if (!dest) {
    console.error('Usage: kdna demo minimal <output-dir> [--force]');
    process.exit(2);
  }

  const srcDir = path.join(__dirname, '..', '..', 'fixtures', 'v1-minimal');
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
    if (!force) {
      // empty dir — fine
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

  for (const f of copied) process.stdout.write(`  ${f}\n`);
  process.stdout.write(`\nMinimal KDNA Core v1 demo created at: ${outDir}\n\n`);
  process.stdout.write('Next:\n');
  process.stdout.write(`  kdna inspect  ${dest}\n`);
  process.stdout.write(`  kdna validate ${dest}\n`);
  process.stdout.write(`  kdna pack     ${dest} ${dest}.kdna\n`);
  process.stdout.write(`  kdna validate ${dest}.kdna\n`);
  process.stdout.write(`  kdna plan-load ${dest}.kdna\n`);
  process.stdout.write(`  kdna load     ${dest}.kdna --profile=compact --as=prompt\n`);
}

module.exports = { cmdDemo };
