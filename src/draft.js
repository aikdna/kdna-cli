'use strict';
/*
 * Friendly 0.6.0 authoring: a small human/Agent-friendly draft that compiles
 * into the full authored input `kdna create` accepts.
 *
 * Draft format (marker `kdna.draft/1`):
 *   {
 *     format: 'kdna.draft/1',
 *     asset: { id, type?, title, summary, language, version, description?, keywords?, license? },
 *     scope: 'one sentence: what this asset covers and what it does not',
 *     actors: [{ id, name, kind? }],        // kind defaults to 'person'
 *     creator?: 'author' | { id?, name, kind?, statement? },
 *     highest_question: 'the question the whole asset answers',
 *     boundaries: 'asset-level limits' | null,
 *     exceptions?: [{ when, statement?, then?: 'waive'|'replace_boundary', replace_boundary? }],
 *     misuse?: string[],
 *     worldview?: string[],
 *     value_order?: string[],
 *     sources?: [{ id, name?, title?, identity, version?, uri? }],
 *     sections?: [{ id?, number?, title, range?, judgments: string[] }],
 *     relationships?: [{ id?, kind: 'support'|'qualify'|'conflict'|'complement', from, to, statement }],
 *     judgments: [{
 *       id,                                 // e.g. 'update:order'
 *       focus,                              // short title of the judgment
 *       form?: 'conclusion' | 'rule',       // defaults to 'conclusion'
 *       statement,                          // authored conclusion or rule summary
 *       formation_rule?: string | { statement, conditions?: string[] }, // required when form === 'rule'
 *       applies_when,                       // judgment scope sentence
 *       boundaries?: string,                // judgment-level limits
 *       exceptions?: [{ when, statement?, then?: 'waive'|'replace_boundary', replace_boundary? }],
 *       misuse?: string[],
 *       method?: 'feeling' | 'other' | { term, roles: { '<role-or-en-alias>': 'text' }, other? },
 *       answer_kind?: 'preference' | ... | 'other',
 *       answer_other?: string | { name, definition, exclusion_reason }, // required when answer_kind === 'other'
 *       reasons?: string[],
 *       source_refs?: string[],
 *       example?: { summary, context, input?, application, result }
 *     }],                                   // at least one
 *     timestamp?: ISO-8601 'Z' string       // created_at/updated_at; default: now
 *   }
 */
const { randomUUID } = require('node:crypto');

const FORMAT = 'kdna.draft/1';
const SLUG = /^[a-z0-9][a-z0-9._-]*$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const INIT_MODES = new Set(['minimal', 'interview', 'works', 'research']);
const INIT_LANGS = new Set(['en', 'zh']);
const ASSET_TYPES = new Set(['domain', 'cluster', 'tool', 'sample', 'fixture', 'bundle']);
const ACTOR_KINDS = new Set(['person', 'organization', 'collective', 'anonymous', 'asset_native', 'agent']);
const ANSWER_KINDS = new Set([
  'determination', 'classification', 'evaluation', 'status', 'diagnosis',
  'estimate', 'prediction', 'applicability', 'ranking', 'selection',
  'adjustment', 'interpretation', 'stance', 'preference', 'guidance', 'other',
]);
const RELATIONSHIP_TUPLES = Object.freeze({
  support: Object.freeze({ direction: 'directed', fromRole: 'supporter', toRole: 'claim', operator: 'supports', effect: 'offers_support' }),
  complement: Object.freeze({ direction: 'directed', fromRole: 'supplement', toRole: 'base', operator: 'complements', effect: 'adds_perspective' }),
  qualify: Object.freeze({ direction: 'directed', fromRole: 'qualifier', toRole: 'qualified', operator: 'qualifies', effect: 'limits_interpretation' }),
  conflict: Object.freeze({ direction: 'undirected', fromRole: 'side_a', toRole: 'side_b', operator: 'conflicts_with', effect: 'preserves_disagreement' }),
});
const TOP_LEVEL_TYPOS = Object.freeze({
  relation: 'relationships',
  relations: 'relationships',
  links: 'relationships',
  edges: 'relationships',
  boundary: 'boundaries',
  limit: 'boundaries',
  limits: 'boundaries',
  exception: 'exceptions',
  source: 'sources',
  references: 'sources',
  citations: 'sources',
  section: 'sections',
  chapter: 'sections',
  chapters: 'sections',
  author: 'creator (or actors)',
  owner: 'creator (or actors)',
  worldviews: 'worldview',
  values: 'value_order',
  priorities: 'value_order',
  value_orders: 'value_order',
  misuses: 'misuse',
  anti_misuse: 'misuse',
});
const JUDGMENT_TYPOS = Object.freeze({
  boundary: 'boundaries',
  limit: 'boundaries',
  limits: 'boundaries',
  exception: 'exceptions',
  reason: 'reasons',
  rationale: 'reasons',
  rationales: 'reasons',
  source: 'source_refs',
  sources: 'source_refs',
  source_ref: 'source_refs',
  citations: 'source_refs',
  examples: 'example',
  misuses: 'misuse',
  anti_misuse: 'misuse',
  relation: 'top-level "relationships"',
  relations: 'top-level "relationships"',
  relationships: 'top-level "relationships"',
  section: 'top-level "sections"',
  chapter: 'top-level "sections"',
  scope: 'applies_when',
  when: 'applies_when',
  rule: 'form: "rule" with formation_rule',
  policy: 'form: "rule" with formation_rule',
  claim: 'statement',
  conclusion: 'statement',
});
const RELATIONSHIP_TYPOS = Object.freeze({
  type: 'kind',
  source: 'from',
  target: 'to',
  note: 'statement',
  reason: 'statement',
  description: 'statement',
});
const EXCEPTION_TYPOS = Object.freeze({
  condition: 'when',
  trigger: 'when',
  effect: 'then',
  replacement: 'replace_boundary',
  replace_limit: 'replace_boundary',
});
const ABSOLUTIST_RE = /(?:绝不|永远|必须|任何时候|一律|绝对不)|\b(?:always|never|must always|under no circumstances)\b/iu;
const DUPLICATE_ROLE_FIX_HINT = 'Each role in method.components must appear at most once per judgment. Merge statements that share the same role in order into a single component so no authored reasoning is lost.';
const CATCH_ALL_SCOPES = new Set(['all', 'always', 'any', 'everything', 'general', 'universal', '通用', '所有', '所有场景', '任何', '任何场景', '全部', '不限']);

// 1-to-1 ASCII canonical role names and legacy Chinese labels for Core's closed
// `method_roles` vocabulary. Authors in `kdna.draft/1` may write either ASCII
// keys or Chinese role keys; `compileDraft` emits Core's canonical ASCII role keys.
const ROLE_ALIASES_EN = Object.freeze({
  analogy: Object.freeze({
    reference_case: '参照对象',
    correspondence: '对应关系',
    transfer_rule: '借用办法',
    key_differences: '关键差异',
    non_transferable_limits: '不可迁移之处',
  }),
  calculation: Object.freeze({
    inputs_and_meaning: '输入与含义',
    formula_or_relation: '计算关系',
    assumptions: '计算假设',
    bounds: '取值边界',
    error_notes: '误差说明',
  }),
  causal_analysis: Object.freeze({
    phenomenon: '待解释现象',
    causal_link: '原因关系',
    candidate_causes: '候选原因',
    distinguishing_basis: '区分依据',
    counterfactual_cases: '反向情况',
  }),
  criteria_comparison: Object.freeze({
    criterion: '判断标准',
    comparison_method: '对照办法',
    decision_rule: '归结办法',
    baseline_floor: '底线要求',
    exceptions: '例外情况',
  }),
  elimination: Object.freeze({
    candidate_set: '候选范围',
    elimination_criteria: '排除条件',
    retention_rule: '保留办法',
    special_cases: '特殊情况处理',
  }),
  evidence_analysis: Object.freeze({
    materials_used: '所用材料',
    evidence_link: '材料与判断的联系',
    contrary_evidence: '反向材料',
    weighing_rationale: '材料取舍',
  }),
  experience: Object.freeze({
    lesson: '经验要点',
    reference_experience: '参考经历',
    applicable_cases: '适用情形',
    exceptions: '例外情况',
  }),
  feedback: Object.freeze({
    target: '调整目标',
    signal: '反馈信号',
    adjustment_rule: '调整办法',
    stop_condition: '停止条件',
    conflict_handling: '冲突处理',
  }),
  feeling: Object.freeze({
    personal_preference: '个人感受',
    experience_notes: '体验说明',
    preference_shift: '偏好变化',
  }),
  inference: Object.freeze({
    premise: '判断前提',
    derivation: '推导关系',
    key_assumptions: '关键假设',
    exceptions: '例外情况',
  }),
  interpretation: Object.freeze({
    subject_interpreted: '解读对象',
    interpretive_link: '解释关系',
    context: '相关语境',
    cues: '理解线索',
    alternative_readings: '替代解读',
  }),
  observation: Object.freeze({
    observed_basis: '观察依据',
    criteria: '判定口径',
    observation_limits: '观察限制',
  }),
  other: Object.freeze({
    method_description: '方法说明',
    basis: '判断依据',
    relation: '作用关系',
    notes: '补充说明',
    limits: '适用限制',
  }),
  recognition: Object.freeze({
    features: '识别特征',
    category_definition: '类别定义',
    matching_rule: '匹配办法',
    confusable_cases: '易混淆情况',
  }),
  simulation: Object.freeze({
    initial_conditions: '起点条件',
    change_assumptions: '变化假设',
    progression: '演变关系',
    branching_scenarios: '情景分叉',
    inflection_signals: '转折信号',
  }),
  tradeoff: Object.freeze({
    options: '候选方案',
    factors: '比较因素',
    priority_rule: '取舍原则',
    accepted_cost: '不可兼得之处',
    priority_shift: '优先变化',
  }),
});

const ROLE_ALIASES_ZH = Object.freeze(
  Object.fromEntries(
    Object.entries(ROLE_ALIASES_EN).map(([term, map]) => [
      term,
      Object.freeze(Object.fromEntries(Object.entries(map).map(([en, zh]) => [zh, en]))),
    ]),
  ),
);

function englishAliasFor(term, role) {
  const enMap = ROLE_ALIASES_EN[term];
  if (!enMap) return null;
  if (Object.hasOwn(enMap, role)) return role;
  const zhMap = ROLE_ALIASES_ZH[term];
  return zhMap && Object.hasOwn(zhMap, role) ? zhMap[role] : null;
}

function chineseLabelFor(term, role) {
  const enMap = ROLE_ALIASES_EN[term];
  if (!enMap) return null;
  if (Object.hasOwn(enMap, role)) return enMap[role];
  const zhMap = ROLE_ALIASES_ZH[term];
  return zhMap && Object.hasOwn(zhMap, role) ? role : null;
}

function formatRoleLabel(term, canonicalRole) {
  const zh = chineseLabelFor(term, canonicalRole);
  return zh && zh !== canonicalRole ? `${canonicalRole} (${zh})` : canonicalRole;
}

function resolveDraftRoles(term, givenRoles) {
  const zhToEn = ROLE_ALIASES_ZH[term] ?? {};
  const normalized = {};
  const sourceKeysByCanonical = new Map();
  const unknown = [];
  for (const [rawKey, value] of Object.entries(givenRoles)) {
    const canonical = Object.hasOwn(zhToEn, rawKey) ? zhToEn[rawKey] : rawKey;
    if (!sourceKeysByCanonical.has(canonical)) sourceKeysByCanonical.set(canonical, []);
    sourceKeysByCanonical.get(canonical).push(rawKey);
    normalized[canonical] = value;
  }
  const duplicates = [];
  for (const [canonical, keys] of sourceKeysByCanonical.entries()) {
    if (keys.length > 1) duplicates.push({ role: canonical, keys });
  }
  return { normalized, duplicates, unknown };
}

let _cachedRoleTable = undefined;
function roleTable() {
  if (_cachedRoleTable !== undefined) return _cachedRoleTable;
  try {
    const m = require('@aikdna/kdna-core/components');
    _cachedRoleTable = typeof m.getMethodRoleTable === 'function' ? m.getMethodRoleTable() : null;
  } catch { _cachedRoleTable = null; }
  return _cachedRoleTable;
}

function inspectMethodComponents(judgment, table = roleTable()) {
  const term = judgment?.method?.method?.term;
  const roles = table && typeof term === 'string' ? table.roles?.[term] : null;
  if (!roles || !Array.isArray(judgment?.method?.components)) return null;
  const zhToEn = ROLE_ALIASES_ZH[term] ?? {};
  const allowed = new Set([...roles.required, ...roles.optional]);
  const byCanonical = new Map();
  const invalidSet = new Set();
  judgment.method.components.forEach((component, idx) => {
    const r = component?.role;
    if (typeof r !== 'string') return;
    const cid = typeof component?.id === 'string' && component.id.trim() !== '' ? component.id : `#${idx}`;
    const canonical = Object.hasOwn(zhToEn, r) ? zhToEn[r] : r;
    if (!byCanonical.has(canonical)) byCanonical.set(canonical, { rawRoles: [], component_ids: [] });
    const entry = byCanonical.get(canonical);
    entry.rawRoles.push(r);
    entry.component_ids.push(cid);
    if (!allowed.has(canonical)) invalidSet.add(r);
  });
  const duplicate_roles = [];
  for (const [canonical, entry] of byCanonical.entries()) {
    if (entry.component_ids.length > 1) {
      const uniqueRaw = new Set(entry.rawRoles);
      duplicate_roles.push({ role: uniqueRaw.size === 1 ? entry.rawRoles[0] : canonical, component_ids: entry.component_ids });
    }
  }
  const invalid_roles = [...invalidSet];
  const missing_required_roles = roles.required.filter(r => !byCanonical.has(r));
  return {
    term,
    expected: roles.required,
    optional: roles.optional,
    duplicate_roles,
    invalid_roles,
    missing_required_roles,
    ...(duplicate_roles.length ? { fix_hint: DUPLICATE_ROLE_FIX_HINT } : {}),
  };
}

