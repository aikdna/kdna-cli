const fs = require('node:fs');
const path = require('node:path');

const DEMOS = {
  minimal: {
    fixture: 'v1-minimal',
    label: 'Minimal KDNA Core v1 demo',
  },
  judgment: {
    fixture: 'v1-judgment',
    label: 'Content Review Judgment demo',
  },
};

function cmdDemo(args) {
  const force = args.includes('--force');
  const sub = args.filter((a) => !a.startsWith('--'))[0];

  const demo = DEMOS[sub];
  if (!demo) {
    const names = Object.keys(DEMOS).join('|');
    console.error(`Usage: kdna demo <${names}> <output-dir> [--force]`);
    console.error('  minimal   — minimal schema-shape v1 demo (protocol debugging)');
    console.error('  judgment  — real judgment-content v1 demo (recommended first-run)');
    process.exit(2);
  }

  const dest = args.filter((a) => !a.startsWith('--'))[1];
  if (!dest) {
    console.error(`Usage: kdna demo ${sub} <output-dir> [--force]`);
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

  for (const f of copied) process.stdout.write(`  ${f}\n`);
  process.stdout.write(`\n${demo.label} created at: ${outDir}\n\n`);
  process.stdout.write('Next:\n');
  process.stdout.write(`  kdna pack     ${dest} ${dest}.kdna\n`);
  process.stdout.write(`  kdna validate ${dest}.kdna\n`);
  process.stdout.write(`  kdna plan-load ${dest}.kdna\n`);
  process.stdout.write(`  kdna load     ${dest}.kdna --profile=compact --as=prompt\n`);
}

module.exports = { cmdDemo };
