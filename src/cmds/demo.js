const fs = require('node:fs');
const path = require('node:path');
const { error, EXIT } = require('./_common');

function cmdDemo(args) {
  const sub = args[0];
  if (sub !== 'minimal') {
    console.error('Usage: kdna demo minimal <output-dir>');
    console.error('  Copies the minimal v1 fixture to the target directory for first-run testing.');
    process.exit(2);
  }
  const dest = args[1];
  if (!dest) {
    console.error('Usage: kdna demo minimal <output-dir>');
    process.exit(2);
  }
  const srcDir = path.join(__dirname, '..', '..', 'fixtures', 'v1-minimal');
  const outDir = path.resolve(dest);
  if (!fs.existsSync(srcDir)) {
    error(`Fixture not found at ${srcDir}`, EXIT.INPUT_ERROR);
  }
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of fs.readdirSync(srcDir)) {
    const s = path.join(srcDir, f);
    const d = path.join(outDir, f);
    if (fs.statSync(s).isFile()) {
      fs.copyFileSync(s, d);
      console.log(`  ${f}`);
    }
  }
  console.log(`Minimal v1 fixture copied to: ${outDir}`);
}

module.exports = { cmdDemo };
