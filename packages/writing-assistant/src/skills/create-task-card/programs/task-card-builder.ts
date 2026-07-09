import { resolve } from 'node:path';
import { newId, nowIso, safeJsonParse, TaskCardFollowUpPrompt, WritingTaskCard } from '@wa/core';
import { PromptProgram } from '@wa/runtime';
import { normalizeTaskCardPolicies } from '../../../domain/task-card-policy';
import { extractConfiguredAvoidanceRules, extractExplicitAvoidances } from '../../../domain/writing-constraints';
import { loadWritingAssistantSystemPrompt } from '../../../shared/prompt-guard';

const systemPrompt = loadWritingAssistantSystemPrompt(resolve(__dirname, '../prompts/task-card-builder.system.md'));

export interface TaskCardBuilderInput {
  articleId?: string;
  rawRequirement: string;
  userId: string;
  sessionId?: string;
  skipKnowledge?: boolean;
  domainContext?: TaskCardDomainContext;
  writingStandard?: TaskCardWritingStandardContext;
}

export interface TaskCardDomainContext {
  profileId: string;
  label: string;
  editions: string[];
  themes: string[];
  mustInclude: string[];
  mustAvoid: string[];
  sourcePolicies: string[];
}

export interface TaskCardWritingStandardContext {
  id: string;
  label: string;
  languageEra: { id: string; label: string };
  summary: string;
  topRules: string[];
  mustInclude: string[];
  mustAvoid: string[];
  replacementHints: Array<{ avoid: string; prefer: string }>;
  sourcePolicies: string[];
}

export interface TaskCardBuilderOutput {
  taskCard: WritingTaskCard;
  missingQuestions: string[];
  followUpPrompts?: TaskCardFollowUpPrompt[];
  summary: string;
  confidence: number;
}

export class TaskCardBuilderProgram implements PromptProgram<TaskCardBuilderInput, TaskCardBuilderOutput> {
  manifest = {
    id: 'task-card-builder',
    name: 'Task Card Builder',
    version: '0.1.0',
    description: '把用户的自然语言写作需求转成结构化任务卡。',
    policies: {
      askOnlyNecessaryQuestions: true,
      doNotStartWritingBeforeConfirmation: true,
    },
  };

  async invoke({ input, context, llm }: Parameters<PromptProgram<TaskCardBuilderInput, TaskCardBuilderOutput>['invoke']>[0]): Promise<TaskCardBuilderOutput> {
    const rawRequirement = requireInputRequirement(input.rawRequirement);
    const user = JSON.stringify({
      rawRequirement,
      writingStandard: input.writingStandard,
      domainContext: input.domainContext,
      userPreferences: context.memory,
    });

    const response = await llm.chat({
      jsonMode: true,
      temperature: 0.2,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: user },
      ],
    });
    const parsed = safeJsonParse<Partial<TaskCardBuilderOutput>>(response.content);
    if (!parsed?.taskCard) throw new Error(`Task card builder did not return a valid taskCard: ${response.content.slice(0, 300)}`);
    return normalizeOutput(parsed, rawRequirement, input.domainContext, input.writingStandard);
  }
}

