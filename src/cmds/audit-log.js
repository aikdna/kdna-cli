/**
 * audit-log.js — CLI load audit log (roadmap-2026.md Story 10)
 *
 * Appends a structured JSON line to ~/.kdna/audit.jsonl only when a user
 * explicitly requests a receipt with `kdna load --audit`. A normal one-shot
 * file load creates no persistent state. The file is append-only and is never
 * rotated or cleared automatically.
 *
 * This audit log is DISTINCT from the daily trace files
 * (~/.kdna/traces/YYYY-MM-DD.jsonl) which record agent observability
 * events. The audit log is the CLI-level load audit trail:
 *
 *   traces  — what domains the agent loaded during a session
 *   audit   — explicitly requested kdna load receipts (success/error)
 *
 * Both are local-only and never sent anywhere.
 *
 * Entry shape:
 * {
 *   "timestamp":   "2026-06-28T11:30:00.000Z",
 *   "event_type":  "load",
 *   "asset_id":    "kdna:domain:writing"  (from kdna.json, optional),
 *   "version":     "0.7.2"               (from kdna.json, optional),
 *   "profile":     "compact",
 *   "as":          "prompt",
 *   "access_mode": "public",
 *   "result":      "success" | "error",
 *   "error_code":  null | "KDNA_DECRYPT_FAILED" | ...,
 *   "duration_ms": 142
 * }
 *
 * Extended by `kdna history --audit`.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const PATHS = require('../paths');

const AUDIT_FILE = PATHS.audit;

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Append one audit entry to ~/.kdna/audit.jsonl.
 * Never throws — audit writes must not block or break the load command.
 *
 * @param {object} entry
 * @param {string} [entry.asset_id]   From kdna.json if available.
 * @param {string} [entry.version]    From kdna.json if available.
 * @param {string} entry.profile      Load profile (compact/full/index/scenario).
 * @param {string} entry.as           Output format (json/prompt/raw).
 * @param {string} [entry.access_mode] public/licensed/remote.
 * @param {'success'|'error'} entry.result
 * @param {string|null} [entry.error_code]
 * @param {number} [entry.duration_ms]
 */
function appendAuditEntry(entry) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
    const record = {
      timestamp: new Date().toISOString(),
      event_type: 'load',
      asset_id: entry.asset_id || null,
      version: entry.version || null,
      profile: entry.profile || null,
      as: entry.as || null,
      access_mode: entry.access_mode || null,
      result: entry.result,
      error_code: entry.error_code || null,
      duration_ms: typeof entry.duration_ms === 'number' ? entry.duration_ms : null,
    };
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(record) + '\n');
  } catch (_) {
    // Audit write failure must never surface to the user
  }
}

// ─── Read ─────────────────────────────────────────────────────────────────────

/**
 * Read all entries from the audit log, optionally filtered.
 *
 * @param {object} [opts]
 * @param {Date}   [opts.since]   Only entries >= this date.
 * @param {string} [opts.result]  'success' | 'error'
 * @param {string} [opts.assetId] Filter by asset_id substring.
 * @returns {Array}
 */
function readAuditLog(opts = {}) {
  const { since, result: resultFilter, assetId } = opts;
  const entries = [];

  if (!fs.existsSync(AUDIT_FILE)) return entries;

  try {
    const lines = fs.readFileSync(AUDIT_FILE, 'utf8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (!parsed || typeof parsed !== 'object' || parsed.event_type !== 'load') continue;
        // Read old records without ever returning their historical absolute
        // asset_path field. Current output has one closed, content-neutral
        // receipt shape even when the local file predates this privacy fix.
        const entry = {
          timestamp: parsed.timestamp || null,
          event_type: 'load',
          asset_id: parsed.asset_id || null,
          version: parsed.version || null,
          profile: parsed.profile || null,
          as: parsed.as || null,
          access_mode: parsed.access_mode || null,
          result: parsed.result,
          error_code: parsed.error_code || null,
          duration_ms: typeof parsed.duration_ms === 'number' ? parsed.duration_ms : null,
        };
        if (since && entry.timestamp) {
          const ts = new Date(entry.timestamp);
          if (ts < since) continue;
        }
        if (resultFilter && entry.result !== resultFilter) continue;
        if (assetId && !(entry.asset_id || '').includes(assetId)) continue;
        entries.push(entry);
      } catch (_) {
        // skip malformed lines
      }
    }
  } catch (_) {
    // unreadable audit file — return what we have
  }

  return entries;
}

/**
 * Compute summary statistics from audit entries.
 *
 * @param {Array} entries
 * @returns {{ total, success, error, error_rate, by_asset, by_error_code }}
 */
function auditStats(entries) {
  const byAsset = {};
  const byErrorCode = {};
  let success = 0;
  let error = 0;

  for (const e of entries) {
    if (e.result === 'success') {
      success++;
    } else {
      error++;
      const code = e.error_code || 'unknown';
      byErrorCode[code] = (byErrorCode[code] || 0) + 1;
    }
    const key = e.asset_id || '(unknown)';
    if (!byAsset[key]) byAsset[key] = { success: 0, error: 0 };
    byAsset[key][e.result === 'success' ? 'success' : 'error']++;
  }

  const total = entries.length;
  return {
    total,
    success,
    error,
    error_rate: total > 0 ? Math.round((error / total) * 100) : 0,
    by_asset: byAsset,
    by_error_code: byErrorCode,
  };
}

module.exports = { appendAuditEntry, readAuditLog, auditStats, AUDIT_FILE };