function exampleDraft(mode, lang) {
  const zh = lang === 'zh';
  if (mode === 'interview') {
    return zh ? {
      format: FORMAT,
      asset: { id: 'commitment-priority-tradeoffs', type: 'domain', title: '重要邀约与深度工作排期取舍', summary: '在临时高曝光邀约与已承诺的深度创作周期冲突时的个人判断取舍。', language: 'zh-CN', version: '0.1.0' },
      scope: '适用于个人季度排期中对外部演讲、咨询与合作邀约的承接取舍；家庭健康或紧急事务不在此范围。',
      actors: [{ id: 'author', name: '示例创作者', kind: 'person' }],
      highest_question: '当临时外部邀约与既定深度工作窗口冲突时，应该如何取舍？',
      boundaries: '涉及直系亲属紧急事务或不可抗力履约危机时，停用本排期规则并优先处理现场。',
      judgments: [{
        id: 'decision:first-dilemma',
        focus: '临时高曝光外部邀约与既定深度创作周期冲突时如何抉择',
        statement: '只要新邀约会切碎本周核心深度创作时段且无法延期至下月，就礼貌婉拒或推荐他人，宁可放弃短期曝光也守住整块创作产出。',
        applies_when: '季度核心作品进入冲刺阶段、收到两周内需交付的演讲或客座评审邀请时。',
        boundaries: '当该邀约直接服务于当前核心作品的关键读者验证且准备耗时不超过半天时，可破例承接。',
        method: {
          term: 'tradeoff',
          roles: {
            options: '打断深度工作窗口承接临时邀约，或婉拒邀约继续推进核心作品。',
            factors: '短期外部曝光机会与整块深度思考时间的连续性。',
            priority_rule: '长期代表作的连续打磨优先于零散的短期曝光。',
            accepted_cost: '接受错过部分热门活动露面与短期人情婉拒的心理成本。',
          },
        },
      }],
    } : {
      format: FORMAT,
      asset: { id: 'commitment-priority-tradeoffs', type: 'domain', title: 'Deep work vs. incoming commitment tradeoffs', summary: 'How I weigh short-notice external invitations against protected creative work blocks.', language: 'en', version: '0.1.0' },
      scope: 'Personal scheduling decisions on speaking, advisory, and guest commitments during active deep-work cycles; family emergencies are outside this scope.',
      actors: [{ id: 'author', name: 'Example creator', kind: 'person' }],
      highest_question: 'When a high-visibility short-notice invitation collides with a protected deep-work block, which gives way?',
      boundaries: 'Does not apply to family health emergencies or legally binding obligations.',
      judgments: [{
        id: 'decision:first-dilemma',
        focus: 'Short-notice speaking invitation versus protected deep-work cycle',
        statement: 'Decline or refer out any short-notice invitation that fragments this week’s protected deep-work block unless it can move to next month.',
        applies_when: 'Evaluating new speaking, podcast, or advisory requests due within two weeks during an active writing or product build sprint.',
        boundaries: 'Yields when the event directly tests the current flagship work with core readers and takes under half a day to prepare.',
        method: {
          term: 'tradeoff',
          roles: {
            options: 'Break the protected deep-work calendar to accept a short-notice invitation versus decline and stay on the flagship milestone.',
            factors: 'Short-term visibility and relationship goodwill versus uninterrupted momentum on lasting work.',
            priority_rule: 'Compounding progress on flagship work beats fragmented short-term visibility.',
            accepted_cost: 'Explicitly accept missing some timely events and the discomfort of saying no politely.',
          },
        },
      }],
    };
  }
  if (mode === 'works') {
    return zh ? {
      format: FORMAT,
      asset: { id: 'editorial-craft-standards', type: 'domain', title: '非虚构长文改稿与准入标准', summary: '从既有编辑批注与改稿记录提炼的非虚构文章发表前自检判断。', language: 'zh-CN', version: '0.1.0' },
      scope: '适用于2000字以上的观点随笔、行业分析与案例长文终稿把关；即兴日志与诗歌创作不在此范围。',
      actors: [{ id: 'author', name: '示例专栏编辑', kind: 'person' }],
      highest_question: '一篇非虚构长文在公开发表前需要跨过哪些实质门槛？',
      boundaries: '不适用于仅作私人备忘的灵感草稿或虚构小说文本。',
      judgments: [{
        id: 'work:first-criterion',
        focus: '核心论断发表前是否配有可核查的具体反例或适用边界',
        statement: '凡提出普适性方法论或强结论的长文，发表前必须在正文里写清至少一个真实失灵场景或明确的不适用边界，否则退回重写。',
        applies_when: '审阅准备公开发表的长篇方法论文章、经验复盘或行业评论终稿时。',
        boundaries: '纯粹记录个人一次性的旅行见闻或书评摘录无需强行补写失灵边界。',
        misuse: ['不要把「补充适用边界」误解为在文末贴一段空洞的免责声明。'],
        method: {
          term: 'criteria_comparison',
          roles: {
            criterion: '文章的核心主张是否同时给出了成立前提与明确会失灵的反例场景。',
            comparison_method: '逐段标出全文最强的三个判断句，核对紧随其后是否给出真实案例与边界限定。',
            decision_rule: '三处强主张均具备具体前提与边界即准予发表；若全篇只有单向口号则退回补充。',
          },
        },
        reasons: ['读者最容易照搬文章里最绝对的那句话，而在真正会踩坑的边缘场景里受伤。'],
        example: {
          summary: '远程办公效率长文终稿审校',
          context: '作者写了一篇主张「全员异步文档取代例会」的5000字经验长文。',
          input: '初稿列举了五条异步协作的好处，但完全没提跨部门危机决策与新人上手期的失灵情形。',
          application: '对照核心论断须带失灵边界的标准，要求补充高歧义冲突场景改用短同步会的边界。',
          result: '作者补写两类反例场景后，文章从口号变为可落地的判断指南并顺利刊发。',
        },
      }],
    } : {
      format: FORMAT,
      asset: { id: 'editorial-craft-standards', type: 'domain', title: 'Non-fiction editorial revision standards', summary: 'Distilled pre-publication standards from editorial notes on essays and case studies.', language: 'en', version: '0.1.0' },
      scope: 'Final editorial review of long-form essays, essays of opinion, and analytical case studies; private journals and fiction are excluded.',
      actors: [{ id: 'author', name: 'Example managing editor', kind: 'person' }],
      highest_question: 'What concrete bar must a long-form non-fiction piece clear before publication?',
      boundaries: 'Private field notes and creative fiction are outside this editorial standard.',
      judgments: [{
        id: 'work:first-criterion',
        focus: 'Concrete counter-case or failure boundary alongside strong claims',
        statement: 'Return any prescriptive essay for revision until each major claim names at least one concrete context where it breaks down or stops applying.',
        applies_when: 'Doing final line and structural edits on publishable essays, playbooks, or industry critiques.',
        boundaries: 'Purely narrative travelogues or personal memoirs without prescriptive advice do not require a failure-boundary section.',
        misuse: ['Do not satisfy this bar by tacking a generic one-line disclaimer onto the footer.'],
        method: {
          term: 'criteria_comparison',
          roles: {
            criterion: 'Presence of an explicit applicability premise and at least one concrete counter-case for every major claim.',
            comparison_method: 'Highlight the three strongest claims in the draft and check whether each is paired with a real limit in the body prose.',
            decision_rule: 'Approve for publication when every strong claim carries a real boundary; send back for revision if the piece reads like slogans.',
          },
        },
        reasons: ['Readers copy the sharpest sentence out of context and get burned precisely at the omitted edge cases.'],
        example: {
          summary: 'Async-first management essay review',
          context: 'Author submitted a 3,000-word essay arguing teams should replace all recurring meetings with written memos.',
          input: 'Draft listed five wins of async memos but omitted high-ambiguity conflict resolution and new-hire onboarding.',
          application: 'Applied the failure-boundary criterion and requested concrete cases where live conversation beats memos.',
          result: 'Author added two explicit exceptions and the essay shipped as a grounded editorial guide.',
        },
      }],
    };
  }
  if (mode === 'research') {
    return zh ? {
      format: FORMAT,
      asset: { id: 'queue-retry-positions', type: 'domain', title: '异步任务重试与死信策略研究判断', summary: '基于压测与故障材料确定的异步队列重试上限立场。', language: 'zh-CN', version: '0.1.0' },
      scope: '适用于调用外部第三方支付或通知接口的异步工作队列；内存态幂等重算不在此范围。',
      actors: [{ id: 'author', name: '示例平台工程组', kind: 'organization' }],
      highest_question: '外部依赖抖动时，异步工作队列应如何设定自动重试与隔离边界？',
      boundaries: '当下游明确返回参数非法等4xx确定性拒绝时，禁止进入自动重试。',
      sources: [{
        id: 'src:retry-postmortems',
        name: '网关压测与事故复盘汇总',
        identity: '平台工程组内部网关压测追踪与三次下游抖动复盘记录（示例研究材料）',
        version: '2026-Q1',
      }],
      judgments: [{
        id: 'research:first-position',
        focus: '外部接口超时场景下的指数退避重试上限',
        statement: '对可重试的5xx或网络超时采用带抖动的指数退避，自动重试不超过3次，超限立即转入死信队列等待人工或批量重放。',
        applies_when: '异步消费者调用具备幂等键保护的外部HTTP接口并收到5xx或连接超时。',
        boundaries: '无幂等键保护的扣款或发券接口在确认下游状态前不得自动重放。',
        exceptions: [{
          when: '下游在响应头中显式返回 Retry-After 且队列当前积压低于水位线 30%',
          statement: '尊重下游显式退避窗口，允许在受控积压下放宽等待间隔而非盲目丢入死信。',
          then: 'replace_boundary',
          replace_boundary: '仅对带幂等键的请求按 Retry-After 延迟重试最多 5 次，一旦队列积压超过 30% 立即恢复 3 次硬上限。',
        }],
        source_refs: ['src:retry-postmortems'],
        method: {
          term: 'evidence_analysis',
          roles: {
            materials_used: '过去两季度的网关超时压测报告与三次雪崩事故复盘记录。',
            evidence_link: '压测显示超过3次无上限重试会把队列积压放大4倍并拖垮共享连接池。',
            contrary_evidence: '短暂网络闪断在10秒内恢复时，多重试几次可减少人工重放操作。',
            weighing_rationale: '优先用3次上限与死信隔离阻断级联雪崩，再用批量重放工具弥补长闪断恢复。',
          },
        },
      }],
    } : {
      format: FORMAT,
      asset: { id: 'queue-retry-positions', type: 'domain', title: 'Async webhook retry positions', summary: 'Evidence-backed retry and dead-letter positions for outbound webhook workers.', language: 'en', version: '0.1.0' },
      scope: 'Asynchronous worker queues calling idempotent external HTTP endpoints; non-idempotent mutations without idempotency keys are excluded.',
      actors: [{ id: 'author', name: 'Example platform team', kind: 'organization' }],
      highest_question: 'How aggressively should outbound worker queues retry transient upstream failures before isolating messages?',
      boundaries: 'Deterministic 4xx validation rejections and non-idempotent mutations must never enter automatic retry.',
      sources: [{
        id: 'src:retry-postmortems',
        name: 'Gateway load traces & outage postmortems',
        identity: 'Platform engineering gateway retry load-test traces and three upstream brownout postmortems (sample research record)',
        version: '2026-Q1',
      }],
      judgments: [{
        id: 'research:first-position',
        focus: 'Capped jittered backoff before dead-letter isolation',
        statement: 'Cap automatic retries at three attempts with jittered exponential backoff on 5xx or timeout responses, then route immediately to the dead-letter queue.',
        applies_when: 'Outbound worker tasks carrying an idempotency key that receive HTTP 5xx or socket timeout errors.',
        boundaries: 'Stops immediately on HTTP 4xx responses or whenever an endpoint lacks idempotency-key deduplication.',
        exceptions: [{
          when: 'Upstream returns an explicit Retry-After header while queue depth stays below 30% capacity',
          statement: 'Honor explicit upstream backoff signaling while headroom remains safe.',
          then: 'replace_boundary',
          replace_boundary: 'Retry idempotent requests up to five times honoring Retry-After, reverting to the 3-attempt cap if queue depth exceeds 30%.',
        }],
        source_refs: ['src:retry-postmortems'],
        method: {
          term: 'evidence_analysis',
          roles: {
            materials_used: 'Two quarters of load-test traces and three upstream brownout postmortems.',
            evidence_link: 'Traces showed retries beyond three attempts amplified worker pool saturation 4x without improving success rate during brownouts.',
            contrary_evidence: 'Higher retry caps occasionally auto-healed 60-second partner blips without operator replay.',
            weighing_rationale: 'Preventing cascading worker exhaustion outweighs occasional one-command dead-letter replay after long blips.',
          },
        },
      }],
    };
  }
  return zh ? {
    format: FORMAT,
    asset: { id: 'street-photography-taste', type: 'domain', title: '街头摄影选片与构图偏好', summary: '关于日常街头摄影构图留白与后期克制的个人审美偏好。', language: 'zh-CN', version: '0.1.0' },
    scope: '适用于个人扫街选片、组图编排与基础色调微调；商业棚拍与新闻纪实发稿不在此范围。',
    actors: [{ id: 'author', name: '示例摄影师', kind: 'person' }],
    highest_question: '从一组街头连拍里选片并做基础后期时，怎样的画面更符合我的审美？',
    boundaries: '不适用于客户指定风格指南的商业棚拍或严禁裁剪的新闻纪实供稿。',
    judgments: [{
      id: 'main:first',
      focus: '街头选片时人物动作瞬间与背景干净度的取舍',
      statement: '宁可选一张主体神态与步伐自然、但角落略有杂物的画面，也不选姿态僵硬的「完美构图」空壳照片。',
      applies_when: '在街头连拍的五到十张相近帧里挑出一张留作个人作品集主图时。',
      boundaries: '当背景杂物正好穿过人物头部导致第一眼无法辨认主体时，放弃该帧。',
      answer_kind: 'preference',
      method: 'feeling',
    }],
  } : {
    format: FORMAT,
    asset: { id: 'street-photography-taste', type: 'domain', title: 'Street photography selection taste', summary: 'Personal aesthetic preference for culling candid street frames and light editing.', language: 'en', version: '0.1.0' },
    scope: 'Personal street photography culling, sequencing, and light tonal adjustments; commercial studio briefs and wire photojournalism are outside this scope.',
    actors: [{ id: 'author', name: 'Example photographer', kind: 'person' }],
    highest_question: 'When culling a burst of candid street frames, what makes a photograph worth keeping?',
    boundaries: 'Does not apply to client-directed commercial shoots or photojournalism with strict no-crop rules.',
    judgments: [{
      id: 'main:first',
      focus: 'Candid gesture versus spotless background in street culling',
      statement: 'Keep the frame with an unguarded gesture and natural stride even if an edge carries mild clutter, over a stiffly posed frame with a sterile background.',
      applies_when: 'Selecting one keeper from a burst of five to ten candid street frames for a personal portfolio.',
      boundaries: 'Drop the frame if background clutter cuts directly across the subject’s face and breaks instant readability.',
      answer_kind: 'preference',
      method: 'feeling',
    }],
  };
}

