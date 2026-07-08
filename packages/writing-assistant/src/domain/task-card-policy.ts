import { KnowledgeItem, WritingTaskCard } from '@wa/core';
import { PromptProgram } from '@wa/runtime';

const HOU40_CANONICAL_AVOID = '不得引用《红楼梦》后40回（程高本续书）的情节或任何文本';
const HOU40_CANONICAL_SOURCE_POLICY = '仅以《红楼梦》前80回和脂批为依据，不引用后40回（程高本续书）的情节或任何文本。';
const SUBJECTIVE_PROSE_CANONICAL_AVOID = '避免大段主观评论和抒情性语句';

export interface TaskCardPolicyNormalization {
  taskCard: WritingTaskCard;
  changed: boolean;
}

export function normalizeTaskCardPolicies(taskCard: WritingTaskCard, triggerText = ''): TaskCardPolicyNormalization {
  const boundary = sourceBoundaryFromTaskCard(taskCard, triggerText);
  const normalized: WritingTaskCard = {
    ...taskCard,
    scope: {
      editions: normalizeList(taskCard.scope.editions ?? [], boundary.forbidHou40, 'scope'),
      chapters: normalizeList(taskCard.scope.chapters ?? [], boundary.forbidHou40, 'scope'),
      characters: uniqueStrings(taskCard.scope.characters ?? []),
      themes: normalizeList(taskCard.scope.themes ?? [], boundary.forbidHou40, 'scope'),
    },
    constraints: {
      ...taskCard.constraints,
      mustInclude: normalizeList(taskCard.constraints.mustInclude, boundary.forbidHou40, 'include'),
      mustAvoid: normalizeMustAvoid(taskCard.constraints.mustAvoid, boundary.forbidHou40),
      sourcePolicy: normalizeSourcePolicy(taskCard.constraints.sourcePolicy, boundary.forbidHou40),
    },
  };
  return { taskCard: normalized, changed: JSON.stringify(taskCard) !== JSON.stringify(normalized) };
}

export function filterKnowledgeByTaskCardPolicy(items: KnowledgeItem[], taskCard: WritingTaskCard): KnowledgeItem[] {
  const boundary = sourceBoundaryFromTaskCard(taskCard);
  if (!boundary.forbidHou40) return items;
  return items.filter((item) => !mentionsHou40(knowledgeText(item)));
}

export function validateGeneratedTextAgainstTaskCardPolicy(
  text: string,
  taskCard: WritingTaskCard,
  sourceItems: KnowledgeItem[] = [],
  sourceRefs: string[] = [],
  options: { allowSourceBoundaryMentions?: boolean } = {},
): void {
  const boundary = sourceBoundaryFromTaskCard(taskCard);
  if (!boundary.forbidHou40) return;
  if (findHou40PolicyViolations(text, options.allowSourceBoundaryMentions).length) {
    throw new Error('Generated text violates source policy: references the later 40 chapters or Cheng-Gao sequel.');
  }
  const sourceByRef = new Map(sourceItems.map((item) => [item.sourceRef, item]));
  const badRefs = sourceRefs.filter((ref) => mentionsHou40(ref) || (sourceByRef.has(ref) && mentionsHou40(knowledgeText(sourceByRef.get(ref)!))));
  if (badRefs.length) {
    throw new Error(`Generated text violates source policy: uses disallowed source refs ${badRefs.join('、')}.`);
  }
}

export function sourceBoundaryFromTaskCard(taskCard: WritingTaskCard, triggerText = ''): { forbidHou40: boolean } {
  const text = [
    triggerText,
    taskCard.constraints.sourcePolicy,
    ...(taskCard.constraints.mustAvoid ?? []),
    ...(taskCard.topRules?.writingStandards ?? []),
    ...(taskCard.scope.editions ?? []),
    ...(taskCard.scope.chapters ?? []),
  ].join('\n');
  return { forbidHou40: forbidsHou40(text) || hasClosedPre80Policy(text) };
}

function normalizeMustAvoid(values: string[], forbidHou40: boolean): string[] {
  const normalized = values.flatMap((item) => normalizeMustAvoidItem(item, forbidHou40));
  if (forbidHou40) normalized.push(HOU40_CANONICAL_AVOID);
  return uniqueStrings(normalized);
}