function normalizeOutput(output: Partial<TaskCardBuilderOutput>, rawRequirement: string, domainContext?: TaskCardDomainContext, writingStandard?: TaskCardWritingStandardContext): TaskCardBuilderOutput {
  const explicit = extractExplicitTaskHints(rawRequirement);
  const now = nowIso();
  const source = output.taskCard;
  if (!source) throw new Error('Task card builder returned no taskCard.');
  const missingQuestions = requireStringArray(output.missingQuestions, 'missingQuestions');
  const followUpPrompts = requireFollowUpPrompts(output.followUpPrompts, missingQuestions, 'followUpPrompts');
  const taskCard: WritingTaskCard = {
    ...source,
    id: source.id ?? newId('task'),
    topic: normalizeTopic(source.topic, rawRequirement, explicit.topic),
    writingGoal: requireText(source.writingGoal, 'taskCard.writingGoal'),
    audience: requireText(source.audience, 'taskCard.audience'),
    topRules: {
      languageEra: nonEmptyString(source.topRules?.languageEra, writingStandard?.languageEra.label),
      summary: nonEmptyString(source.topRules?.summary, writingStandard?.summary),
      writingStandards: mergeStrings(mergeStrings(selectedTopRules(writingStandard), explicit.topRules), source.topRules?.writingStandards),
      replacementHints: mergeReplacementHints(selectedReplacementHints(writingStandard), source.topRules?.replacementHints),
    },
    status: 'draft',
    createdAt: source.createdAt ?? now,
    updatedAt: now,
    scope: {
      editions: mergeStrings(domainContext?.editions, source.scope?.editions),
      chapters: nonEmptyStrings(source.scope?.chapters),
      characters: mergeStrings(explicit.characters, source.scope?.characters),
      themes: mergeStrings(mergeStrings(domainContext?.themes, explicit.themes), source.scope?.themes),
    },
    structure: {
      articleType: explicit.articleType === 'longform' ? 'longform' : requireArticleType(source.structure?.articleType),
      expectedLength: requireText(source.structure?.expectedLength, 'taskCard.structure.expectedLength'),
      outlinePreference: requireText(source.structure?.outlinePreference, 'taskCard.structure.outlinePreference'),
    },
    style: {
      register: requireText(source.style?.register, 'taskCard.style.register'),
      tone: requireText(source.style?.tone, 'taskCard.style.tone'),
      classicalFlavor: explicit.classicalFlavor || (source.style?.classicalFlavor ?? false),
      characterVoice: nonEmptyString(source.style?.characterVoice),
    },
    constraints: {
      citationRequired: explicit.citationRequired || (source.constraints?.citationRequired ?? false),
      mustInclude: mergeStrings(mergeStrings(mergeStrings(domainContext?.mustInclude, selectedMustInclude(writingStandard)), explicit.mustInclude), source.constraints?.mustInclude),
      mustAvoid: mergeStrings(mergeStrings(mergeStrings(domainContext?.mustAvoid, selectedMustAvoid(writingStandard)), explicit.mustAvoid), source.constraints?.mustAvoid),
      sourcePolicy: mergeSourcePolicy(requireText(source.constraints?.sourcePolicy, 'taskCard.constraints.sourcePolicy'), [...selectedSourcePolicies(writingStandard), ...(domainContext?.sourcePolicies ?? [])]),
    },
    interactionMode: {
      askBeforeWriting: true,
      localEditFirst: true,
      followUpQuestions: missingQuestions,
      followUpPrompts,
    },
  };
  const normalized = normalizeTaskCardPolicies(taskCard, rawRequirement).taskCard;
  return {
    taskCard: normalized,
    missingQuestions,
    followUpPrompts,
    summary: requireText(output.summary, 'summary'),
    confidence: requireConfidence(output.confidence),
  };
}

function requireFollowUpPrompts(value: unknown, missingQuestions: string[], field: string): TaskCardFollowUpPrompt[] {
  const prompts = Array.isArray(value) ? value : [];
  const normalized = prompts
    .map((item, index) => normalizeFollowUpPrompt(item, index))
    .filter((item): item is TaskCardFollowUpPrompt => Boolean(item));
  if (normalized.length) return normalized.slice(0, 3);
  if (missingQuestions.length) throw new Error(`${field} must include prompts for missingQuestions.`);
  return [];
}

function normalizeFollowUpPrompt(value: unknown, index: number): TaskCardFollowUpPrompt | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as { id?: unknown; question?: unknown; options?: unknown; allowCustom?: unknown; selectionMode?: unknown };
  if (typeof raw.question !== 'string' || !raw.question.trim()) return undefined;
  const options = Array.isArray(raw.options) ? raw.options.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()).slice(0, 4) : [];
  const question = raw.question.trim();
  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `prompt-${index + 1}`,
    question,
    options: [...new Set(options)],
    allowCustom: typeof raw.allowCustom === 'boolean' ? raw.allowCustom : true,
    selectionMode: normalizePromptSelectionMode(raw.selectionMode, question),
  };
}

