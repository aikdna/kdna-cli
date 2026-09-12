/**
 * kdna search <keyword> — Search registry by keyword.
 *
 * Matches against: name, description, core_insight, keywords[],
 * domain_field, judgment_patterns. Case-insensitive substring search.
 */

const { RegistryResolver } = require('./registry');
const { EXIT } = require('./cmds/_common');

function matchScore(d, q) {
  const ql = q.toLowerCase();
  let score = 0;

  // Higher weight for stronger signals
  if ((d.name || '').toLowerCase().includes(ql)) score += 10;
  if ((d.id || '').toLowerCase().includes(ql)) score += 8;
  if ((d.keywords || []).some((k) => (k || '').toLowerCase().includes(ql))) score += 6;
  if ((d.core_insight || '').toLowerCase().includes(ql)) score += 4;
  if ((d.description || '').toLowerCase().includes(ql)) score += 3;
  if ((d.domain_field || []).some((f) => (f || '').toLowerCase().includes(ql))) score += 2;
  if ((d.judgment_patterns || []).some((p) => (p || '').toLowerCase().includes(ql))) score += 2;

  return score;
}

function cmdSearch(query, json) {
  if (!query) {
    if (json) {
      console.log(JSON.stringify({ error: 'Usage: kdna search <keyword>' }));
      process.exit(EXIT.INPUT_ERROR);
    }
    console.error('Usage: kdna search <keyword>');
    console.error('       kdna search "content strategy"');
    process.exit(EXIT.INPUT_ERROR);
  }

  const resolver = new RegistryResolver({ allowNetwork: true });
  const domains = (resolver.listAllDomains() || []).filter((d) => d.yanked !== true);

  if (!domains.length) {
    if (json) {
      console.log(JSON.stringify([]));
      process.exit(EXIT.OK);
    }
    console.log('No installable registry entries found. Run: kdna registry refresh');
    return;
  }

  const matches = domains
    .map((d) => ({ d, score: matchScore(d, query) }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!matches.length) {
    if (json) {
      console.log(JSON.stringify([]));
      process.exit(EXIT.OK);
    }
    console.log(`No domains match "${query}".`);
    console.log('');
    console.log('Try:');
    console.log('  kdna list --available     # show everything');
    return;
  }

  if (json) {
    const result = matches.map(({ d, score }) => ({
      name: d.name || d.id || null,
      version: d.version || null,
      type: d.type || 'domain',
      description: d.description || null,
      core_insight: d.core_insight || null,
      keywords: d.keywords || [],
      domain_field: d.domain_field || [],
      judgment_patterns: d.judgment_patterns || [],
      yanked: false,
      deprecated: d.deprecated || false,
      score,
    }));
    console.log(JSON.stringify(result));
    process.exit(EXIT.OK);
  }

  console.log(`Found ${matches.length} matching domain(s) for "${query}":`);
  console.log('');

  for (const { d, score } of matches) {
    const dep = d.deprecated ? ' [deprecated]' : '';
    console.log(
      `  ${(d.name || d.id || '?').padEnd(36)} v${d.version || '?'}  ${(d.type || 'domain').padEnd(8)}  score:${score}${dep}`,
    );
    if (d.description) console.log(`    ${d.description}`);
    if (d.core_insight) console.log(`    » ${d.core_insight}`);
    console.log('');
  }

  console.log(
    `To install: kdna install <name>     # e.g. kdna install ${matches[0].d.name || matches[0].d.id}`,
  );
}

module.exports = { cmdSearch };
