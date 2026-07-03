import writingStandardRules from './rules/writing-standards.json';

export interface WritingStandardOptionSummary {
  id: string;
  label: string;
  description: string;
}

export interface WritingStandardSummary {
  id: string;
  label: string;
  defaultOptionId: string;
  options: WritingStandardOptionSummary[];
}

export interface WritingStandardSelectionRequest {
  languageEra?: string;
  extraForbiddenTerms?: string[];
}

export interface ReplacementHint {
  avoid: string;
  prefer: string;
}

export interface ResolvedWritingStandardContext {
  id: string;
  label: string;
  languageEra: { id: string; label: string };
  summary: string;
  topRules: string[];
  mustInclude: string[];
  mustAvoid: string[];
  replacementHints: ReplacementHint[];
  sourcePolicies: string[];
}

interface WritingStandardOption extends WritingStandardOptionSummary {
  apply: {
    topRules?: string[];
    mustInclude?: string[];
    mustAvoid?: string[];
    replacementHints?: ReplacementHint[];
    sourcePolicies?: string[];
  };
}

interface WritingStandardRules {
  languageEra: {
    id: string;
    label: string;
    defaultOptionId: string;
    options: WritingStandardOption[];
  };
}

const writingStandards = writingStandardRules as WritingStandardRules;

export function getWritingStandardSummary(): WritingStandardSummary {
  const standard = writingStandards.languageEra;
  return {
    id: standard.id,
    label: standard.label,
    defaultOptionId: standard.defaultOptionId,
    options: standard.options.map(({ id, label, description }) => ({ id, label, description })),
  };
}

export function resolveWritingStandardSelection(request?: WritingStandardSelectionRequest): ResolvedWritingStandardContext {
  const standard = writingStandards.languageEra;
  const optionId = request?.languageEra?.trim() || standard.defaultOptionId;
  const option = standard.options.find((item) => item.id === optionId);
  if (!option) throw new Error(`Unknown language era writing standard: ${optionId}`);
  const extraForbiddenTerms = uniqueStrings(request?.extraForbiddenTerms ?? []);
  return {
    id: standard.id,
    label: standard.label,
    languageEra: { id: option.id, label: option.label },
    summary: option.description,
    topRules: uniqueStrings([
      ...(option.apply.topRules ?? []),
      ...(extraForbiddenTerms.length ? [`额外禁用词：${extraForbiddenTerms.join('、')}`] : []),
    ]),
    mustInclude: uniqueStrings(option.apply.mustInclude),
    mustAvoid: uniqueStrings([...(option.apply.mustAvoid ?? []), ...extraForbiddenTerms]),
    replacementHints: uniqueReplacementHints(option.apply.replacementHints),
    sourcePolicies: uniqueStrings(option.apply.sourcePolicies),
  };
}

export function getWritingStandardDisplaySummary(languageEra?: string): string | undefined {
  const value = languageEra?.trim();
  if (!value) return undefined;
  const option = writingStandards.languageEra.options.find((item) => item.id === value || item.label === value);
  return option?.description;
}

function uniqueStrings(values: string[] = []): string[] {
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))];
}

function uniqueReplacementHints(values: ReplacementHint[] = []): ReplacementHint[] {
  const seen = new Set<string>();
  return values.filter((item) => {
    const avoid = item.avoid.trim();
    const prefer = item.prefer.trim();
    if (!avoid || !prefer || seen.has(avoid)) return false;
    seen.add(avoid);
    return true;
  });
}