function scaffoldDraft(mode = 'minimal', options = {}) {
  if (!INIT_MODES.has(mode)) {
    throw Object.assign(new Error('KDNA_INVALID_INIT_MODE'), { code: 'KDNA_INVALID_INIT_MODE' });
  }
  const lang = options?.lang ?? 'en';
  if (!INIT_LANGS.has(lang)) {
    throw Object.assign(new Error('KDNA_INVALID_INIT_LANG'), { code: 'KDNA_INVALID_INIT_LANG' });
  }
  if (options?.example === true) {
    return exampleDraft(mode, lang);
  }
  const zh = lang === 'zh';
  if (mode === 'interview') {
    return zh ? {
      format: FORMAT,
      asset: { id: 'my-decision-system', type: 'domain', title: 'TODO: 你的判断系统标题', summary: 'TODO: 用一句话说明这套判断系统帮助决定哪些反复出现的选择', language: 'zh-CN', version: '0.1.0' },
      scope: 'TODO: 说明这套判断系统覆盖的具体工作情境，以及哪些情形不在范围内。',
      actors: [{ id: 'author', name: 'TODO: 作者姓名或团队名称', kind: 'person' }],
      highest_question: 'TODO: 这套判断系统整体回答的核心问题',
      boundaries: 'TODO: 整份资产层面的硬边界（在哪些情形下必须停用或交回人工判断）',
      judgments: [{
        id: 'decision:first-dilemma',
        focus: 'TODO: 两个目标发生冲突时的具体抉择问题',
        statement: 'TODO: 用你自己的话写出可执行的取舍结论（不要写空泛套话）',
        applies_when: 'TODO: 触发这条判断的具体条件（谁、什么任务、什么时机）',
        boundaries: 'TODO: 这条判断停止适用或发生反转的明确阈值/反例条件',
        method: {
          term: 'tradeoff',
          roles: {
            options: 'TODO: 彼此竞争的具体候选方案',
            factors: 'TODO: 在压力下重点权衡的比较因素',
            priority_rule: 'TODO: 哪个因素优先胜出及其理由',
            accepted_cost: 'TODO: 你明确愿意承担的代价或舍弃项',
          },
        },
      }],
    } : {
      format: FORMAT,
      asset: { id: 'my-decision-system', type: 'domain', title: 'TODO: title of your judgment system', summary: 'TODO: one sentence on what recurring choices this system helps decide', language: 'en', version: '0.1.0' },
      scope: 'TODO: the specific work situations this system covers, and what stays outside it.',
      actors: [{ id: 'author', name: 'TODO: author name', kind: 'person' }],
      highest_question: 'TODO: the overarching question this judgment system answers',
      boundaries: 'TODO: asset-wide hard limits where these judgments must stop or yield',
      judgments: [{
        id: 'decision:first-dilemma',
        focus: 'TODO: the contested decision question when two goals collide',
        statement: 'TODO: your operational choice or priority in your own words (not a generic platitude)',
        applies_when: 'TODO: concrete conditions (who, what task, when) under which this choice applies',
        boundaries: 'TODO: exact case or threshold where this rule stops applying or flips',
        method: {
          term: 'tradeoff',
          roles: {
            options: 'TODO: the concrete options being weighed against each other',
            factors: 'TODO: the factors compared under pressure',
            priority_rule: 'TODO: which factor wins first and why',
            accepted_cost: 'TODO: what cost or downside you explicitly accept',
          },
        },
      }],
    };
  }
  if (mode === 'works') {
    return zh ? {
      format: FORMAT,
      asset: { id: 'my-distilled-works', type: 'domain', title: 'TODO: 从既有作品提炼的判断系统标题', summary: 'TODO: 用一句话说明从作者既有作品中提炼出的领域判断', language: 'zh-CN', version: '0.1.0' },
      scope: 'TODO: 原作覆盖的领域与受众情境，以及明确排除的范围。',
      actors: [{ id: 'author', name: 'TODO: 原作者姓名', kind: 'person' }],
      highest_question: 'TODO: 这些作品共同回答的中心问题',
      boundaries: 'TODO: 整份提炼作品的适用边界',
      judgments: [{
        id: 'work:first-criterion',
        focus: 'TODO: 从作者作品中提炼出的具体常见评审/决策问题',
        statement: 'TODO: 作者明确主张的结论或准入标准',
        applies_when: 'TODO: 作者应用这一标准的具体审阅或创作情境',
        boundaries: 'TODO: 作者指出的例外情形或停止适用边界',
        method: {
          term: 'criteria_comparison',
          roles: {
            criterion: 'TODO: 作者用来衡量对象的明确标准',
            comparison_method: 'TODO: 如何把具体稿件或方案与该标准逐项对照',
            decision_rule: 'TODO: 满足与不满足标准时分别如何做出决定',
          },
        },
        reasons: ['TODO: 来自原作的论证依据或真实观察记录'],
        example: {
          summary: 'TODO: 具体示例案例标题',
          context: 'TODO: 案例发生的背景情境',
          input: 'TODO: 被审视的具体初稿或输入问题',
          application: 'TODO: 如何将该判断标准应用到这一输入上',
          result: 'TODO: 最终作出的修改或处置决定',
        },
      }],
    } : {
      format: FORMAT,
      asset: { id: 'my-distilled-works', type: 'domain', title: 'TODO: title of the distilled judgment work', summary: 'TODO: one sentence on the domain judgments distilled from authored materials', language: 'en', version: '0.1.0' },
      scope: 'TODO: the domain and audience covered by the source works, and what is excluded.',
      actors: [{ id: 'author', name: 'TODO: original author name', kind: 'person' }],
      highest_question: 'TODO: the central question answered across these works',
      boundaries: 'TODO: limits of the distilled work as a whole',
      judgments: [{
        id: 'work:first-criterion',
        focus: 'TODO: specific recurring question distilled from the author’s works',
        statement: 'TODO: the author’s explicit conclusion or standard',
        applies_when: 'TODO: concrete review or writing context where the author applies this standard',
        boundaries: 'TODO: explicit counter-condition or exception stated by the author',
        method: {
          term: 'criteria_comparison',
          roles: {
            criterion: 'TODO: the explicit criterion the author checks against',
            comparison_method: 'TODO: how a concrete work or draft is compared against that criterion',
            decision_rule: 'TODO: how passing vs failing that criterion settles the decision',
          },
        },
        reasons: ['TODO: authored rationale or concrete observation from the source work'],
        example: {
          summary: 'TODO: short title of a concrete example case',
          context: 'TODO: background situation of the case',
          input: 'TODO: specific draft or decision input examined',
          application: 'TODO: how this judgment was applied to that input',
          result: 'TODO: the resulting decision or revision disposition',
        },
      }],
    };
  }
  if (mode === 'research') {
    return zh ? {
      format: FORMAT,
      asset: { id: 'my-research-judgments', type: 'domain', title: 'TODO: 基于资料研究的判断作品标题', summary: 'TODO: 用一句话说明经多源证据对照后确立的领域立场', language: 'zh-CN', version: '0.1.0' },
      scope: 'TODO: 研究覆盖的准确领域、证据时效范围及排除在外的场景。',
      actors: [{ id: 'author', name: 'TODO: 采纳并承担这些判断立场的主体名称', kind: 'person' }],
      highest_question: 'TODO: 基于研究资料重点回答的核心领域问题',
      boundaries: 'TODO: 证据边界、法域限制或需要重新核证的触发条件',
      judgments: [{
        id: 'research:first-position',
        focus: 'TODO: 存在竞争性证据的具体技术或领域问题',
        statement: 'TODO: 权衡证据后明确采纳的立场结论',
        applies_when: 'TODO: 与支撑证据相匹配的具体运行或业务条件',
        boundaries: 'TODO: 证据缺失或反向条件出现时该立场不再成立的边界',
        method: {
          term: 'evidence_analysis',
          roles: {
            materials_used: 'TODO: 审阅过的授权资料、基准测试或标准规范',
            evidence_link: 'TODO: 这些材料如何支撑所采纳的立场',
            contrary_evidence: 'TODO: 已审视过的相反证据或竞争方案表现',
            weighing_rationale: 'TODO: 为何在声明范围内采纳当前立场而非替代方案',
          },
        },
      }],
    } : {
      format: FORMAT,
      asset: { id: 'my-research-judgments', type: 'domain', title: 'TODO: title of the evidence-backed judgment work', summary: 'TODO: one sentence on the domain decisions grounded in compared materials', language: 'en', version: '0.1.0' },
      scope: 'TODO: exact domain, evidence horizon, and contexts outside scope.',
      actors: [{ id: 'author', name: 'TODO: decision owner adopting these positions', kind: 'person' }],
      highest_question: 'TODO: the core domain question evaluated from the research materials',
      boundaries: 'TODO: evidence limits, jurisdiction boundaries, or conditions requiring fresh verification',
      judgments: [{
        id: 'research:first-position',
        focus: 'TODO: contested technical or domain question with competing evidence',
        statement: 'TODO: the adopted position chosen after weighing the evidence',
        applies_when: 'TODO: specific operating conditions matching the supporting evidence',
        boundaries: 'TODO: counter-conditions or missing-evidence cases where this position does not hold',
        method: {
          term: 'evidence_analysis',
          roles: {
            materials_used: 'TODO: the authorized evidence or standards examined',
            evidence_link: 'TODO: how those materials support the adopted position',
            contrary_evidence: 'TODO: competing or contrary evidence considered',
            weighing_rationale: 'TODO: why the adopted position was chosen under the stated scope',
          },
        },
      }],
    };
  }
  return zh ? {
    format: FORMAT,
    asset: { id: 'my-first-judgment', type: 'domain', title: 'TODO: 这份判断资产的标题', summary: 'TODO: 用一句话说明这份资产帮助做出什么决定', language: 'zh-CN', version: '0.1.0' },
    scope: 'TODO: 这份资产覆盖什么场景，以及不覆盖什么场景。',
    actors: [{ id: 'author', name: 'TODO: 作者或团队名称', kind: 'person' }],
    highest_question: 'TODO: 整份资产回答的核心问题',
    boundaries: 'TODO: 整份资产层面的适用边界（或设为 null）',
    judgments: [{
      id: 'main:first',
      focus: 'TODO: 第一条判断的简短议题标题',
      statement: 'TODO: 你本人认可并愿意署名负责的判断结论',
      applies_when: 'TODO: 这条判断适用的具体情境',
      boundaries: 'TODO: 这条判断停止适用的边界条件（或删除此字段）',
      method: 'feeling',
    }],
  } : {
    format: FORMAT,
    asset: { id: 'my-first-judgment', type: 'domain', title: 'TODO: a title for this asset', summary: 'TODO: one sentence on what this asset helps decide', language: 'en', version: '0.1.0' },
    scope: 'TODO: what this asset covers, and what it does not cover.',
    actors: [{ id: 'author', name: 'TODO: author or team name', kind: 'person' }],
    highest_question: 'TODO: the question this whole asset answers',
    boundaries: 'TODO: limits of the asset as a whole (or set to null)',
    judgments: [{
      id: 'main:first',
      focus: 'TODO: short title of the first judgment',
      statement: 'TODO: the conclusion you stand behind, in your own words',
      applies_when: 'TODO: the situation in which this judgment applies',
      boundaries: 'TODO: where this judgment stops applying (or remove this field)',
      method: 'feeling',
    }],
  };
}

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const isText = v => typeof v === 'string' && v.trim() !== '';
const todo = v => typeof v === 'string' && /^TODO\b/.test(v.trim());

function diag(field, code, message, hint) { return { field, code, message, hint }; }

function typoHint(key, map, allowedList) {
  const suggestion = Object.hasOwn(map, key) ? map[key] : null;
  const base = `Allowed: ${allowedList.join(', ')}.`;
  return suggestion ? `Did you mean ${suggestion.startsWith('top-level') || suggestion.includes('"') ? suggestion : `"${suggestion}"`}? ${base}` : base;
}

function validateStringList(out, field, value, itemLabel) {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some(item => !isText(item))) {
    out.push(diag(field, 'invalid_value', `${field} must be an array of non-empty strings.`, `Provide ["${itemLabel}"] or omit ${field}.`));
    return;
  }
  value.forEach((item, idx) => {
    if (todo(item)) out.push(diag(`${field}[${idx}]`, 'placeholder_not_replaced', `${field}[${idx}] still holds a TODO placeholder.`, `Replace it with ${itemLabel}.`));
  });
}

function validateDraftExceptions(out, field, list, boundariesField, boundariesValue, need) {
  if (list === undefined) return;
  if (!Array.isArray(list)) {
    out.push(diag(field, 'invalid_value', `${field} must be an array of exception objects.`, 'Use [{when:"...", then:"waive"}] or [{when:"...", then:"replace_boundary", replace_boundary:"..."}].'));
    return;
  }
  if (list.length > 0 && (!isText(boundariesValue) || todo(boundariesValue))) {
    out.push(diag(boundariesField, 'missing_field', `${field} requires a non-empty ${boundariesField} string for those exceptions to qualify.`, `Add a ${boundariesField} statement on this ${boundariesField === 'boundaries' ? 'asset' : 'judgment'}.`));
  }
  const allowedExcKeys = ['when', 'statement', 'then', 'replace_boundary'];
  list.forEach((exc, eIdx) => {
    const ep = `${field}[${eIdx}]`;
    if (!isObj(exc)) {
      out.push(diag(ep, 'invalid_value', `${ep} must be an object.`, 'Use {when:"...", then:"waive"} or {when:"...", replace_boundary:"..."}.'));
      return;
    }
    need(`${ep}.when`, exc.when, 'the condition under which this exception applies');
    if (exc.statement !== undefined) {
      if (!isText(exc.statement)) out.push(diag(`${ep}.statement`, 'invalid_value', `${ep}.statement must be a non-empty string when provided.`, 'Write an exception summary or omit statement.'));
      else if (todo(exc.statement)) out.push(diag(`${ep}.statement`, 'placeholder_not_replaced', `${ep}.statement still holds a TODO placeholder.`, 'Replace it or omit statement.'));
    }
    const inferredThen = exc.then !== undefined ? exc.then : (exc.replace_boundary !== undefined ? 'replace_boundary' : 'waive');
    if (inferredThen !== 'waive' && inferredThen !== 'replace_boundary') {
      const hint = inferredThen === 'replace_limit'
        ? 'Use "replace_boundary" (not "replace_limit") together with replace_boundary: "...".'
        : 'Allowed values for then: "waive", "replace_boundary".';
      out.push(diag(`${ep}.then`, 'invalid_value', `${ep}.then must be "waive" or "replace_boundary".`, hint));
    } else if (inferredThen === 'replace_boundary') {
      need(`${ep}.replace_boundary`, exc.replace_boundary, 'the replacement boundary statement');
    } else if (exc.replace_boundary !== undefined) {
      out.push(diag(`${ep}.replace_boundary`, 'invalid_value', `${ep}.replace_boundary is only allowed when then is "replace_boundary".`, 'Set then: "replace_boundary" or remove replace_boundary.'));
    }
    for (const k of Object.keys(exc)) {
      if (!allowedExcKeys.includes(k)) {
        out.push(diag(`${ep}.${k}`, 'unknown_field', `Unknown exception field "${k}".`, typoHint(k, EXCEPTION_TYPOS, allowedExcKeys)));
      }
    }
  });
}

