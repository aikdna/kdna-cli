const fs = require('fs');
const path = require('path');
const { EXIT } = require('./_common');
const PATHS = require('../paths');

const TRACES_DIR = PATHS.traces;

function ensureTracesDir() {
  fs.mkdirSync(TRACES_DIR, { recursive: true });
}

function todayFile() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return path.join(TRACES_DIR, `${yyyy}-${mm}-${dd}.jsonl`);
}

function traceFiles(sinceDate) {
  ensureTracesDir();
  let files = fs
    .readdirSync(TRACES_DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .sort();
  if (sinceDate) {
    const since = sinceDate instanceof Date ? sinceDate : new Date(sinceDate);
    files = files.filter((f) => {
      const d = f.replace('.jsonl', '');
      return new Date(d) >= since;
    });
  }
  return files.map((f) => path.join(TRACES_DIR, f));
}

function readAllTraces(opts = {}) {
  const { since, agent, domain } = opts;
  const entries = [];
  const files = traceFiles(since);

  for (const file of files) {
    try {
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (agent && entry.agent !== agent) continue;
          if (domain && entry.domain !== domain) continue;
          entries.push(entry);
        } catch {
          /* skip malformed lines */
        }
      }
    } catch {
      /* skip unreadable files */
    }
  }
  return entries;
}

function recordTrace(entry) {
  try {
    ensureTracesDir();
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(todayFile(), line);
  } catch {
    // Traces are observability data. Loading and comparing KDNA assets must not
    // fail just because the local trace directory is unavailable or read-only.
  }
}

function parseSinceFlag(args) {
  const idx = args.indexOf('--since');
  if (idx >= 0 && idx < args.length - 1) {
    const val = args[idx + 1];
    if (val === '7d') {
      const d = new Date();
      d.setDate(d.getDate() - 7);
      return d;
    }
    if (val === '30d') {
      const d = new Date();
      d.setDate(d.getDate() - 30);
      return d;
    }
    if (val === '90d') {
      const d = new Date();
      d.setDate(d.getDate() - 90);
      return d;
    }
    // ISO date
    const parsed = new Date(val);
    if (!isNaN(parsed.getTime())) return parsed;
  }
  // default: last 7 days
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d;
}

function cmdTrace(args) {
  const json = args.includes('--json');
  const exportPath = args.includes('--export') ? args[args.indexOf('--export') + 1] : null;
  const clear = args.includes('--clear');
  const since = parseSinceFlag(args);

  if (clear) {
    if (fs.existsSync(TRACES_DIR)) {
      const files = fs.readdirSync(TRACES_DIR).filter((f) => f.endsWith('.jsonl'));
      for (const f of files) fs.unlinkSync(path.join(TRACES_DIR, f));
    }
    console.log('Trace logs cleared.');
    process.exit(EXIT.OK);
  }

  const entries = readAllTraces({ since });

  if (exportPath) {
    const data = {
      period: { since: since.toISOString(), until: new Date().toISOString() },
      entries,
    };
    fs.writeFileSync(exportPath, JSON.stringify(data, null, 2) + '\n');
    console.log(`Exported ${entries.length} trace entries to ${exportPath}`);
    process.exit(EXIT.OK);
  }

  if (json) {
    console.log(JSON.stringify({ entries, count: entries.length }, null, 2));
    process.exit(EXIT.OK);
  }

  // Human-readable table
  if (entries.length === 0) {
    console.log('No trace entries found.');
    console.log('Load a domain via kdna load or use KDNA in an agent to generate traces.');
    process.exit(EXIT.OK);
  }

  console.log(`${'Timestamp'.padEnd(20)} ${'Agent'.padEnd(15)} ${'Domain'.padEnd(25)} ${'Result'}`);
  console.log('-'.repeat(75));
  for (const e of entries.slice(-50).reverse()) {
    const ts = e.timestamp
      ? new Date(e.timestamp).toISOString().replace('T', ' ').slice(0, 19)
      : 'unknown';
    const agent = (e.agent || 'unknown').padEnd(15);
    const domain = (e.domain || '(none)').padEnd(25);
    const result = e.postvalidate?.result || 'loaded';
    console.log(`${ts} ${agent} ${domain} ${result}`);
  }
  console.log('');
  console.log(
    `${entries.length} entries total. --export <file> for audit export. --clear to reset.`,
  );
}

