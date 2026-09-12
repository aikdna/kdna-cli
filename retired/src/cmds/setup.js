function cmdSetup(args = []) {
  const { cmdSetup: runSetup } = require('../setup');
  runSetup(args);
}

module.exports = {
  cmdSetup,
};