function validateDraft(draft) {
  const out = [];
  const need = (field, v, what, example) => {
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
      out.push(diag(field, 'missing_field', `${field} is required but missing or empty.`, `Add ${what}${example ? `, e.g. ${example}` : ''}.`));
      return false;
    }
    if (todo(v)) out.push(diag(field, 'placeholder_not_replaced', `${field} still holds the scaffold TODO placeholder.`, `Replace it with ${what}.`));
    return true;
  };
  if (draft.format !== FORMAT) out.push(diag('format', 'bad_format', `format must be "${FORMAT}".`, `Set "format": "${FORMAT}".`));
  const a = draft.asset;
  if (!isObj(a)) out.push(diag('asset', 'missing_field', 'asset is required.', 'Add asset: {id,title,summary,language,version}.'));
  else {
    if (need('asset.id', a.id, 'a lowercase slug', '"team-update"') && typeof a.id === 'string' && !SLUG.test(a.id)) out.push(diag('asset.id', 'invalid_value', 'asset.id must be a lowercase slug (a-z, 0-9, . _ -).', 'Use e.g. "team-update".'));
    if (a.type !== undefined) {
      if (typeof a.type !== 'string' || !ASSET_TYPES.has(a.type)) out.push(diag('asset.type', 'invalid_value', `asset.type must be one of: ${[...ASSET_TYPES].join(', ')}.`, 'Use e.g. "domain" or "sample".'));
    }
    need('asset.title', a.title, 'a title');
    need('asset.summary', a.summary, 'a one-sentence summary');
    need('asset.language', a.language, 'a language tag', '"en"');
    if (need('asset.version', a.version, 'a semantic version', '"0.1.0"') && !/^\d+\.\d+\.\d+$/.test(a.version)) out.push(diag('asset.version', 'invalid_value', 'asset.version must be MAJOR.MINOR.PATCH.', 'Use e.g. "0.1.0".'));
    if (a.description !== undefined) {
      if (!isText(a.description)) out.push(diag('asset.description', 'invalid_value', 'asset.description must be a non-empty string.', 'Write a description or omit the field.'));
      else if (todo(a.description)) out.push(diag('asset.description', 'placeholder_not_replaced', 'asset.description still holds the scaffold TODO placeholder.', 'Replace it with the asset description, or omit the field.'));
    }
    if (a.keywords !== undefined) {
      if (!Array.isArray(a.keywords) || a.keywords.some(k => !isText(k))) out.push(diag('asset.keywords', 'invalid_value', 'asset.keywords must be an array of non-empty strings.', 'Use e.g. ["engineering", "review"].'));
      else a.keywords.forEach((k, idx) => { if (todo(k)) out.push(diag(`asset.keywords[${idx}]`, 'placeholder_not_replaced', `asset.keywords[${idx}] still holds a TODO placeholder.`, 'Replace it with a keyword.')); });
    }
    if (a.license !== undefined) {
      if (!isObj(a.license)) out.push(diag('asset.license', 'invalid_value', 'asset.license must be {identifier, uri?}.', 'Use e.g. {identifier:"CC-BY-4.0", uri:"https://creativecommons.org/licenses/by/4.0/"}.'));
      else {
        need('asset.license.identifier', a.license.identifier, 'a license identifier', '"CC-BY-4.0"');
        if (a.license.uri !== undefined) {
          if (!isText(a.license.uri)) out.push(diag('asset.license.uri', 'invalid_value', 'asset.license.uri must be a non-empty URI string.', 'Provide a valid URI or omit uri.'));
          else if (todo(a.license.uri)) out.push(diag('asset.license.uri', 'placeholder_not_replaced', 'asset.license.uri still holds a TODO placeholder.', 'Replace it with the license URI.'));
        }
        const allowedLicenseKeys = new Set(['identifier', 'uri']);
        for (const k of Object.keys(a.license)) if (!allowedLicenseKeys.has(k)) out.push(diag(`asset.license.${k}`, 'unknown_field', `Unknown asset.license field "${k}".`, 'Allowed: identifier, uri.'));
      }
    }
    const allowedAssetKeys = new Set(['id', 'type', 'title', 'summary', 'language', 'version', 'description', 'keywords', 'license']);
    for (const k of Object.keys(a)) if (!allowedAssetKeys.has(k)) out.push(diag(`asset.${k}`, 'unknown_field', `Unknown asset field "${k}".`, `Allowed: ${[...allowedAssetKeys].join(', ')}.`));
  }
  need('scope', draft.scope, 'a scope sentence');
  need('highest_question', draft.highest_question, 'the question this asset answers');
  if (draft.boundaries !== undefined && draft.boundaries !== null && !isText(draft.boundaries)) out.push(diag('boundaries', 'invalid_value', 'boundaries must be text or null.', 'Write the limits as one sentence, or set null.'));
  else if (todo(draft.boundaries)) out.push(diag('boundaries', 'placeholder_not_replaced', 'boundaries still holds the scaffold TODO placeholder.', 'Replace it with the limits, or set null.'));
  validateDraftExceptions(out, 'exceptions', draft.exceptions, 'boundaries', draft.boundaries, need);
  validateStringList(out, 'misuse', draft.misuse, 'foreseeable misuse warning');
  validateStringList(out, 'worldview', draft.worldview, 'shared worldview premise');
  validateStringList(out, 'value_order', draft.value_order, 'ranked value priority');
  const actorIds = new Set();
  if (!Array.isArray(draft.actors) || !draft.actors.length) out.push(diag('actors', 'missing_field', 'actors needs at least one actor.', 'Add actors: [{id:"author",name:"Your name"}].'));
  else draft.actors.forEach((x, i) => {
    if (!isObj(x)) { out.push(diag(`actors[${i}]`, 'invalid_value', 'actor must be an object.', 'Use {id,name}.')); return; }
    need(`actors[${i}].id`, x.id, 'an actor id', '"author"'); need(`actors[${i}].name`, x.name, 'the actor name');
    if (x.kind !== undefined && (typeof x.kind !== 'string' || !ACTOR_KINDS.has(x.kind))) {
      out.push(diag(`actors[${i}].kind`, 'invalid_value', `actors[${i}].kind must be one of: ${[...ACTOR_KINDS].join(', ')}.`, 'Use e.g. "person" or "organization".'));
    }
    if (isText(x.id)) { if (actorIds.has(x.id)) out.push(diag(`actors[${i}].id`, 'duplicate_id', `Duplicate actor id "${x.id}".`, 'Actor ids must be unique.')); actorIds.add(x.id); }
  });
  if (draft.creator !== undefined) {
    if (typeof draft.creator === 'string') {
      if (!isText(draft.creator)) out.push(diag('creator', 'invalid_value', 'creator must be an actor id string or {id?, name, kind?, statement?}.', 'Reference an id from actors[] or provide {name, kind?}.'));
      else if (todo(draft.creator)) out.push(diag('creator', 'placeholder_not_replaced', 'creator still holds a TODO placeholder.', 'Reference an actor id or set {name, kind?}.'));
      else {
        const bare = draft.creator.startsWith('actor:') ? draft.creator.slice(6) : draft.creator;
        if (actorIds.size > 0 && !actorIds.has(draft.creator) && !actorIds.has(bare)) {
          out.push(diag('creator', 'unknown_reference', `creator "${draft.creator}" does not match any id in actors[].`, `Use one of: ${[...actorIds].join(', ')}, or pass {name, kind?}.`));
        }
      }
    } else if (isObj(draft.creator)) {
      need('creator.name', draft.creator.name, 'the creator name');
      if (draft.creator.id !== undefined) {
        if (!isText(draft.creator.id)) out.push(diag('creator.id', 'invalid_value', 'creator.id must be a non-empty string.', 'Use e.g. "author" or omit id.'));
        else if (todo(draft.creator.id)) out.push(diag('creator.id', 'placeholder_not_replaced', 'creator.id still holds a TODO placeholder.', 'Replace it or omit id.'));
      }
      if (draft.creator.kind !== undefined && (typeof draft.creator.kind !== 'string' || !ACTOR_KINDS.has(draft.creator.kind))) {
        out.push(diag('creator.kind', 'invalid_value', `creator.kind must be one of: ${[...ACTOR_KINDS].join(', ')}.`, 'Use e.g. "person" or "organization".'));
      }
      if (draft.creator.statement !== undefined) {
        if (!isText(draft.creator.statement)) out.push(diag('creator.statement', 'invalid_value', 'creator.statement must be a non-empty string.', 'Write an attribution statement or omit statement.'));
        else if (todo(draft.creator.statement)) out.push(diag('creator.statement', 'placeholder_not_replaced', 'creator.statement still holds a TODO placeholder.', 'Replace it or omit statement.'));
      }
      const allowedCreatorKeys = ['id', 'name', 'kind', 'statement'];
      for (const k of Object.keys(draft.creator)) {
        if (!allowedCreatorKeys.includes(k)) out.push(diag(`creator.${k}`, 'unknown_field', `Unknown creator field "${k}".`, `Allowed: ${allowedCreatorKeys.join(', ')}.`));
      }
    } else {
      out.push(diag('creator', 'invalid_value', 'creator must be an actor id string or {id?, name, kind?, statement?}.', 'Reference an id from actors[] or provide {name, kind?}.'));
    }
  }
  const sourceIds = new Set();
  if (draft.sources !== undefined) {
    if (!Array.isArray(draft.sources)) {
      out.push(diag('sources', 'invalid_value', 'sources must be an array of {id, name?, title?, identity, version?, uri?}.', 'Add sources: [{id:"src:1", identity:"..."}] or omit sources.'));
    } else {
      const allowedSourceKeys = ['id', 'name', 'title', 'identity', 'version', 'uri'];
      draft.sources.forEach((s, sIdx) => {
        const sp = `sources[${sIdx}]`;
        if (!isObj(s)) { out.push(diag(sp, 'invalid_value', `${sp} must be an object.`, 'Use {id, identity}.')); return; }
        if (need(`${sp}.id`, s.id, 'a source id', '"src:1"')) {
          if (sourceIds.has(s.id)) out.push(diag(`${sp}.id`, 'duplicate_id', `Duplicate source id "${s.id}".`, 'Source ids must be unique.'));
          sourceIds.add(s.id);
        }
        need(`${sp}.identity`, s.identity, 'a source citation or identity');
        for (const optKey of ['name', 'title', 'version', 'uri']) {
          if (s[optKey] !== undefined) {
            if (!isText(s[optKey])) out.push(diag(`${sp}.${optKey}`, 'invalid_value', `${sp}.${optKey} must be a non-empty string when provided.`, `Provide ${optKey} or omit it.`));
            else if (todo(s[optKey])) out.push(diag(`${sp}.${optKey}`, 'placeholder_not_replaced', `${sp}.${optKey} still holds a TODO placeholder.`, `Replace ${optKey} or omit it.`));
          }
        }
        for (const k of Object.keys(s)) {
          if (!allowedSourceKeys.includes(k)) out.push(diag(`${sp}.${k}`, 'unknown_field', `Unknown source field "${k}".`, `Allowed: ${allowedSourceKeys.join(', ')}.`));
        }
      });
    }
  }
  const table = roleTable();
  const allowedJudgmentDraftKeys = [
    'id', 'focus', 'form', 'statement', 'formation_rule', 'applies_when',
    'boundaries', 'exceptions', 'misuse', 'method', 'answer_kind', 'answer_other',
    'reasons', 'source_refs', 'example',
  ];
  const allowedJudgmentDraftKeySet = new Set(allowedJudgmentDraftKeys);
  const judgmentIds = new Set();
  if (!Array.isArray(draft.judgments) || !draft.judgments.length) out.push(diag('judgments', 'missing_field', 'judgments needs at least one judgment.', 'Add judgments: [{id,focus,statement,applies_when}].'));
  else {
    draft.judgments.forEach((j, i) => {
      const p = `judgments[${i}]`;
      if (!isObj(j)) { out.push(diag(p, 'invalid_value', 'judgment must be an object.', 'Use {id,focus,statement,applies_when}.')); return; }
      if (need(`${p}.id`, j.id, 'a judgment id', '"main:first"')) { if (judgmentIds.has(j.id)) out.push(diag(`${p}.id`, 'duplicate_id', `Duplicate judgment id "${j.id}".`, 'Judgment ids must be unique.')); judgmentIds.add(j.id); }
      need(`${p}.focus`, j.focus, 'a short focus title');
      const form = j.form === undefined ? 'conclusion' : j.form;
      if (form !== 'conclusion' && form !== 'rule') {
        out.push(diag(`${p}.form`, 'invalid_value', `${p}.form must be "conclusion" or "rule".`, 'Set form to "conclusion" (default) or "rule".'));
      }
      if (form === 'rule') {
        if (j.formation_rule === undefined || j.formation_rule === null) {
          out.push(diag(`${p}.formation_rule`, 'missing_field', `${p}.formation_rule is required when form is "rule".`, 'Provide formation_rule as a string or {statement, conditions?: [...]}.'));
        } else if (typeof j.formation_rule === 'string') {
          need(`${p}.formation_rule`, j.formation_rule, 'a formation rule statement');
        } else if (isObj(j.formation_rule)) {
          need(`${p}.formation_rule.statement`, j.formation_rule.statement, 'a formation rule statement');
          validateStringList(out, `${p}.formation_rule.conditions`, j.formation_rule.conditions, 'rule trigger condition');
          const allowedFrKeys = ['statement', 'conditions'];
          for (const k of Object.keys(j.formation_rule)) {
            if (!allowedFrKeys.includes(k)) out.push(diag(`${p}.formation_rule.${k}`, 'unknown_field', `Unknown formation_rule field "${k}".`, `Allowed: ${allowedFrKeys.join(', ')}.`));
          }
        } else {
          out.push(diag(`${p}.formation_rule`, 'invalid_value', `${p}.formation_rule must be a string or {statement, conditions?: string[]}.`, 'Write the rule statement directly or as {statement, conditions}.'));
        }
        if (j.statement !== undefined) {
          if (!isText(j.statement)) out.push(diag(`${p}.statement`, 'invalid_value', `${p}.statement must be a non-empty string when provided.`, 'Write the rule expression or omit statement to reuse formation_rule.statement.'));
          else if (todo(j.statement)) out.push(diag(`${p}.statement`, 'placeholder_not_replaced', `${p}.statement still holds a TODO placeholder.`, 'Replace it with the rule expression.'));
        }
      } else {
        need(`${p}.statement`, j.statement, 'the authored conclusion');
        if (j.formation_rule !== undefined) {
          out.push(diag(`${p}.formation_rule`, 'invalid_value', `${p}.formation_rule is only allowed when form is "rule".`, 'Set form: "rule" or remove formation_rule.'));
        }
      }
      need(`${p}.applies_when`, j.applies_when, 'when this judgment applies');
      if (j.boundaries !== undefined && j.boundaries !== null && !isText(j.boundaries)) out.push(diag(`${p}.boundaries`, 'invalid_value', 'boundaries must be text or null.', 'Write one sentence, or remove the field.'));
      else if (todo(j.boundaries)) out.push(diag(`${p}.boundaries`, 'placeholder_not_replaced', 'boundaries still holds the scaffold TODO placeholder.', 'Replace it, or remove the field.'));
      validateDraftExceptions(out, `${p}.exceptions`, j.exceptions, `${p}.boundaries`, j.boundaries, need);
      validateStringList(out, `${p}.misuse`, j.misuse, 'foreseeable misuse warning');
      if (j.answer_kind !== undefined) {
        if (j.answer_kind === 'composite') {
          out.push(diag(`${p}.answer_kind`, 'invalid_value', `${p}.answer_kind "composite" is not supported in kdna.draft/1.`, 'Use a single answer_kind in kdna.draft/1, or author answer_parts + record result_contract in full authored JSON.'));
        } else if (typeof j.answer_kind !== 'string' || !ANSWER_KINDS.has(j.answer_kind)) {
          out.push(diag(`${p}.answer_kind`, 'invalid_value', `${p}.answer_kind must be one of Core's allowed answer kinds.`, `Allowed: ${[...ANSWER_KINDS].join(', ')}.`));
        }
      }
      if (j.answer_kind === 'other') {
        if (j.answer_other === undefined || j.answer_other === null) {
          out.push(diag(`${p}.answer_other`, 'missing_field', `${p}.answer_other is required when answer_kind is "other".`, 'Pass a concise explanation string (auto-expanded) or {name, definition, exclusion_reason}.'));
        } else if (typeof j.answer_other === 'string') {
          need(`${p}.answer_other`, j.answer_other, 'why this question stays open or outside standard answer kinds');
        } else if (isObj(j.answer_other)) {
          need(`${p}.answer_other.name`, j.answer_other.name, 'a short label for this answer kind');
          need(`${p}.answer_other.definition`, j.answer_other.definition, 'what this open/other answer represents');
          need(`${p}.answer_other.exclusion_reason`, j.answer_other.exclusion_reason, 'why standard answer kinds do not fit');
          const allowedAoKeys = ['name', 'definition', 'exclusion_reason'];
          for (const k of Object.keys(j.answer_other)) {
            if (!allowedAoKeys.includes(k)) out.push(diag(`${p}.answer_other.${k}`, 'unknown_field', `Unknown answer_other field "${k}".`, `Allowed: ${allowedAoKeys.join(', ')}.`));
          }
        } else {
          out.push(diag(`${p}.answer_other`, 'invalid_value', `${p}.answer_other must be a non-empty string or {name, definition, exclusion_reason}.`, 'Write a short explanation string or full 3-key object.'));
        }
      } else if (j.answer_other !== undefined) {
        out.push(diag(`${p}.answer_other`, 'invalid_value', `${p}.answer_other is only allowed when answer_kind is "other".`, 'Set answer_kind: "other" or remove answer_other.'));
      }
      const m = j.method === undefined ? 'other' : j.method;
      const term = typeof m === 'string' ? m : m?.term;
      const roles = table && typeof term === 'string' ? table.roles?.[term] : null;
      if (typeof term !== 'string' || (table && !roles)) out.push(diag(`${p}.method`, 'invalid_method', `Unknown method${typeof term === 'string' ? ` "${term}"` : ''}.`, table ? `Use one of: ${Object.keys(table.roles).join(', ')}.` : 'Use a Core method term.'));
      else if (typeof m === 'string' && term !== 'feeling' && term !== 'other') {
        const reqSnippet = roles.required.map(r => `"${englishAliasFor(term, r) ?? r}":"..."`).join(', ');
        out.push(diag(`${p}.method`, 'method_roles_required', `Method "${term}" needs its roles written out.`, `Use method: {term:"${term}", roles:{${reqSnippet}}}.`));
      } else if (isObj(m)) {
        const given = isObj(m.roles) ? m.roles : {};
        const { normalized, duplicates } = resolveDraftRoles(term, given);
        if (duplicates.length) {
          out.push(diag(`${p}.method.roles`, 'duplicate_method_roles',
            `Method "${term}" specifies the same role more than once: ${duplicates.map(d => `${d.role} (via ${d.keys.join(', ')})`).join('; ')}.`,
            DUPLICATE_ROLE_FIX_HINT));
        }
        const missing = roles.required.filter(r => !isText(normalized[r]));
        if (missing.length) {
          const missingLabels = missing.map(r => formatRoleLabel(term, r));
          const addSnippet = missing.map(r => `"${englishAliasFor(term, r) ?? r}":"..."`).join(', ');
          const optLabels = roles.optional.map(r => formatRoleLabel(term, r)).join(', ');
          out.push(diag(`${p}.method.roles`, 'method_roles_missing', `Method "${term}" is missing required roles: ${missingLabels.join(', ')}.`, `Add roles ${addSnippet}. Optional: ${optLabels}.`));
        }
        const allowedCanonical = new Set([...roles.required, ...roles.optional]);
        const zhToEn = ROLE_ALIASES_ZH[term] ?? {};
        const unknown = Object.keys(given).filter(rk => !allowedCanonical.has(Object.hasOwn(zhToEn, rk) ? zhToEn[rk] : rk));
        if (unknown.length) {
          const allowedLabels = [...roles.required, ...roles.optional].map(r => formatRoleLabel(term, r)).join(', ');
          out.push(diag(`${p}.method.roles`, 'method_roles_unknown', `Method "${term}" has unknown roles: ${unknown.join(', ')}.`, `Allowed: ${allowedLabels}.`));
        }
        if (m.other !== undefined) {
          if (term !== 'other') out.push(diag(`${p}.method.other`, 'invalid_value', `${p}.method.other is only allowed when method.term is "other".`, 'Remove method.other or set method.term to "other".'));
          else if (!isObj(m.other)) out.push(diag(`${p}.method.other`, 'invalid_value', `${p}.method.other must be {name, definition, exclusion_reason}.`, 'Provide name, definition, and exclusion_reason, or omit method.other to use the default unstated-method definition.'));
          else {
            need(`${p}.method.other.name`, m.other.name, 'a short method name');
            need(`${p}.method.other.definition`, m.other.definition, 'a definition of this method');
            need(`${p}.method.other.exclusion_reason`, m.other.exclusion_reason, 'why standard method terms do not fit');
          }
        }
        for (const [rk, rv] of Object.entries(given)) {
          if (todo(rv)) out.push(diag(`${p}.method.roles.${rk}`, 'placeholder_not_replaced', `${p}.method.roles.${rk} still holds the scaffold TODO placeholder.`, `Replace it with the authored "${rk}" statement.`));
        }
      }
      if (j.reasons !== undefined) {
        if (!Array.isArray(j.reasons) || j.reasons.some(r => !isText(r))) out.push(diag(`${p}.reasons`, 'invalid_value', `${p}.reasons must be an array of non-empty strings.`, 'Provide ["authored rationale"] or omit reasons.'));
        else j.reasons.forEach((r, rIdx) => { if (todo(r)) out.push(diag(`${p}.reasons[${rIdx}]`, 'placeholder_not_replaced', `${p}.reasons[${rIdx}] still holds a TODO placeholder.`, 'Replace it with an authored rationale or omit reasons.')); });
      }
      if (j.source_refs !== undefined) {
        if (!Array.isArray(j.source_refs) || j.source_refs.some(sr => !isText(sr))) {
          out.push(diag(`${p}.source_refs`, 'invalid_value', `${p}.source_refs must be an array of source id strings.`, 'Reference ids declared in top-level sources[].'));
        } else {
          const seenRefs = new Set();
          j.source_refs.forEach((sr, srIdx) => {
            if (todo(sr)) out.push(diag(`${p}.source_refs[${srIdx}]`, 'placeholder_not_replaced', `${p}.source_refs[${srIdx}] still holds a TODO placeholder.`, 'Replace with a source id from sources[].'));
            else if (seenRefs.has(sr)) out.push(diag(`${p}.source_refs[${srIdx}]`, 'duplicate_reference', `Duplicate source_ref "${sr}" on ${p}.`, 'List each source id at most once per judgment.'));
            else if (!sourceIds.has(sr)) out.push(diag(`${p}.source_refs[${srIdx}]`, 'unknown_reference', `source_ref "${sr}" does not match any id in top-level sources[].`, sourceIds.size ? `Allowed source ids: ${[...sourceIds].join(', ')}.` : 'Declare top-level sources: [{id, identity}] first.'));
            seenRefs.add(sr);
          });
        }
      }
      if (j.example !== undefined) {
        if (!isObj(j.example)) out.push(diag(`${p}.example`, 'invalid_value', `${p}.example must be {summary, context, input?, application, result}.`, 'Provide an example object or omit example.'));
        else {
          need(`${p}.example.summary`, j.example.summary, 'an example summary title');
          need(`${p}.example.context`, j.example.context, 'the example context');
          if (j.example.input !== undefined) {
            if (!isText(j.example.input)) out.push(diag(`${p}.example.input`, 'invalid_value', `${p}.example.input must be a non-empty string when provided.`, 'Write the input case or omit input.'));
            else if (todo(j.example.input)) out.push(diag(`${p}.example.input`, 'placeholder_not_replaced', `${p}.example.input still holds a TODO placeholder.`, 'Replace it with the input case or omit input.'));
          }
          need(`${p}.example.application`, j.example.application, 'how the judgment applies');
          need(`${p}.example.result`, j.example.result, 'the resulting disposition');
          const allowedExampleKeys = new Set(['summary', 'context', 'input', 'application', 'result']);
          for (const k of Object.keys(j.example)) if (!allowedExampleKeys.has(k)) out.push(diag(`${p}.example.${k}`, 'unknown_field', `Unknown example field "${k}".`, 'Allowed: summary, context, input, application, result.'));
        }
      }
      for (const k of Object.keys(j)) if (!allowedJudgmentDraftKeySet.has(k)) out.push(diag(`${p}.${k}`, 'unknown_field', `Unknown judgment field "${k}".`, typoHint(k, JUDGMENT_TYPOS, allowedJudgmentDraftKeys)));
    });
  }
  if (draft.relationships !== undefined) {
    if (!Array.isArray(draft.relationships)) {
      out.push(diag('relationships', 'invalid_value', 'relationships must be an array of {kind, from, to, statement}.', 'Use [{kind:"qualify", from:"j:1", to:"j:2", statement:"..."}].'));
    } else {
      const allowedRelKeys = ['id', 'kind', 'from', 'to', 'statement'];
      const relIds = new Set();
      draft.relationships.forEach((rel, rIdx) => {
        const rp = `relationships[${rIdx}]`;
        if (!isObj(rel)) { out.push(diag(rp, 'invalid_value', `${rp} must be an object.`, 'Use {kind, from, to, statement}.')); return; }
        if (rel.id !== undefined) {
          if (!isText(rel.id)) out.push(diag(`${rp}.id`, 'invalid_value', `${rp}.id must be a non-empty string when provided.`, 'Provide a unique relationship id or omit id.'));
          else if (relIds.has(rel.id)) out.push(diag(`${rp}.id`, 'duplicate_id', `Duplicate relationship id "${rel.id}".`, 'Relationship ids must be unique.'));
          else relIds.add(rel.id);
        }
        if (!isText(rel.kind) || !Object.hasOwn(RELATIONSHIP_TUPLES, rel.kind)) {
          out.push(diag(`${rp}.kind`, 'invalid_value', `${rp}.kind must be one of: support, qualify, conflict, complement.`, 'Set kind to "support", "qualify", "conflict", or "complement".'));
        }
        const hasFrom = need(`${rp}.from`, rel.from, 'the source judgment id');
        const hasTo = need(`${rp}.to`, rel.to, 'the target judgment id');
        if (hasFrom && judgmentIds.size > 0 && !judgmentIds.has(rel.from)) {
          out.push(diag(`${rp}.from`, 'unknown_reference', `${rp}.from "${rel.from}" does not match any judgment id.`, `Use one of: ${[...judgmentIds].join(', ')}.`));
        }
        if (hasTo && judgmentIds.size > 0 && !judgmentIds.has(rel.to)) {
          out.push(diag(`${rp}.to`, 'unknown_reference', `${rp}.to "${rel.to}" does not match any judgment id.`, `Use one of: ${[...judgmentIds].join(', ')}.`));
        }
        if (hasFrom && hasTo && rel.from === rel.to) {
          out.push(diag(`${rp}.to`, 'invalid_value', `${rp} cannot link judgment "${rel.from}" to itself.`, 'Choose two distinct judgment ids.'));
        }
        need(`${rp}.statement`, rel.statement, 'a statement explaining how the two judgments relate');
        for (const k of Object.keys(rel)) {
          if (!allowedRelKeys.includes(k)) out.push(diag(`${rp}.${k}`, 'unknown_field', `Unknown relationship field "${k}".`, typoHint(k, RELATIONSHIP_TYPOS, allowedRelKeys)));
        }
      });
    }
  }
  if (draft.sections !== undefined) {
    if (!Array.isArray(draft.sections)) {
      out.push(diag('sections', 'invalid_value', 'sections must be an array of {id?, number?, title, range?, judgments: string[]}.', 'Group every judgment id into sections, or omit sections.'));
    } else if (draft.sections.length > 0) {
      const allowedSecKeys = ['id', 'number', 'title', 'range', 'judgments'];
      const secIds = new Set();
      const coveredJudgments = new Set();
      draft.sections.forEach((sec, sIdx) => {
        const sp = `sections[${sIdx}]`;
        if (!isObj(sec)) { out.push(diag(sp, 'invalid_value', `${sp} must be an object.`, 'Use {title, judgments: [...]}.')); return; }
        if (sec.id !== undefined) {
          if (!isText(sec.id)) out.push(diag(`${sp}.id`, 'invalid_value', `${sp}.id must be a non-empty string when provided.`, 'Provide a unique section id or omit id.'));
          else if (secIds.has(sec.id)) out.push(diag(`${sp}.id`, 'duplicate_id', `Duplicate section id "${sec.id}".`, 'Section ids must be unique.'));
          else secIds.add(sec.id);
        }
        need(`${sp}.title`, sec.title, 'a section title');
        for (const optKey of ['number', 'range']) {
          if (sec[optKey] !== undefined) {
            if (!isText(sec[optKey])) out.push(diag(`${sp}.${optKey}`, 'invalid_value', `${sp}.${optKey} must be a non-empty string when provided.`, `Provide ${optKey} or omit it.`));
            else if (todo(sec[optKey])) out.push(diag(`${sp}.${optKey}`, 'placeholder_not_replaced', `${sp}.${optKey} still holds a TODO placeholder.`, `Replace ${optKey} or omit it.`));
          }
        }
        if (!Array.isArray(sec.judgments) || !sec.judgments.length || sec.judgments.some(jid => !isText(jid))) {
          out.push(diag(`${sp}.judgments`, 'invalid_value', `${sp}.judgments must be a non-empty array of judgment ids.`, 'List the judgment ids belonging to this section.'));
        } else {
          sec.judgments.forEach((jid, jIdx) => {
            if (judgmentIds.size > 0 && !judgmentIds.has(jid)) {
              out.push(diag(`${sp}.judgments[${jIdx}]`, 'unknown_reference', `${sp}.judgments[${jIdx}] "${jid}" does not match any judgment id.`, `Use one of: ${[...judgmentIds].join(', ')}.`));
            } else if (coveredJudgments.has(jid)) {
              out.push(diag(`${sp}.judgments[${jIdx}]`, 'duplicate_reference', `Judgment "${jid}" appears in sections[] more than once.`, 'Assign each judgment id to exactly one section.'));
            } else {
              coveredJudgments.add(jid);
            }
          });
        }
        for (const k of Object.keys(sec)) {
          if (!allowedSecKeys.includes(k)) out.push(diag(`${sp}.${k}`, 'unknown_field', `Unknown section field "${k}".`, `Allowed: ${allowedSecKeys.join(', ')}.`));
        }
      });
      if (judgmentIds.size > 0) {
        const missing = [...judgmentIds].filter(jid => !coveredJudgments.has(jid));
        if (missing.length > 0) {
          out.push(diag('sections', 'incomplete_sections', `sections[] must cover every judgment 1-to-1; uncovered judgment(s): ${missing.join(', ')}.`, 'Assign every judgment id to a section or remove sections[].'));
        }
      }
    }
  }
  if (draft.timestamp !== undefined && !(typeof draft.timestamp === 'string' && ISO.test(draft.timestamp))) out.push(diag('timestamp', 'invalid_value', 'timestamp must be an ISO-8601 UTC string.', 'Use e.g. "2026-01-01T00:00:00Z".'));
  const knownList = [
    'format', 'asset', 'scope', 'actors', 'creator', 'highest_question', 'boundaries',
    'exceptions', 'misuse', 'worldview', 'value_order', 'sources', 'sections',
    'relationships', 'judgments', 'timestamp',
  ];
  const known = new Set(knownList);
  for (const k of Object.keys(draft)) if (!known.has(k)) out.push(diag(k, 'unknown_field', `Unknown draft field "${k}".`, typoHint(k, TOP_LEVEL_TYPOS, knownList)));
  return out;
}

