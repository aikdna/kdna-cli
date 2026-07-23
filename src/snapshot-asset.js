'use strict';

const fs = require('node:fs');

const MAX_ASSET_BYTES = 256 * 1024 * 1024;

function snapshotAssetFile(assetPath, fileSystem = fs) {
  const noFollow = fileSystem.constants.O_NOFOLLOW || 0;
  let descriptor;
  try {
    const pathStat = fileSystem.lstatSync(assetPath);
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
      throw new Error('A regular non-symlink packaged .kdna file is required.');
    }
    descriptor = fileSystem.openSync(assetPath, fileSystem.constants.O_RDONLY | noFollow);
    const before = fileSystem.fstatSync(descriptor);
    if (!before.isFile()) throw new Error('A regular packaged .kdna file is required.');
    if (
      pathStat.dev === undefined ||
      pathStat.ino === undefined ||
      before.dev === undefined ||
      before.ino === undefined ||
      pathStat.dev !== before.dev ||
      pathStat.ino !== before.ino
    ) {
      throw new Error('Packaged asset changed before it was opened.');
    }
    if (before.size <= 0 || before.size > MAX_ASSET_BYTES) {
      throw new Error(`Packaged asset must be between 1 and ${MAX_ASSET_BYTES} bytes.`);
    }
    const bytes = fileSystem.readFileSync(descriptor);
    const after = fileSystem.fstatSync(descriptor);
    if (
      bytes.length !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error('Packaged asset changed while it was read.');
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) fileSystem.closeSync(descriptor);
  }
}

module.exports = { MAX_ASSET_BYTES, snapshotAssetFile };
