const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const PROTOCOL = 'kdna.agent-host/1';
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function createProcessAgentHost(options = {}) {
  const command = requireNonEmptyString(options.command, 'Agent host command');
  const args = options.args === undefined ? [] : options.args;
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new Error('Agent host args must be an array of strings.');
  }
  const timeoutMs = options.timeoutMs === undefined ? 30000 : Number(options.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Agent host timeoutMs must be a positive integer.');
  }
  const maxOutputBytes =
    options.maxOutputBytes === undefined
      ? DEFAULT_MAX_OUTPUT_BYTES
      : Number(options.maxOutputBytes);
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new Error('Agent host maxOutputBytes must be a positive integer.');
  }

  return {
    protocol: PROTOCOL,
    async runStage(request) {
      if (!request || typeof request !== 'object' || Array.isArray(request)) {
        throw new Error('Agent host request must be an object.');
      }
      const requestId = `host_${crypto.randomBytes(12).toString('hex')}`;
      const envelope = {
        ...request,
        protocol: PROTOCOL,
        request_id: requestId,
      };
      return invokeProcess({
        command,
        args,
        timeoutMs,
        maxOutputBytes,
        env: options.env || process.env,
        cwd: options.cwd,
        envelope,
        requestId,
      });
    },
  };
}

function invokeProcess(options) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(options.command, options.args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(new Error(`Agent host could not start: ${error.message}`));
      return;
    }

    const stdoutChunks = [];
    let stdoutBytes = 0;
    let settled = false;
    let outputExceeded = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(reject, new Error(`Agent host timed out after ${options.timeoutMs}ms.`));
    }, options.timeoutMs);

    child.once('error', (error) => {
      finish(reject, new Error(`Agent host could not start: ${error.message}`));
    });

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > options.maxOutputBytes) {
        outputExceeded = true;
        child.kill('SIGTERM');
        finish(reject, new Error(`Agent host output exceeded ${options.maxOutputBytes} bytes.`));
        return;
      }
      stdoutChunks.push(chunk);
    });

    // Drain diagnostics so a verbose host cannot deadlock. Raw diagnostics
    // are deliberately excluded from user-visible errors and traces.
    child.stderr.resume();

    child.once('close', (code, signal) => {
      if (settled || outputExceeded) return;
      if (code !== 0) {
        const suffix = signal ? ` (signal ${signal})` : '';
        finish(reject, new Error(`Agent host exited with code ${code}${suffix}.`));
        return;
      }
      const text = Buffer.concat(stdoutChunks).toString('utf8').trim();
      if (!text) {
        finish(reject, new Error('Agent host returned no response.'));
        return;
      }
      let response;
      try {
        response = JSON.parse(text);
      } catch {
        finish(reject, new Error('Agent host response was not one JSON document.'));
        return;
      }
      if (
        !response ||
        typeof response !== 'object' ||
        Array.isArray(response) ||
        response.protocol !== PROTOCOL ||
        response.request_id !== options.requestId ||
        !response.outcome ||
        typeof response.outcome !== 'object' ||
        Array.isArray(response.outcome)
      ) {
        finish(reject, new Error('Agent host response failed protocol validation.'));
        return;
      }
      const requestJson = JSON.stringify(options.envelope);
      finish(resolve, {
        outcome: response.outcome,
        receipt: {
          protocol: PROTOCOL,
          request_id: options.requestId,
          request_digest: sha256(requestJson),
          response_digest: sha256(text),
        },
      });
    });

    child.stdin.once('error', (error) => {
      finish(reject, new Error(`Agent host request could not be delivered: ${error.message}`));
    });
    child.stdin.end(`${JSON.stringify(options.envelope)}\n`);
  });
}

module.exports = {
  PROTOCOL,
  createProcessAgentHost,
};
