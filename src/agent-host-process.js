'use strict';

const { spawn } = require('node:child_process');

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_MAX_DIAGNOSTIC_BYTES = 64 * 1024;

class AgentHostTransportError extends Error {
  constructor(code, message, deliveryObservation) {
    super(message);
    this.name = 'AgentHostTransportError';
    this.code = code;
    this.deliveryObservation = deliveryObservation;
  }
}

function createProcessAgentHost(options = {}) {
  const command = options.command;
  const args = options.args === undefined ? [] : options.args;
  const core = options.core || require('@aikdna/kdna-core');
  const timeoutMs = options.timeoutMs === undefined ? 30000 : Number(options.timeoutMs);
  const maxOutputBytes =
    options.maxOutputBytes === undefined
      ? DEFAULT_MAX_OUTPUT_BYTES
      : Number(options.maxOutputBytes);
  const maxDiagnosticBytes =
    options.maxDiagnosticBytes === undefined
      ? DEFAULT_MAX_DIAGNOSTIC_BYTES
      : Number(options.maxDiagnosticBytes);

  if (typeof command !== 'string' || command.length === 0) {
    throw new Error('Agent Host command must be a non-empty string.');
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new Error('Agent Host args must be an array of strings.');
  }
  for (const [label, value] of [
    ['timeoutMs', timeoutMs],
    ['maxOutputBytes', maxOutputBytes],
    ['maxDiagnosticBytes', maxDiagnosticBytes],
  ]) {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be positive.`);
  }

  return {
    protocol: 'kdna.agent-host',
    protocolVersion: '0.1.0',
    async run(request) {
      const requestValidation = core.validateAgentHostRequest(request, options.validationContext);
      if (!requestValidation.valid) {
        throw new AgentHostTransportError(
          requestValidation.code,
          'Agent Host request failed Core validation.',
          'not_delivered',
        );
      }
      const raw = await invokeProcess({
        command,
        args,
        env: options.env || process.env,
        cwd: options.cwd,
        timeoutMs,
        maxOutputBytes,
        maxDiagnosticBytes,
        request,
      });
      let receipt;
      try {
        receipt = core.parseRuntimeContractJson(raw, {
          maxBytes: maxOutputBytes,
          maxDepth: 64,
        });
      } catch (error) {
        throw new AgentHostTransportError(
          error.code || 'KDNA_HOST_RESPONSE_INVALID',
          'Agent Host response was not one strict protocol JSON document.',
          'not_observed',
        );
      }
      const receiptValidation = core.validateAgentHostReceipt(receipt, { request });
      if (!receiptValidation.valid) {
        throw new AgentHostTransportError(
          receiptValidation.code,
          'Agent Host receipt failed Core validation.',
          'not_observed',
        );
      }
      return receiptValidation.value;
    },
  };
}

function invokeProcess(options) {
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let delivered = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const chunks = [];

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const fail = (code, message, observation = delivered ? 'not_observed' : 'not_delivered') => {
      if (child && !child.killed) child.kill('SIGTERM');
      finish(reject, new AgentHostTransportError(code, message, observation));
    };

    try {
      child = spawn(options.command, options.args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      reject(
        new AgentHostTransportError(
          'KDNA_HOST_START_FAILED',
          'Agent Host could not start.',
          'not_delivered',
        ),
      );
      return;
    }

    const timer = setTimeout(() => {
      fail('KDNA_HOST_TIMEOUT', `Agent Host timed out after ${options.timeoutMs}ms.`);
    }, options.timeoutMs);

    child.once('error', () => {
      fail('KDNA_HOST_START_FAILED', 'Agent Host could not start.', 'not_delivered');
    });
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > options.maxOutputBytes) {
        fail('KDNA_HOST_OUTPUT_LIMIT', 'Agent Host output exceeded its byte limit.');
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > options.maxDiagnosticBytes) {
        fail('KDNA_HOST_DIAGNOSTIC_LIMIT', 'Agent Host diagnostics exceeded their byte limit.');
      }
    });
    child.once('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        fail('KDNA_HOST_EXIT_FAILED', `Agent Host exited with code ${code}.`);
        return;
      }
      if (stdoutBytes === 0) {
        fail('KDNA_HOST_RESPONSE_MISSING', 'Agent Host returned no receipt.');
        return;
      }
      finish(resolve, Buffer.concat(chunks));
    });
    child.stdin.once('error', () => {
      fail('KDNA_HOST_DELIVERY_FAILED', 'Agent Host request was not delivered.', 'not_delivered');
    });
    const payload = Buffer.from(`${JSON.stringify(options.request)}\n`, 'utf8');
    child.stdin.end(payload, () => {
      delivered = true;
    });
  });
}

module.exports = {
  AgentHostTransportError,
  createProcessAgentHost,
};