function cmdHistory(args) {
  const json = args.includes('--json');
  const stats = args.includes('--stats');
  const agentFilter = args.includes('--agent') ? args[args.indexOf('--agent') + 1] : null;
  const domainFilter = args.includes('--domain') ? args[args.indexOf('--domain') + 1] : null;
  const count = parseInt(args.includes('-n') ? args[args.indexOf('-n') + 1] : '20', 10);

  const entries = readAllTraces({ agent: agentFilter, domain: domainFilter });

  if (stats) {
    const total = entries.length;
    const domainCounts = {};
    const agentCounts = {};
    let skipped = 0;

    for (const e of entries) {
      if (e.domain) {
        domainCounts[e.domain] = (domainCounts[e.domain] || 0) + 1;
      } else {
        skipped++;
      }
      if (e.agent) {
        agentCounts[e.agent] = (agentCounts[e.agent] || 0) + 1;
      }
    }

    if (json) {
      console.log(
        JSON.stringify(
          {
            total,
            skipped,
            domainCounts,
            agentCounts,
            skipRate: total > 0 ? Math.round((skipped / total) * 100) : 0,
          },
          null,
          2,
        ),
      );
    } else {
      console.log(`Total KDNA loads: ${total}`);
      console.log(`Skipped (no domain): ${skipped}`);
      if (total > 0) console.log(`Skip rate: ${Math.round((skipped / total) * 100)}%`);
      console.log('');
      console.log('By domain:');
      const sortedDomains = Object.entries(domainCounts).sort((a, b) => b[1] - a[1]);
      for (const [domain, c] of sortedDomains) {
        const pct = total > 0 ? Math.round((c / total) * 100) : 0;
        console.log(`  ${domain}: ${c} (${pct}%)`);
      }
      if (Object.keys(agentCounts).length > 0) {
        console.log('');
        console.log('By agent:');
        for (const [agent, c] of Object.entries(agentCounts)) {
          console.log(`  ${agent}: ${c}`);
        }
      }
    }
    process.exit(EXIT.OK);
  }

  // Recent entries
  const recent = entries.slice(-count).reverse();

  if (json) {
    console.log(JSON.stringify({ entries: recent, total: entries.length }, null, 2));
    process.exit(EXIT.OK);
  }

  if (recent.length === 0) {
    console.log('No history entries found.');
    process.exit(EXIT.OK);
  }

  console.log(
    `${'Timestamp'.padEnd(20)} ${'Agent'.padEnd(15)} ${'Domain'.padEnd(28)} ${'Result'.padEnd(10)} ${'Score'}`,
  );
  console.log('-'.repeat(85));
  for (const e of recent) {
    const ts = e.timestamp
      ? new Date(e.timestamp).toISOString().replace('T', ' ').slice(0, 19)
      : 'unknown';
    const agent = (e.agent || 'unknown').padEnd(15);
    const domain = (e.domain || '(none)').padEnd(28);
    const result = (e.postvalidate?.result || 'loaded').padEnd(10);
    const score = e.postvalidate?.score ? e.postvalidate.score.toFixed(1) : '-';
    console.log(`${ts} ${agent} ${domain} ${result} ${score}`);
  }
  console.log('');
  console.log(
    `Showing ${recent.length} of ${entries.length} total entries. --stats for summary. --domain <name> to filter.`,
  );
}

module.exports = { cmdTrace, cmdHistory, recordTrace, readAllTraces };