function normalizePromptSelectionMode(value: unknown, question: string): TaskCardFollowUpPrompt['selectionMode'] {
  if (value === 'single' || value === 'multi') return value;
  return shouldUseMultiSelection(question) ? 'multi' : 'single';
}

function shouldUseMultiSelection(question: string): boolean {
  return /多选|多个|哪些|哪几|场景|情节|事件|材料|重点|要点|方面|关系|线索/.test(question);
}

function requireInputRequirement(value: string): string {
  const text = value.trim();
  if (!text) throw new Error('Task card builder requires a non-empty rawRequirement.');
  return text;
}

function nonEmptyString(value: unknown, defaultValue?: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : (defaultValue ?? '');
}

function nonEmptyStrings(value: unknown, defaultValues: string[] = []): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()) : defaultValues;
}

function mergeStrings(base: string[] = [], extra: unknown): string[] {
  return [...new Set([...base, ...nonEmptyStrings(extra, [])])];
}

function mergeSourcePolicy(sourcePolicy: string, selectedPolicies: string[] = []): string {
  const policies = [sourcePolicy, ...selectedPolicies].map((item) => item.trim()).filter(Boolean);
  return [...new Set(policies)].join('；');
}

function selectedTopRules(writingStandard?: TaskCardWritingStandardContext): string[] {
  return uniqueStrings(writingStandard?.topRules ?? []);
}

function selectedMustInclude(writingStandard?: TaskCardWritingStandardContext): string[] {
  return uniqueStrings(writingStandard?.mustInclude ?? []);
}

function selectedMustAvoid(writingStandard?: TaskCardWritingStandardContext): string[] {
  return uniqueStrings(writingStandard?.mustAvoid ?? []);
}

function selectedSourcePolicies(writingStandard?: TaskCardWritingStandardContext): string[] {
  return uniqueStrings(writingStandard?.sourcePolicies ?? []);
}

function selectedReplacementHints(writingStandard?: TaskCardWritingStandardContext): Array<{ avoid: string; prefer: string }> {
  return writingStandard?.replacementHints ?? [];
}

function mergeReplacementHints(base: Array<{ avoid: string; prefer: string }> = [], extra: unknown): Array<{ avoid: string; prefer: string }> {
  const source = Array.isArray(extra) ? extra : [];
  const values = [...base, ...source.filter(isReplacementHint)];
  const seen = new Set<string>();
  return values.filter((item) => {
    const avoid = item.avoid.trim();
    const prefer = item.prefer.trim();
    if (!avoid || !prefer || seen.has(avoid)) return false;
    seen.add(avoid);
    return true;
  }).map((item) => ({ avoid: item.avoid.trim(), prefer: item.prefer.trim() }));
}

function isReplacementHint(value: unknown): value is { avoid: string; prefer: string } {
  return Boolean(value && typeof value === 'object' && typeof (value as { avoid?: unknown }).avoid === 'string' && typeof (value as { prefer?: unknown }).prefer === 'string');
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))];
}

function isArticleType(value: unknown): value is WritingTaskCard['structure']['articleType'] {
  return value === 'essay' || value === 'analysis' || value === 'commentary' || value === 'speech' || value === 'longform';
}

function requireArticleType(value: unknown): WritingTaskCard['structure']['articleType'] {
  if (!isArticleType(value)) throw new Error(`Task card builder returned invalid articleType: ${String(value)}`);
  return value;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Task card builder returned empty ${field}.`);
  return value.trim();
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Task card builder returned invalid ${field}.`);
  return nonEmptyStrings(value);
}

function requireConfidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Task card builder returned invalid confidence.');
  return Math.max(0, Math.min(1, value));
}

interface ExplicitTaskHints {
  topic: string;
  themes: string[];
  characters: string[];
  mustInclude: string[];
  mustAvoid: string[];
  topRules: string[];
  articleType?: WritingTaskCard['structure']['articleType'];
  classicalFlavor: boolean;
  citationRequired: boolean;
}