const provided = text => (isText(text) && !todo(text) ? { state: 'provided', value: text } : { state: 'none', value: null });
// A boundary declaration is a list of complete Boundary objects, not text.
const boundary = (text, id, declaredBy, appliesTo, exceptionRefs = []) => (isText(text) && !todo(text)
  ? { state: 'provided', value: [{ id, effect: 'limit', statement: text, declared_by: declaredBy, applies_to: appliesTo, exception_refs: exceptionRefs }] }
  : { state: 'none', value: null });
const nowZ = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

function compileExceptionList({
  draftExceptions, boundaryId, idPrefix, ownerRef, appliesTo, declaredBy, isChineseAsset, conditions,
}) {
  if (!Array.isArray(draftExceptions) || draftExceptions.length === 0) return { exceptionRefs: [], compiled: [] };
  const exceptionRefs = [];
  const compiled = [];
  draftExceptions.forEach((exc, idx) => {
    const n = idx + 1;
    const excId = `exception:${idPrefix}:${n}`;
    const condId = `condition:${idPrefix}:exception:${n}`;
    const thenKind = exc.then !== undefined ? exc.then : (exc.replace_boundary !== undefined ? 'replace_boundary' : 'waive');
    conditions.push({
      id: condId,
      owner_ref: ownerRef,
      expression: { kind: 'interpreted', statement: exc.when },
    });
    const statement = isText(exc.statement)
      ? exc.statement
      : (thenKind === 'replace_boundary'
          ? (isChineseAsset ? `当${exc.when}时，改用替代边界：${exc.replace_boundary}` : `When ${exc.when}, replace the stated boundary with: ${exc.replace_boundary}`)
          : (isChineseAsset ? `当${exc.when}时，豁免原边界限制。` : `When ${exc.when}, waive the stated boundary.`));
    const effect = thenKind === 'replace_boundary'
      ? {
          kind: 'replace_limit',
          replacement: {
            id: `boundary:${idPrefix}:exception:${n}:replacement`,
            effect: 'limit',
            statement: exc.replace_boundary,
            declared_by: declaredBy,
            applies_to: appliesTo,
            exception_refs: [],
          },
        }
      : { kind: 'waive' };
    exceptionRefs.push(excId);
    compiled.push({
      id: excId,
      statement,
      boundary_ref: boundaryId,
      applies_to: appliesTo,
      when: { kind: 'condition', id: condId },
      effect,
    });
  });
  return { exceptionRefs, compiled };
}