function normalizeMustAvoidItem(rawValue: string, forbidHou40: boolean): string[] {
  const value = rawValue.trim();
  if (!value) return [];
  const normalized: string[] = [];
  if (mentionsSubjectiveProseAvoidance(value)) normalized.push(SUBJECTIVE_PROSE_CANONICAL_AVOID);
  if (forbidHou40 && mentionsHou40(value)) normalized.push(HOU40_CANONICAL_AVOID);
  return normalized.length ? normalized : [value];
}

function normalizeSourcePolicy(value: string, forbidHou40: boolean): string {
  const clauses = value.split(/[；;。]/).map((item) => item.trim()).filter(Boolean);
  if (!forbidHou40) return uniqueStrings(clauses).join('；') || value.trim();
  const kept = clauses
    .filter((item) => !isPositiveHou40Instruction(item))
    .map(stripCoveredPre80SourceAllowance)
    .filter(Boolean);
  const merged = uniqueStrings([HOU40_CANONICAL_SOURCE_POLICY, ...kept.filter((item) => !samePolicyMeaning(item, HOU40_CANONICAL_SOURCE_POLICY))]);
  return merged.join('；');
}

function stripCoveredPre80SourceAllowance(value: string): string {
  if (!hasClosedPre80Policy(value) || mentionsHou40(value)) return value;
  return value
    .replace(/^(?:允许|可以|可)?(?:适当)?引用《?红楼梦》?前(?:80|八十)回(?:原文)?(?:和|与|及|、)?脂批[，,、]*/, '')
    .replace(/^以《?红楼梦》?前(?:80|八十)回(?:原文)?(?:和|与|及|、)?脂批(?:为依据|为主要依据)?[，,、]*/, '')
    .trim();
}

function normalizeList(values: string[], forbidHou40: boolean, kind: 'include' | 'scope'): string[] {
  const filtered = values
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => !(forbidHou40 && isPositiveHou40Instruction(item)));
  return uniqueStrings(filtered);
}

function isPositiveHou40Instruction(value: string): boolean {
  if (!mentionsHou40(value)) return false;
  if (forbidsHou40(value) || hasClosedPre80Policy(value)) return false;
  return /引用|使用|采用|依据|参考|参照|纳入|包含|写入|涉及|可|允许|需要|必须|应当/.test(value);
}

function findHou40PolicyViolations(text: string, allowSourceBoundaryMentions = false): string[] {
  if (!mentionsHou40(text)) return [];
  if (!allowSourceBoundaryMentions) return [text];
  return text
    .split(/[\n\r]+|(?<=[。；;])/)
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => mentionsHou40(item) && !isHou40BoundaryInstruction(item));
}

function isHou40BoundaryInstruction(value: string): boolean {
  if (!mentionsHou40(value)) return false;
  return forbidsHou40(value) || hasClosedPre80Policy(value);
}

function forbidsHou40(value: string): boolean {
  const text = normalizeForPolicy(value);
  if (!mentionsHou40(text)) return false;
  return /(不|不得|不要|不能|不可|禁止|避免|排除|不用|无须|无需|勿)/.test(text);
}

function hasClosedPre80Policy(value: string): boolean {
  const text = normalizeForPolicy(value);
  const hasPre80 = /前(?:80|八十)回/.test(text);
  const hasZhiyanzhai = /脂评|脂批|庚辰|甲戌|己卯/.test(text);
  if (!hasPre80 && !hasZhiyanzhai) return false;
  return /仅|只|限|依据|基于|以|允许引用|来源|资料|策略|版本/.test(text);
}

function mentionsHou40(value: string): boolean {
  const text = normalizeForPolicy(value);
  return /后(?:40|四十)回|後(?:40|四十)回|(?:第)?(?:40|四十)回(?:后|後|以后|以後|之后|之後)|程高|续书|續書/.test(text);
}

function mentionsSubjectiveProseAvoidance(value: string): boolean {
  const text = normalizeForPolicy(value);
  return /大段/.test(text) && /(主观|評論|评论|抒情|空泛)/.test(text);
}

function knowledgeText(item: KnowledgeItem): string {
  return [
    item.title,
    item.content,
    item.sourceRef,
    ...(item.themeTags ?? []),
    metadataText(item.metadata),
  ].join('\n');
}

function metadataText(value: unknown): string {
  if (!value) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeForPolicy(value: string): string {
  return value.replace(/[\s。；;，,、.]+/g, '').replace(/前八十囬/g, '前八十回');
}

function samePolicyMeaning(left: string, right: string): boolean {
  return normalizeForPolicy(left) === normalizeForPolicy(right);
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const item = value.trim();
    const key = normalizeForPolicy(item);
    if (!item || seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}
