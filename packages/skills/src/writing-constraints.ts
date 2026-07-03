import writingConstraintRules from './rules/writing-constraints.json';

interface WritingConstraintRule {
  id: string;
  description: string;
  requestTriggers: string[];
  complaintTerms: string[];
  terms: string[];
  patterns: string[];
}

const configuredRules = writingConstraintRules.avoidanceRules as WritingConstraintRule[];
const avoidanceMarkers = ['不要', '避免', '不得', '不宜', '不能', '禁止', '少用'];
const complaintMarkers = ['突兀', '不要', '避免', '不合适', '不像'];

export function extractExplicitAvoidances(rawText: string): string[] {
  const values: string[] = [];
  const pattern = /((?:不要|避免|不得|不宜|不能|禁止|少用)[^，。,.!?！？；;]+)/g;
  for (const match of rawText.matchAll(pattern)) {
    const value = cleanPhrase(match[1]);
    if (value) values.push(value);
  }
  values.push(...configuredRules.filter((rule) => isRuleAvoidanceRequest(rawText, rule)).map((rule) => rule.description));
  return uniqueStrings(values);
}

export function findAvoidedTermsInText(text: string, mustAvoid: string[]): string[] {
  const normalizedText = normalizeForTermMatch(text);
  const explicitHits = extractAvoidedTerms(mustAvoid).filter((term) => normalizedText.includes(normalizeForTermMatch(term)));
  const configuredRuleHits = configuredRules.filter((rule) => shouldApplyConfiguredRule(mustAvoid, rule)).flatMap((rule) => findConfiguredRuleHits(text, rule));
  return removeSubsumedHits(uniqueStrings([...explicitHits, ...configuredRuleHits]));
}

function isRuleAvoidanceRequest(rawText: string, rule: WritingConstraintRule): boolean {
  const text = normalizeForTermMatch(rawText);
  return (
    hasNearPair(text, avoidanceMarkers, rule.requestTriggers, 40) ||
    hasNearPair(text, rule.complaintTerms, [...complaintMarkers, ...rule.requestTriggers], 20) ||
    hasNearPair(text, rule.requestTriggers, rule.complaintTerms, 20)
  );
}

function shouldApplyConfiguredRule(mustAvoid: string[], rule: WritingConstraintRule): boolean {
  const text = normalizeForTermMatch(mustAvoid.join(' '));
  return [rule.id, rule.description, ...rule.requestTriggers].some((item) => text.includes(normalizeForTermMatch(item)));
}

function findConfiguredRuleHits(text: string, rule: WritingConstraintRule): string[] {
  const hits: string[] = [];
  for (const pattern of rule.patterns) {
    for (const match of text.matchAll(new RegExp(pattern, 'g'))) {
      hits.push(match[0].trim());
    }
  }
  const normalizedText = normalizeForTermMatch(text);
  for (const term of rule.terms) {
    if (normalizedText.includes(normalizeForTermMatch(term))) hits.push(term);
  }
  return uniqueStrings(hits);
}

function hasNearPair(text: string, leftValues: string[], rightValues: string[], maxGap: number): boolean {
  const left = normalizedValues(leftValues);
  const right = normalizedValues(rightValues);
  for (const leftValue of left) {
    for (const rightValue of right) {
      if (leftValue === rightValue) continue;
      if (hasNearTerms(text, leftValue, rightValue, maxGap)) return true;
    }
  }
  return false;
}

function hasNearTerms(text: string, left: string, right: string, maxGap: number): boolean {
  for (const leftIndex of allIndexesOf(text, left)) {
    for (const rightIndex of allIndexesOf(text, right)) {
      if (Math.abs(leftIndex - rightIndex) <= left.length + right.length + maxGap) return true;
    }
  }
  return false;
}

function extractAvoidedTerms(mustAvoid: string[]): string[] {
  return mustAvoid.flatMap((item) => {
    const text = item.trim();
    const quoted = [...text.matchAll(/[“"「『]([^”"」』]+)[”"」』]/g)].map((match) => match[1]);
    const parentheticalExamples = [...text.matchAll(/[（(]([^）)]+)[）)]/g)].flatMap((match) => extractExampleList(match[1]));
    const direct = text.includes('（') || text.includes('(') ? [] : [stripAvoidancePrefix(text)];
    return [...direct, ...quoted, ...parentheticalExamples].map(cleanAvoidedTerm).filter((term) => term.length > 1);
  });
}

function extractExampleList(value: string): string[] {
  const example = value.replace(/^(?:如|例如|比如)\s*/, '');
  if (example === value) return [];
  return example.split(/[、,，/／;；\s]+/);
}

function stripAvoidancePrefix(value: string): string {
  return value.replace(/^(?:不要|避免|不得|不宜|不能|禁止|少用)(?:使用|出现|写成|写作|写)?/, '');
}

function cleanAvoidedTerm(value: string): string {
  return value
    .replace(/等.*$/, '')
    .replace(/^["“「『\s]+|["”」』\s]+$/g, '')
    .trim();
}

function cleanPhrase(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/^(?:写|突出|呈现|强调|表现|讨论)/, '')
    .trim();
}

function normalizeForTermMatch(value: string): string {
  return value.replace(/\s+/g, '').toLowerCase();
}

function normalizedValues(values: string[]): string[] {
  return values.map(normalizeForTermMatch).filter(Boolean);
}

function allIndexesOf(text: string, term: string): number[] {
  const indexes: number[] = [];
  let start = 0;
  while (start < text.length) {
    const index = text.indexOf(term, start);
    if (index < 0) break;
    indexes.push(index);
    start = index + Math.max(1, term.length);
  }
  return indexes;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))];
}

function removeSubsumedHits(values: string[]): string[] {
  return values.filter((value) => !values.some((other) => other !== value && other.includes(value)));
}