function encodeReadingSectionsExtension(sections, isChineseAsset) {
  const pad2 = n => String(n).padStart(2, '0');
  let cursor = 1;
  const items = sections.map((sec, idx) => {
    const start = cursor;
    const end = cursor + sec.judgments.length - 1;
    cursor = end + 1;
    const id = isText(sec.id) ? sec.id : `section:${idx + 1}`;
    const number = isText(sec.number) ? sec.number : String(idx + 1);
    const range = isText(sec.range) ? sec.range : (start === end ? `#${pad2(start)}` : `#${pad2(start)}–#${pad2(end)}`);
    return {
      kind: 'record',
      fields: [
        { name: 'id', value: { kind: 'text', value: id } },
        { name: 'number', value: { kind: 'text', value: number } },
        { name: 'title', value: { kind: 'text', value: sec.title } },
        { name: 'range', value: { kind: 'text', value: range } },
        {
          name: 'judgment_ids',
          value: {
            kind: 'list',
            items: sec.judgments.map(jid => ({ kind: 'text', value: jid })),
          },
        },
      ],
    };
  });
  return {
    id: 'extension:reading-sections',
    critical: false,
    definition: 'kdna.reading-sections/1',
    value: {
      kind: 'record',
      fields: [
        { name: 'semantic_inheritance', value: { kind: 'text', value: 'none' } },
        {
          name: 'note',
          value: {
            kind: 'text',
            value: isChineseAsset
              ? '仅用于阅读章节导航，不产生父子判断语义继承。'
              : 'Used strictly for chapter navigation in readers; introduces no parent-child semantic inheritance.',
          },
        },
        { name: 'sections', value: { kind: 'list', items } },
      ],
    },
  };
}

function compileDraft(draft) {
  if (!isObj(draft)) throw Object.assign(new Error('KDNA_DRAFT_INVALID'), { diagnostics: [diag('', 'not_an_object', 'Draft must be a JSON object.', 'Start from scaffoldDraft().')] });
  const problems = validateDraft(draft);
  if (problems.length) throw Object.assign(new Error('KDNA_DRAFT_INVALID'), { diagnostics: problems });
  const when = draft.timestamp || nowZ();
  const slug = draft.asset.id;
  const assetUid = `uid:${slug}`;
  const isChineseAsset = /^zh\b/i.test(String(draft.asset.language || ''));
  const defaultFeelingNote = isChineseAsset
    ? '这是作者声明的主观偏好与取向，不构成普适效果证明。'
    : 'This is the author’s stated preference, not evidence of a universal effect.';
  const defaultOtherDef = isChineseAsset
    ? {
        name: '未声明形成方法',
        definition: '作者在草稿中未单独指定标准形成方法词项。',
        exclusion_reason: '草稿省略了 method 字段，按协议以 other 显式记录方法缺席，不代作者推定为个人感受或其他具体方法。',
      }
    : {
        name: 'Unstated formation method',
        definition: 'The author did not specify one of the named formation method terms in this draft.',
        exclusion_reason: 'Method was omitted in the draft and is recorded explicitly under other rather than assuming feeling or another specific method.',
      };
  const defaultOtherRoles = isChineseAsset
    ? {
        method_description: '作者未在草稿中单独声明具体形成方法。',
        basis: '作者直接给出了判断主张与适用条件，未另行拆分形成依据。',
        relation: '以所声明的适用范围与边界条件直接界定该结论的生效范围。',
      }
    : {
        method_description: 'No specific formation method was stated by the author in this draft.',
        basis: 'The author stated the conclusion and applicability scope directly without a separate formation basis.',
        relation: 'The stated applicability scope and boundaries directly govern where this conclusion applies.',
      };
  const table = roleTable();
  const actors = draft.actors.map(x => ({ id: `actor:${x.id}`, kind: x.kind || 'person', name: x.name }));
  const actorIds = actors.map(x => x.id);

  // Resolve creator & attribution statement (ensuring creator actor exists in payload.actors)
  let creatorActor = actors[0];
  let creatorCustomStatement = null;
  if (typeof draft.creator === 'string') {
    const bare = draft.creator.startsWith('actor:') ? draft.creator.slice(6) : draft.creator;
    creatorActor = actors.find(x => x.id === draft.creator || x.id === `actor:${bare}`) ?? actors[0];
  } else if (isObj(draft.creator)) {
    const rawId = isText(draft.creator.id) ? draft.creator.id : 'creator';
    const fullId = rawId.startsWith('actor:') ? rawId : `actor:${rawId}`;
    const existing = actors.find(x => x.id === fullId);
    if (existing) {
      creatorActor = { id: existing.id, kind: draft.creator.kind || existing.kind, name: draft.creator.name || existing.name };
    } else {
      creatorActor = { id: fullId, kind: draft.creator.kind || 'person', name: draft.creator.name };
      actors.push(creatorActor);
    }
    if (isText(draft.creator.statement)) creatorCustomStatement = draft.creator.statement;
  }
  const hasSources = Array.isArray(draft.sources) && draft.sources.length > 0;
  const creatorStatement = creatorCustomStatement ?? (hasSources
    ? (isChineseAsset
        ? `${creatorActor.name}整理并编排本判断资产的立场与结构；引用的外部来源仅作证据与出处归属，其原作观点与版权归各自原作者所有。`
        : `${creatorActor.name} compiled and structured the positions in this judgment asset; cited external sources remain attributed to their respective original authors.`)
    : (isChineseAsset
        ? `${creatorActor.name}创建并提出本判断资产中的主张与边界。`
        : `${creatorActor.name} authored the judgments and boundaries declared in this asset.`));

  const conditions = [];
  const reasons = [];
  const examples = [];
  const sources = (Array.isArray(draft.sources) ? draft.sources : []).map(s => {
    const identity = isText(s.uri) && !s.identity.includes(s.uri) ? `${s.identity} (${s.uri})` : s.identity;
    const displayName = isText(s.name) ? s.name : (isText(s.title) ? s.title : null);
    return {
      id: s.id,
      ...(displayName ? { name: displayName } : {}),
      identity,
      ...(isText(s.version) ? { version: s.version } : {}),
    };
  });
  const sourceUses = [];

  const judgments = draft.judgments.map(j => {
    const form = j.form === 'rule' ? 'rule' : 'conclusion';
    const m = j.method === undefined ? 'other' : j.method;
    const term = typeof m === 'string' ? m : m.term;
    const roleText = typeof m === 'string'
      ? (term === 'other' ? defaultOtherRoles : { personal_preference: defaultFeelingNote })
      : resolveDraftRoles(term, m.roles ?? {}).normalized;
    const order = table ? [...table.roles[term].required, ...table.roles[term].optional] : Object.keys(roleText);
    const components = order.filter(r => isText(roleText[r])).map(r => ({
      id: `component:${j.id}:${r}`, method: { term }, role: r, material_refs: [], statement: roleText[r],
    }));
    const otherDef = term === 'other'
      ? (isObj(m) && isObj(m.other) ? { name: m.other.name, definition: m.other.definition, exclusion_reason: m.other.exclusion_reason } : defaultOtherDef)
      : null;
    const reasonRefs = [];
    if (Array.isArray(j.reasons)) {
      j.reasons.forEach((rText, idx) => {
        if (!isText(rText)) return;
        const rid = `reason:${j.id}:${idx + 1}`;
        reasonRefs.push(rid);
        reasons.push({
          id: rid,
          role: 'support',
          judgment_ref: j.id,
          statement: rText,
          component_refs: components.length ? [components[0].id] : [],
        });
      });
    }
    if (Array.isArray(j.source_refs)) {
      j.source_refs.forEach((srcId, sIdx) => {
        sourceUses.push({
          id: `source-use:${j.id}:${sIdx + 1}`,
          role: 'support',
          source_ref: srcId,
          target_kind: 'judgment',
          target_ref: j.id,
        });
      });
    }
    if (isObj(j.example)) {
      const ex = j.example;
      examples.push({
        id: `example:${j.id}`,
        title: ex.summary,
        kind: 'illustrative',
        context: isText(ex.input) ? `${ex.context}\nInput: ${ex.input}` : ex.context,
        input_refs: [],
        adopted_judgments: [{ kind: 'local', judgment_id: j.id }],
        application: ex.application,
        results: [{ id: `example-result:${j.id}`, kind: 'disposition', statement: ex.result }],
      });
    }
    const jAppliesTo = { kind: 'judgments', judgment_refs: [j.id] };
    const jBoundaryId = `boundary:${j.id}`;
    const jExc = compileExceptionList({
      draftExceptions: j.exceptions,
      boundaryId: jBoundaryId,
      idPrefix: j.id,
      ownerRef: { kind: 'judgment', id: j.id },
      appliesTo: jAppliesTo,
      declaredBy: actorIds[0],
      isChineseAsset,
      conditions,
    });
    const jMisuse = Array.isArray(j.misuse) && j.misuse.length > 0
      ? { state: 'provided', value: j.misuse.map((stmt, mIdx) => ({ id: `misuse:${j.id}:${mIdx + 1}`, statement: stmt })) }
      : { state: 'none', value: null };
    const answerKind = j.answer_kind || 'preference';
    let answerOther = null;
    if (answerKind === 'other') {
      if (typeof j.answer_other === 'string') {
        answerOther = isChineseAsset
          ? {
              name: '开放待定议题',
              definition: j.answer_other,
              exclusion_reason: '该议题目前仍为作者明确保留的开放或待定问题，暂不归入已定型的标准回答类别。',
            }
          : {
              name: 'Open / undecided question',
              definition: j.answer_other,
              exclusion_reason: 'The author explicitly left this question open or undecided rather than forcing a settled answer kind.',
            };
      } else {
        answerOther = {
          name: j.answer_other.name,
          definition: j.answer_other.definition,
          exclusion_reason: j.answer_other.exclusion_reason,
        };
      }
    }
    const rc = `result-contract:${j.id}`;
    const resultContract = {
      id: rc,
      form: { term: 'scalar', vocabulary: 'core' },
      shape: { kind: 'scalar', scalar_type: 'text' },
      minimum: 1,
      maximum: 1,
      allowed_result_types: [{ term: 'text', vocabulary: 'core' }],
    };
    let coreStatement = j.statement;
    let formationRule = null;
    if (form === 'rule') {
      const frStatement = typeof j.formation_rule === 'string' ? j.formation_rule : j.formation_rule.statement;
      if (!isText(coreStatement)) coreStatement = frStatement;
      const frConditions = isObj(j.formation_rule) && Array.isArray(j.formation_rule.conditions) ? j.formation_rule.conditions : [];
      const frConditionRefs = frConditions.map((cStmt, cIdx) => {
        const cid = `condition:${j.id}:rule:${cIdx + 1}`;
        conditions.push({
          id: cid,
          owner_ref: { kind: 'judgment', id: j.id },
          expression: { kind: 'interpreted', statement: cStmt },
        });
        return { kind: 'condition', id: cid };
      });
      formationRule = {
        statement: frStatement,
        condition_refs: frConditionRefs,
        output_contract_ref: rc,
      };
    }
    return {
      id: j.id,
      focus: j.focus,
      subject: { actor_ids: actorIds, statement: j.focus },
      scope: { statement: j.applies_when },
      answer_kind: answerKind,
      ...(answerOther ? { answer_other: answerOther } : {}),
      parent_ref: null,
      form,
      core_expression: { kind: 'authored', statement: coreStatement, qualification_refs: [] },
      method: { method: { term }, ...(otherDef ? { other: otherDef } : {}), components, bindings: [] },
      material_refs: [],
      reason_refs: reasonRefs,
      content_uses: [],
      ports: [],
      inputs: [],
      boundaries: boundary(j.boundaries, jBoundaryId, actorIds[0], jAppliesTo, jExc.exceptionRefs),
      exceptions: jExc.compiled.length > 0 ? { state: 'provided', value: jExc.compiled } : { state: 'none', value: null },
      misuse: jMisuse,
      extensions: [],
      result_contract: resultContract,
      ...(form === 'rule'
        ? { formation_rule: formationRule }
        : {
            result: {
              contract_ref: rc,
              result_type: { term: 'text', vocabulary: 'core' },
              value: { kind: 'text', value: coreStatement },
            },
          }),
    };
  });

  // Asset-level exceptions, misuse, shared declarations, relationships, sections
  const assetBoundaryId = `boundary:${slug}`;
  const assetExc = compileExceptionList({
    draftExceptions: draft.exceptions,
    boundaryId: assetBoundaryId,
    idPrefix: `asset:${slug}`,
    ownerRef: { kind: 'asset', id: assetUid },
    appliesTo: { kind: 'asset' },
    declaredBy: actorIds[0],
    isChineseAsset,
    conditions,
  });
  const assetMisuse = (Array.isArray(draft.misuse) ? draft.misuse : []).map((stmt, mIdx) => ({
    id: `misuse:asset:${slug}:${mIdx + 1}`,
    statement: stmt,
  }));
  const sharedDeclarations = [];
  if (Array.isArray(draft.worldview) && draft.worldview.length > 0) {
    sharedDeclarations.push({
      id: 'shared:worldview',
      kind: 'worldview',
      name: isChineseAsset ? '共同认识' : 'Shared Worldview',
      subject: {
        actor_ids: [creatorActor.id],
        statement: isChineseAsset
          ? `${creatorActor.name}在「${draft.asset.title}」中声明的共同认识。`
          : `Shared worldview declared by ${creatorActor.name} in "${draft.asset.title}".`,
      },
      applies_to: { kind: 'asset' },
      value: [...draft.worldview],
    });
  }
  if (Array.isArray(draft.value_order) && draft.value_order.length > 0) {
    sharedDeclarations.push({
      id: 'shared:value-order',
      kind: 'value_order',
      name: isChineseAsset ? '取舍优先序' : 'Value Priority Order',
      subject: {
        actor_ids: [creatorActor.id],
        statement: isChineseAsset
          ? `${creatorActor.name}在「${draft.asset.title}」中声明的取舍优先序。`
          : `Value priority order declared by ${creatorActor.name} in "${draft.asset.title}".`,
      },
      applies_to: { kind: 'asset' },
      value: [...draft.value_order],
    });
  }
  const relationships = (Array.isArray(draft.relationships) ? draft.relationships : []).map((rel, rIdx) => {
    const spec = RELATIONSHIP_TUPLES[rel.kind];
    return {
      id: isText(rel.id) ? rel.id : `rel:${rIdx + 1}:${rel.kind}`,
      kind: { term: rel.kind },
      direction: spec.direction,
      participants: [
        { role: { term: spec.fromRole }, judgment_ref: rel.from },
        { role: { term: spec.toRole }, judgment_ref: rel.to },
      ],
      operator: { term: spec.operator },
      effect: { term: spec.effect },
      statement: rel.statement,
    };
  });
  const hasSections = Array.isArray(draft.sections) && draft.sections.length > 0;
  const readingOrder = hasSections
    ? draft.sections.flatMap(sec => sec.judgments)
    : judgments.map(j => j.id);
  // Keep payload.judgments[] in readingOrder whenever sections[] are declared so
  // Core catalog order, kdna review, and KDNA Reader v0.3.4 section headers align 1-to-1.
  const orderedJudgments = hasSections
    ? (() => {
        const byId = new Map(judgments.map(j => [j.id, j]));
        return readingOrder.map(id => byId.get(id)).filter(Boolean);
      })()
    : judgments;
  const extensions = hasSections ? [encodeReadingSectionsExtension(draft.sections, isChineseAsset)] : [];

  const distinctForms = new Set(orderedJudgments.map(j => j.form));
  const assetCapability = distinctForms.size === 1
    ? (distinctForms.has('rule') ? 'result_forming_rules' : 'asserted_answers')
    : 'mixed';

  const version = draft.asset.version;
  const manifest = {
    asset_id: `asset:${slug}`,
    asset_uid: assetUid,
    asset_type: draft.asset.type || 'domain',
    title: draft.asset.title,
    summary: draft.asset.summary,
    ...(isText(draft.asset.description) ? { description: draft.asset.description } : {}),
    ...(Array.isArray(draft.asset.keywords) ? { keywords: [...draft.asset.keywords] } : {}),
    languages: [draft.asset.language],
    creator: { id: creatorActor.id, name: creatorActor.name, kind: creatorActor.kind },
    lineage: [],
    history: { coverage: 'complete', statement: isChineseAsset ? '初始版本。' : 'Initial draft.', entries: [] },
    version,
    judgment_version: version,
    created_at: when,
    updated_at: when,
    compatibility: { min_loader_version: '0.36.0', profile: 'kdna.payload.judgment', profile_version: '0.5.1' },
    runtime: { mandatory_entries: [] },
    ...(isObj(draft.asset.license) ? { license: { identifier: draft.asset.license.identifier, ...(isText(draft.asset.license.uri) ? { uri: draft.asset.license.uri } : {}) } } : {}),
  };
  return {
    manifest,
    payload: {
      profile: 'kdna.payload.judgment',
      profile_version: '0.5.1',
      asset: { asset_id: `asset:${slug}`, asset_version: version, judgment_version: version },
      actors,
      attributions: {
        state: 'provided',
        value: [{ role: 'creator', actor_ids: [creatorActor.id], statement: creatorStatement }],
      },
      scope: { statement: draft.scope },
      declarations: { highest_question: provided(draft.highest_question), boundaries: boundary(draft.boundaries, assetBoundaryId, actorIds[0], { kind: 'asset' }, assetExc.exceptionRefs) },
      kernel: { purpose: { kind: 'summary' }, foundation_refs: [] },
      contracts: [],
      conditions,
      shared_declarations: sharedDeclarations,
      materials: [],
      reasons,
      sources,
      source_uses: sourceUses,
      resources: [],
      relationships,
      dependencies: [],
      examples,
      exceptions: assetExc.compiled,
      misuse: assetMisuse,
      reading_order: readingOrder,
      extensions,
      judgments: orderedJudgments,
      asset_capability: assetCapability,
    },
    members: [],
  };
}