function extractExplicitTaskHints(rawRequirement: string): ExplicitTaskHints {
  const hasClassicalFlavor = /半文半白|古典|文雅|含蓄/.test(rawRequirement);
  const isLong = /长文|深入|完整|系统/.test(rawRequirement);
  const citationRequired = /引用|原文|依据|资料|出处|版本/.test(rawRequirement);
  const topic = deriveTopic(rawRequirement);
  const emphasis = extractEmphasis(rawRequirement);
  const scope = extractScope(rawRequirement);
  const themes = mergeStrings(scope.themes, emphasis);
  const mustAvoid = extractExplicitAvoidances(rawRequirement);
  const topRules = extractConfiguredAvoidanceRules(rawRequirement);
  return {
    topic,
    themes,
    characters: scope.characters,
    mustInclude: themes,
    mustAvoid,
    topRules,
    articleType: isLong ? 'longform' : undefined,
    classicalFlavor: hasClassicalFlavor,
    citationRequired,
  };
}

function normalizeTopic(value: unknown, rawRequirement: string, explicitTopic: string): string {
  const candidate = nonEmptyString(value, explicitTopic);
  if (!candidate) throw new Error('Task card builder returned empty taskCard.topic.');
  if (isInstructionLikeTopic(candidate) || sameText(candidate, rawRequirement)) return deriveTopic(rawRequirement);
  return candidate.length > 40 ? deriveTopic(candidate) : candidate;
}

function deriveTopic(rawRequirement: string): string {
  const normalized = rawRequirement.replace(/\s+/g, ' ').trim();
  const aboutMatch = normalized.match(/关于(.+?)(?:的(?:长文|文章|短文|论文|评论|赏析|分析|随笔)|[，,。.!！?？]|$)/);
  if (aboutMatch?.[1]?.trim()) return cleanTopic(aboutMatch[1]);
  const titleMatch = normalized.match(/(?:写|撰写|生成|整理)(?:一篇|一份|一个)?(.+?)(?:[，,。.!！?？]|$)/);
  if (titleMatch?.[1]?.trim()) return cleanTopic(titleMatch[1]);
  return cleanTopic(normalized);
}

function cleanTopic(value: string): string {
  const cleaned = value
    .replace(/^(?:一篇|一份|一个|有关|关于)/, '')
    .replace(/(?:的)?(?:长文|文章|短文|论文|评论|赏析|分析|随笔)$/, '')
    .trim();
  return cleaned.slice(0, 40);
}

function isInstructionLikeTopic(value: string): boolean {
  return /^(请)?(?:写|撰写|生成|整理)(?:一篇|一份|一个)?/.test(value) || value.length > 40;
}

function sameText(a: string, b: string): boolean {
  return a.replace(/\s+/g, '') === b.replace(/\s+/g, '');
}

function extractEmphasis(rawRequirement: string): string[] {
  const values: string[] = [];
  const pattern = /(?:重点(?:写|突出|呈现|强调)?|主要(?:写|表现|讨论)?|核心是|必须包含|要包含)([^，。,.!?！？；;]+)/g;
  for (const match of rawRequirement.matchAll(pattern)) {
    const value = cleanPhrase(match[1]);
    if (value) values.push(value);
  }
  return [...new Set(values)];
}

function cleanPhrase(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/^(?:写|突出|呈现|强调|表现|讨论)/, '').trim();
}

function extractScope(rawRequirement: string): { characters: string[]; themes: string[] } {
  const topic = deriveTopic(rawRequirement);
  const themes = topic ? [topic] : [];
  const characters = splitRelationshipTopic(topic);
  return { characters, themes };
}

function splitRelationshipTopic(topic: string): string[] {
  const normalized = topic.replace(/[《》]/g, '').replace(/中/g, '中 ');
  const relationMatch = normalized.match(/(.+?)(?:关系|情感|友谊|冲突|对照|比较)$/);
  if (!relationMatch?.[1]) return [];
  return relationMatch[1]
    .split(/[、和与及&/／]/)
    .map((item) => item.replace(/.*中\s*/, '').trim())
    .filter((item) => item.length >= 2 && item.length <= 12);
}