const MANIFEST_REQUIRED_KEYS = ['asset_id', 'asset_uid', 'asset_type', 'title', 'version', 'judgment_version', 'created_at', 'updated_at', 'compatibility', 'runtime', 'summary', 'languages', 'history'];
const MANIFEST_OPTIONAL_KEYS = ['creator', 'content_digest', 'authoring', 'access', 'license', 'description', 'keywords', 'lineage'];
const MANIFEST_ALLOWED_KEYS = [...MANIFEST_REQUIRED_KEYS, ...MANIFEST_OPTIONAL_KEYS];

const PAYLOAD_REQUIRED_KEYS = ['profile', 'profile_version', 'asset', 'actors', 'scope', 'judgments', 'asset_capability', 'declarations', 'kernel', 'shared_declarations', 'materials', 'reasons', 'sources', 'source_uses', 'resources', 'relationships', 'dependencies', 'contracts', 'conditions', 'exceptions', 'misuse', 'examples'];
const PAYLOAD_OPTIONAL_KEYS = ['attributions', 'cohesion', 'content_risk', 'extensions', 'reading_order'];
const PAYLOAD_ALLOWED_KEYS = [...PAYLOAD_REQUIRED_KEYS, ...PAYLOAD_OPTIONAL_KEYS];

const COLLECTIONS = new Set(['actors', 'contracts', 'conditions', 'shared_declarations', 'materials', 'reasons', 'sources', 'source_uses', 'resources', 'relationships', 'dependencies', 'examples', 'exceptions', 'misuse', 'reading_order', 'extensions', 'judgments', 'attributions']);

const JUDGMENT_REQUIRED_KEYS = ['id', 'focus', 'subject', 'scope', 'form', 'answer_kind', 'core_expression', 'result_contract', 'method', 'material_refs', 'reason_refs', 'parent_ref', 'ports', 'inputs', 'content_uses'];
const JUDGMENT_OPTIONAL_KEYS = ['answer_other', 'answer_parts', 'boundaries', 'exceptions', 'extensions', 'lifecycle', 'misuse', 'result', 'formation_rule'];
const JUDGMENT_ALLOWED_KEYS = [...JUDGMENT_REQUIRED_KEYS, ...JUDGMENT_OPTIONAL_KEYS];

const SOURCE_EDITS_MANIFEST_EXTRA_KEYS = ['format_version', 'payload', 'representation_metadata', 'representation_origin'];

function checkVersionPairAlignment(manifest, payload) {
  const out = [];
  if (!isObj(manifest) || !isObj(payload) || !isObj(payload.asset)) return out;
  const mv = manifest.version, mjv = manifest.judgment_version;
  const av = payload.asset.asset_version, ajv = payload.asset.judgment_version;
  if (isText(mv) && isText(av) && mv !== av) {
    out.push(diag('/payload/asset/asset_version', 'version_mismatch',
      `Version mismatch between manifest.version ("${mv}") and payload.asset.asset_version ("${av}").`,
      'Update both manifest.version and payload.asset.asset_version to the same version string (and align manifest.judgment_version + payload.asset.judgment_version when judgments changed).'));
  }
  if (isText(mjv) && isText(ajv) && mjv !== ajv) {
    out.push(diag('/payload/asset/judgment_version', 'version_mismatch',
      `Version mismatch between manifest.judgment_version ("${mjv}") and payload.asset.judgment_version ("${ajv}").`,
      'Update both manifest.judgment_version and payload.asset.judgment_version to the same version string (typically matching manifest.version and payload.asset.asset_version).'));
  }
  if (isText(mv) && isText(av) && isText(mjv) && isText(ajv) && mv === av && mjv === ajv && mv !== mjv) {
    // Valid in Core when only container metadata changed, surfaced only by computeAdvisories when judgments changed.
  }
  if (isObj(manifest.asset_id !== undefined ? { id: manifest.asset_id } : null) && isText(manifest.asset_id) && isText(payload.asset.asset_id) && manifest.asset_id !== payload.asset.asset_id) {
    out.push(diag('/payload/asset/asset_id', 'asset_id_mismatch',
      `Asset ID mismatch between manifest.asset_id ("${manifest.asset_id}") and payload.asset.asset_id ("${payload.asset.asset_id}").`,
      'Keep manifest.asset_id and payload.asset.asset_id identical.'));
  }
  return out;
}

function validateFull(input, { sourceEdits = false } = {}) {
  const out = [];
  if (!isObj(input)) return [diag('', 'not_an_object', 'Input must be a JSON object.', sourceEdits ? 'Provide {manifest,payload}.' : 'Provide {manifest,payload,members}.')];
  const topKeys = sourceEdits ? ['manifest', 'payload'] : ['manifest', 'payload', 'members'];
  for (const k of topKeys) if (input[k] === undefined) out.push(diag(`/${k}`, 'missing_field', `/${k} is required.`, k === 'members' ? 'Add "members": [].' : `Add /${k}; run \`kdna init\` and compile a draft for a complete one.`));
  for (const k of Object.keys(input)) if (!topKeys.includes(k)) out.push(diag(`/${k}`, 'unknown_field', `Unknown top-level field "${k}".`, sourceEdits ? 'Only manifest and payload are accepted in source-pack edits.' : 'Only manifest, payload, members are accepted.'));
  const keyset = (value, requiredKeys, allowedKeys, base, hintFor) => {
    if (!isObj(value)) { if (value !== undefined) out.push(diag(base, 'invalid_value', `${base} must be an object.`, '')); return false; }
    for (const k of requiredKeys) if (!Object.hasOwn(value, k)) out.push(diag(`${base}/${k}`, 'missing_field', `${base}/${k} is required.`, hintFor(k)));
    for (const k of Object.keys(value)) if (!allowedKeys.includes(k)) out.push(diag(`${base}/${k}`, 'unknown_field', `${base}/${k} is not an allowed field.`, `Allowed: ${allowedKeys.join(', ')}.`));
    return true;
  };
  const manifestAllowed = sourceEdits ? [...MANIFEST_ALLOWED_KEYS, ...SOURCE_EDITS_MANIFEST_EXTRA_KEYS] : MANIFEST_ALLOWED_KEYS;
  keyset(input.manifest, MANIFEST_REQUIRED_KEYS, manifestAllowed, '/manifest', k => `Add ${k} to the manifest.`);
  out.push(...checkVersionPairAlignment(input.manifest, input.payload));
  if (keyset(input.payload, PAYLOAD_REQUIRED_KEYS, PAYLOAD_ALLOWED_KEYS, '/payload', k => (COLLECTIONS.has(k) ? `Add "${k}": [] when it has no entries.` : `Add ${k} to the payload.`))) {
    const table = roleTable();
    if (Array.isArray(input.payload.judgments)) {
      if (!input.payload.judgments.length) out.push(diag('/payload/judgments', 'missing_field', '/payload/judgments needs at least one judgment.', 'Add one judgment.'));
      input.payload.judgments.forEach((j, i) => {
        const base = `/payload/judgments/${i}`;
        if (!keyset(j, JUDGMENT_REQUIRED_KEYS, JUDGMENT_ALLOWED_KEYS, base, k => `Add ${k} to this judgment.`)) return;
        if (j.form === 'rule') {
          if (!Object.hasOwn(j, 'formation_rule')) out.push(diag(`${base}/formation_rule`, 'missing_field', `${base}/formation_rule is required when form is "rule".`, 'Add formation_rule to this rule judgment.'));
          if (Object.hasOwn(j, 'result')) out.push(diag(`${base}/result`, 'invalid_value', `${base}/result is not allowed when form is "rule".`, 'Remove result from rule judgments; use formation_rule instead.'));
        } else if (j.form === 'conclusion') {
          if (!Object.hasOwn(j, 'result')) out.push(diag(`${base}/result`, 'missing_field', `${base}/result is required when form is "conclusion".`, 'Add result to this conclusion judgment.'));
          if (Object.hasOwn(j, 'formation_rule')) out.push(diag(`${base}/formation_rule`, 'invalid_value', `${base}/formation_rule is not allowed when form is "conclusion".`, 'Remove formation_rule from conclusion judgments; use result instead.'));
        }
        const compCheck = inspectMethodComponents(j, table);
        if (compCheck) {
          if (compCheck.duplicate_roles.length) {
            out.push({
              ...diag(`${base}/method/components`, 'duplicate_method_roles',
                `Method "${compCheck.term}" repeats role(s): ${compCheck.duplicate_roles.map(d => `${d.role} (${d.component_ids.join(', ')})`).join('; ')}.`,
                DUPLICATE_ROLE_FIX_HINT),
              duplicate_roles: compCheck.duplicate_roles,
              invalid_roles: compCheck.invalid_roles,
              missing_required_roles: compCheck.missing_required_roles,
              fix_hint: DUPLICATE_ROLE_FIX_HINT,
            });
          }
          if (compCheck.invalid_roles.length) {
            out.push({
              ...diag(`${base}/method/components`, 'invalid_method_roles',
                `Method "${compCheck.term}" has role(s) outside its vocabulary: ${compCheck.invalid_roles.join(', ')}.`,
                `Allowed roles for "${compCheck.term}": ${[...compCheck.expected, ...compCheck.optional].join(', ')}.`),
              duplicate_roles: compCheck.duplicate_roles,
              invalid_roles: compCheck.invalid_roles,
              missing_required_roles: compCheck.missing_required_roles,
            });
          }
          if (compCheck.missing_required_roles.length) {
            out.push({
              ...diag(`${base}/method/components`, 'missing_method_roles',
                `Method "${compCheck.term}" is missing required role(s): ${compCheck.missing_required_roles.join(', ')}.`,
                `Required roles for "${compCheck.term}": ${compCheck.expected.join(', ')}.`),
              duplicate_roles: compCheck.duplicate_roles,
              invalid_roles: compCheck.invalid_roles,
              missing_required_roles: compCheck.missing_required_roles,
            });
          }
        }
      });
    } else if (input.payload.judgments !== undefined) out.push(diag('/payload/judgments', 'invalid_value', '/payload/judgments must be an array.', ''));
  }
  if (input.members !== undefined && !Array.isArray(input.members)) out.push(diag('/members', 'invalid_value', '/members must be an array.', 'Use "members": [].'));
  return out;
}

function normalizeFocusText(text) {
  return String(text || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function isProvidedDeclaration(decl) {
  return isObj(decl) && decl.state === 'provided' && decl.value !== null && decl.value !== undefined && (!Array.isArray(decl.value) || decl.value.length > 0);
}

function isCatchAllScope(text) {
  const trimmed = String(text || '').trim();
  return trimmed.length < 8 || CATCH_ALL_SCOPES.has(trimmed.toLowerCase());
}

function focusDisplayWidth(text) {
  let w = 0;
  for (const ch of String(text || '')) {
    const cp = ch.codePointAt(0);
    w += (cp >= 0x2e80 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xff01 && cp <= 0xff60) ? 2 : 1;
  }
  return w;
}

// Structural, MP4-compliant craft advisories. Never computes a numerical score,
// never evaluates substantive truth/ideology, and never alters validity.
function computeAdvisories(input, isDraft) {
  const advisories = [];
  if (!isObj(input)) return advisories;
  if (isDraft) {
    const judgments = Array.isArray(input.judgments) ? input.judgments : [];
    const hasGlobalGuard = isText(input.boundaries);
    const hasSources = Array.isArray(input.sources) && input.sources.length > 0;
    const assetTitleNorm = isText(input.asset?.title) ? normalizeFocusText(input.asset.title) : '';
    const focusMap = new Map();
    let omittedMethodCount = 0;
    const isSmallTasteDraft = judgments.length <= 5 && judgments.every(j => isObj(j) && (j.answer_kind === 'preference' || j.method === 'feeling' || j.method?.term === 'feeling'));
    judgments.forEach((j, i) => {
      if (!isObj(j)) return;
      const p = `judgments[${i}]`;
      const focus = isText(j.focus) ? j.focus.trim() : '';
      const stmt = isText(j.statement)
        ? j.statement.trim()
        : (typeof j.formation_rule === 'string' ? j.formation_rule.trim() : (isText(j.formation_rule?.statement) ? j.formation_rule.statement.trim() : ''));
      if (focus && (focusDisplayWidth(focus) < 12 || (assetTitleNorm && normalizeFocusText(focus) === assetTitleNorm))) {
        advisories.push({ code: 'vague_or_short_focus', path: `${p}.focus`, message: 'focus is very short or repeats the asset title; write a self-contained catalog question/topic so Agents reading only the catalog can pick it accurately.' });
      }
      if (focus && stmt && focus === stmt) {
        advisories.push({ code: 'tautological_statement', path: `${p}.statement`, message: 'statement verbatim repeats focus; state the concrete decision or conclusion instead of repeating the question.' });
      }
      if (isObj(j.method) && isObj(j.method.roles) && stmt) {
        for (const [rk, rv] of Object.entries(j.method.roles)) {
          if (isText(rv) && rv.trim() === stmt) {
            advisories.push({ code: 'method_repeats_statement', path: `${p}.method.roles.${rk}`, message: `method role "${rk}" verbatim repeats statement; explain how the judgment was formed rather than restating the conclusion.` });
            break;
          }
        }
      }
      const hasJudgmentBoundary = isText(j.boundaries);
      const hasJudgmentException = Array.isArray(j.exceptions) && j.exceptions.length > 0;
      if (!hasJudgmentBoundary && !hasGlobalGuard) {
        advisories.push({ code: 'unbounded_judgment', path: `${p}.boundaries`, message: 'neither this judgment nor the asset declares boundaries; consider stating where this judgment stops applying so Agents do not over-apply it.' });
      }
      if (stmt && ABSOLUTIST_RE.test(stmt) && !hasJudgmentBoundary && !hasJudgmentException) {
        advisories.push({ code: 'unbounded_absolutism', path: `${p}.statement`, message: 'statement uses absolutist wording without judgment-level boundaries or exceptions; state where the rule stops applying or what exception overrides it.' });
      }
      if (isText(j.applies_when) && isCatchAllScope(j.applies_when)) {
        advisories.push({ code: 'overbroad_scope', path: `${p}.applies_when`, message: 'applies_when is very short or catch-all; name concrete task conditions so Agents can filter irrelevant judgments.' });
      }
      if (hasSources) {
        const mTerm = typeof j.method === 'string' ? j.method : j.method?.term;
        if (mTerm === 'feeling') {
          advisories.push({ code: 'research_provenance_mismatch', path: `${p}.method`, message: 'asset cites research sources[] while this judgment uses method "feeling"; use evidence_analysis or another reasoning method when grounding claims in sources.' });
        }
        if (!Array.isArray(j.source_refs) || j.source_refs.length === 0) {
          advisories.push({ code: 'research_provenance_mismatch', path: `${p}.source_refs`, message: 'asset declares sources[] but this judgment omits source_refs; link supporting source ids so readers and exact_selection preserve provenance.' });
        }
      }
      if (focus) {
        const norm = normalizeFocusText(focus);
        if (!focusMap.has(norm)) focusMap.set(norm, []);
        focusMap.get(norm).push({ index: i, path: `${p}.focus` });
      }
      if (j.method === undefined) omittedMethodCount += 1;
    });
    for (const entries of focusMap.values()) {
      if (entries.length > 1) {
        advisories.push({ code: 'duplicate_focus', path: entries[1].path, message: `judgments at ${entries.map(e => e.path).join(' and ')} ask the same focus question; split distinct sub-questions or merge them.` });
      }
    }
    if (judgments.length >= 6 && (!Array.isArray(input.relationships) || input.relationships.length === 0)) {
      advisories.push({ code: 'isolated_multi_judgment', path: 'relationships', message: `asset has ${judgments.length} judgments and 0 relationships; consider linking mutually reinforcing, qualifying, or conflicting judgments so exact_selection pulls paired brakes into closure.` });
    }
    if (omittedMethodCount >= 3 && !isSmallTasteDraft) {
      advisories.push({ code: 'uniform_default_method', path: 'judgments', message: `${omittedMethodCount} judgments omit method (defaulting to "other"); keep omitted for intuitive taste or unstated convictions, or declare tradeoff, criteria_comparison, observation, experience, or evidence_analysis where explicit reasoning exists.` });
    }
    return advisories;
  }
  const payload = isObj(input.payload) ? input.payload : {};
  const judgments = Array.isArray(payload.judgments) ? payload.judgments : [];
  const hasGlobalGuard = isProvidedDeclaration(payload.declarations?.boundaries)
    || (Array.isArray(payload.conditions) && payload.conditions.length > 0)
    || (Array.isArray(payload.exceptions) && payload.exceptions.length > 0);
  const hasSources = Array.isArray(payload.sources) && payload.sources.length > 0;
  const sourceUsesByJudgment = new Set(
    (Array.isArray(payload.source_uses) ? payload.source_uses : [])
      .filter(u => isObj(u) && u.target_kind === 'judgment' && isText(u.target_ref))
      .map(u => u.target_ref),
  );
  const assetTitleNorm = isText(input.manifest?.title) ? normalizeFocusText(input.manifest.title) : '';
  const focusMap = new Map();
  judgments.forEach((j, i) => {
    if (!isObj(j)) return;
    const p = `/payload/judgments/${i}`;
    const focus = isText(j.focus) ? j.focus.trim() : '';
    const stmt = isText(j.core_expression?.statement) ? j.core_expression.statement.trim() : '';
    if (focus && (focusDisplayWidth(focus) < 12 || (assetTitleNorm && normalizeFocusText(focus) === assetTitleNorm))) {
      advisories.push({ code: 'vague_or_short_focus', path: `${p}/focus`, message: 'focus is very short or repeats the asset title; write a self-contained catalog question/topic so Agents reading only the catalog can pick it accurately.' });
    }
    if (focus && stmt && focus === stmt) {
      advisories.push({ code: 'tautological_statement', path: `${p}/core_expression/statement`, message: 'core_expression.statement verbatim repeats focus; state the concrete conclusion instead of repeating the question.' });
    }
    if (Array.isArray(j.method?.components) && stmt) {
      for (let cIdx = 0; cIdx < j.method.components.length; cIdx++) {
        const comp = j.method.components[cIdx];
        if (isText(comp?.statement) && comp.statement.trim() === stmt) {
          advisories.push({ code: 'method_repeats_statement', path: `${p}/method/components/${cIdx}/statement`, message: `method component "${comp.role ?? cIdx}" verbatim repeats core_expression.statement; explain how the judgment was formed rather than restating the conclusion.` });
          break;
        }
      }
    }
    const hasJudgmentGuard = isProvidedDeclaration(j.boundaries) || isProvidedDeclaration(j.exceptions);
    if (!hasJudgmentGuard && !hasGlobalGuard) {
      advisories.push({ code: 'unbounded_judgment', path: `${p}/boundaries`, message: 'judgment declares no boundaries or exceptions and the asset declares no global boundaries/conditions/exceptions; consider stating where it stops applying.' });
    }
    if (stmt && ABSOLUTIST_RE.test(stmt) && !hasJudgmentGuard) {
      advisories.push({ code: 'unbounded_absolutism', path: `${p}/core_expression/statement`, message: 'core_expression.statement uses absolutist wording without judgment-level boundaries or exceptions; state where the rule stops applying or what exception overrides it.' });
    }
    const scopeStmt = j.scope?.statement;
    if (isText(scopeStmt) && isCatchAllScope(scopeStmt)) {
      advisories.push({ code: 'overbroad_scope', path: `${p}/scope/statement`, message: 'scope.statement is very short or catch-all; name concrete applicability conditions so Agents can filter irrelevant judgments.' });
    }
    if (hasSources && j.method?.method?.term === 'feeling') {
      advisories.push({ code: 'research_provenance_mismatch', path: `${p}/method`, message: 'asset declares sources[] while this judgment uses method "feeling"; use evidence_analysis or another reasoning method when grounding claims in sources.' });
    }
    if (hasSources && isText(j.id) && !sourceUsesByJudgment.has(j.id) && !(Array.isArray(payload.source_uses) && payload.source_uses.length > 0)) {
      advisories.push({ code: 'research_provenance_mismatch', path: '/payload/source_uses', message: 'asset declares sources[] but has no source_uses[] links; link sources to judgments or materials so readers preserve provenance.' });
    }
    if (focus) {
      const norm = normalizeFocusText(focus);
      if (!focusMap.has(norm)) focusMap.set(norm, []);
      focusMap.get(norm).push({ index: i, path: `${p}/focus` });
    }
    if (j.form === 'conclusion' && j.result?.value?.kind === 'text' && isText(j.result.value.value) && stmt && j.result.value.value.trim() !== stmt) {
      advisories.push({ code: 'conclusion_result_diverges', path: `${p}/result/value/value`, message: 'result.value.value differs from core_expression.statement on this conclusion judgment; update both fields together unless the scalar result intentionally differs from the prose conclusion.' });
    }
  });
  for (const entries of focusMap.values()) {
    if (entries.length > 1) {
      advisories.push({ code: 'duplicate_focus', path: entries[1].path, message: `judgments at ${entries.map(e => e.path).join(' and ')} ask the same focus question; split distinct sub-questions or merge them.` });
    }
  }
  if (judgments.length >= 6 && (!Array.isArray(payload.relationships) || payload.relationships.length === 0)) {
    advisories.push({ code: 'isolated_multi_judgment', path: '/payload/relationships', message: `asset has ${judgments.length} judgments and 0 relationships; consider linking mutually reinforcing, qualifying, or conflicting judgments so exact_selection pulls paired brakes into closure.` });
  }
  return advisories;
}

function isSourceEditsShape(input) {
  return isObj(input)
    && input.members === undefined
    && isObj(input.manifest)
    && isObj(input.payload)
    && SOURCE_EDITS_MANIFEST_EXTRA_KEYS.some(k => Object.hasOwn(input.manifest, k));
}

function validateInput(input, options = {}) {
  if (isObj(input) && input.status === 'source_opened' && isObj(input.edits)) {
    input = input.edits;
    options = { ...options, sourceEdits: true };
  }
  const sourceEdits = options.sourceEdits === true || isSourceEditsShape(input);
  const draft = !sourceEdits && isObj(input) && (input.format !== undefined || (input.manifest === undefined && input.payload === undefined));
  const diagnostics = draft ? validateDraft(isObj(input) ? input : {}) : validateFull(input, { sourceEdits });
  if (draft && !isObj(input)) diagnostics.unshift(diag('', 'not_an_object', 'Draft must be a JSON object.', 'Start from scaffoldDraft().'));
  if (diagnostics.length) return { status: 'invalid', diagnostics };
  const judgment_count = draft ? input.judgments.length : input.payload.judgments.length;
  return {
    status: 'valid',
    input_kind: draft ? 'draft' : (sourceEdits ? 'source_edits' : 'authored'),
    judgment_count,
    diagnostics: [],
    advisories: computeAdvisories(input, draft),
  };
}

// Ask Core itself (the authority) and translate a rejection into the same
// diagnostic shape. A draft is compiled first; compile problems come back as-is.
async function validateWithCore(input) {
  if (isObj(input) && input.status === 'source_opened' && isObj(input.edits)) {
    input = input.edits;
  }
  const local = validateInput(input);
  if (local.status === 'invalid') return local;
  if (local.input_kind === 'source_edits') {
    if (Array.isArray(input.payload?.resources) && input.payload.resources.length > 0) return local;
    const cleanManifest = { ...input.manifest };
    for (const k of SOURCE_EDITS_MANIFEST_EXTRA_KEYS) delete cleanManifest[k];
    input = { manifest: cleanManifest, payload: input.payload, members: [] };
  }
  const full = isObj(input) && input.format === FORMAT ? compileDraft(input) : input;
  const { admitNativeCreationRequest, createNativeCreationAuthority, createSectionAssetNode } = require('@aikdna/kdna-core/creation-sections-node');
  const binding = require('../public-contract-binding.json');
  const request = admitNativeCreationRequest({ request_id: 'draft:' + randomUUID(), tuple: binding.tuple, operation: 'create_public_asset', timeout_ms: 60000 });
  if (request.status !== 'admitted_request') return { status: 'invalid', diagnostics: [diag('', 'core_request_rejected', 'Core refused the creation request.', 'Check the installed @aikdna/kdna-core matches this CLI.')] };
  const produced = await createSectionAssetNode(full, request.request, createNativeCreationAuthority(() => true));
  if (produced.status === 'produced') return local;
  const raw = Array.isArray(produced?.core?.diagnostics) ? produced.core.diagnostics : [];
  const table = roleTable();
  const judgments = Array.isArray(full?.payload?.judgments) ? full.payload.judgments : [];
  const diagnostics = raw.map(d => {
    const field = typeof d?.field === 'string' ? d.field : '';
    const compMatch = /^\/payload\/judgments\/(\d+)\/method\/components$/.exec(field);
    if (compMatch) {
      const compCheck = inspectMethodComponents(judgments[Number(compMatch[1])], table);
      if (compCheck && compCheck.duplicate_roles.length) {
        return {
          ...diag(field, String(d?.code || d?.reason || produced.code || 'core_rejected'),
            `Core rejected ${field} (${d?.code || 'READ_CORE_INVALID'}): duplicate role(s) ${compCheck.duplicate_roles.map(x => x.role).join(', ')}.`,
            DUPLICATE_ROLE_FIX_HINT),
          duplicate_roles: compCheck.duplicate_roles,
          invalid_roles: compCheck.invalid_roles,
          missing_required_roles: compCheck.missing_required_roles,
          fix_hint: DUPLICATE_ROLE_FIX_HINT,
        };
      }
    }
    return diag(field, String(d?.code || d?.reason || produced.code || 'core_rejected'), `Core rejected ${field || 'the input'}${d?.code ? ` (${d.code})` : ''}.`, 'Compare this field with docs/authoring-field-reference.md.');
  });
  if (!diagnostics.length) diagnostics.push(diag('', String(produced.code || produced.status || 'core_rejected'), 'Core rejected the input.', 'Compare the input with docs/authoring-field-reference.md.'));
  return { status: 'invalid', diagnostics };
}

module.exports = {
  FORMAT,
  INIT_MODES,
  INIT_LANGS,
  ROLE_ALIASES_EN,
  ROLE_ALIASES_ZH,
  DUPLICATE_ROLE_FIX_HINT,
  englishAliasFor,
  chineseLabelFor,
  checkVersionPairAlignment,
  inspectMethodComponents,
  scaffoldDraft,
  compileDraft,
  validateInput,
  validateWithCore,
};
