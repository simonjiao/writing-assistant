import domainProfileRules from './rules/domain-profiles.json';

export interface DomainProfileSelectionRequest {
  id: string;
  selections?: Record<string, string | string[]>;
}

export interface DomainProfileOptionSummary {
  id: string;
  label: string;
  description?: string;
  defaultSelected?: boolean;
}

export interface DomainProfileGroupSummary {
  id: string;
  label: string;
  type: 'single' | 'multi';
  options: DomainProfileOptionSummary[];
}

export interface DomainProfileSummary {
  id: string;
  label: string;
  description: string;
  groups: DomainProfileGroupSummary[];
}

export interface DomainProfileRecommendation {
  id: string;
  label: string;
  description: string;
  score: number;
}

export interface ResolvedDomainProfileContext {
  profileId: string;
  label: string;
  editions: string[];
  themes: string[];
  mustInclude: string[];
  mustAvoid: string[];
  sourcePolicies: string[];
}

interface DomainProfileOption extends DomainProfileOptionSummary {
  apply: Partial<Omit<ResolvedDomainProfileContext, 'profileId' | 'label'>>;
}

interface DomainProfileGroup {
  id: string;
  label: string;
  type: 'single' | 'multi';
  options: DomainProfileOption[];
}

interface DomainProfileRecommendationRules {
  includeAny: string[];
  excludeAny?: string[];
}

interface DomainProfile {
  id: string;
  label: string;
  description: string;
  recommendation: DomainProfileRecommendationRules;
  groups: DomainProfileGroup[];
}

const domainProfiles = domainProfileRules as DomainProfile[];

export function listDomainProfileSummaries(): DomainProfileSummary[] {
  return domainProfiles.map(toSummary);
}

export function getDomainProfileSummary(profileId: string): DomainProfileSummary | undefined {
  const profile = domainProfiles.find((item) => item.id === profileId);
  return profile ? toSummary(profile) : undefined;
}

export function recommendDomainProfiles(rawRequirement: string, limit = 3): DomainProfileRecommendation[] {
  const text = normalizeMatchText(rawRequirement);
  if (!text) return [];
  return domainProfiles
    .map((profile) => ({ id: profile.id, label: profile.label, description: profile.description, score: scoreProfile(profile, text) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))
    .slice(0, limit);
}

export function resolveDomainProfileSelection(request?: DomainProfileSelectionRequest): ResolvedDomainProfileContext | undefined {
  if (!request?.id) return undefined;
  const profile = domainProfiles.find((item) => item.id === request.id);
  if (!profile) throw new Error(`Unknown domain profile: ${request.id}`);
  const resolved: ResolvedDomainProfileContext = { profileId: profile.id, label: profile.label, editions: [], themes: [], mustInclude: [], mustAvoid: [], sourcePolicies: [] };
  for (const group of profile.groups) {
    const selectedIds = selectedOptionIds(group, request.selections?.[group.id]);
    for (const id of selectedIds) {
      const option = group.options.find((item) => item.id === id);
      if (!option) throw new Error(`Unknown domain profile option: ${profile.id}.${group.id}.${id}`);
      mergeResolved(resolved, option.apply);
    }
  }
  return dedupeResolved(resolved);
}

function toSummary(profile: DomainProfile): DomainProfileSummary {
  return {
    id: profile.id,
    label: profile.label,
    description: profile.description,
    groups: profile.groups.map((group) => ({
      id: group.id,
      label: group.label,
      type: group.type,
      options: group.options.map(({ id, label, description, defaultSelected }) => ({ id, label, description, defaultSelected })),
    })),
  };
}

function scoreProfile(profile: DomainProfile, normalizedText: string): number {
  const excluded = profile.recommendation.excludeAny?.some((term) => normalizedText.includes(normalizeMatchText(term)));
  if (excluded) return 0;
  return profile.recommendation.includeAny.reduce((score, term) => score + (normalizedText.includes(normalizeMatchText(term)) ? 1 : 0), 0);
}

function normalizeMatchText(value: string): string {
  return value.replace(/\s+/g, '').toLowerCase();
}

function selectedOptionIds(group: DomainProfileGroup, value: string | string[] | undefined): string[] {
  const defaults = group.options.filter((item) => item.defaultSelected).map((item) => item.id);
  if (value === undefined) return defaults;
  if (group.type === 'single') return typeof value === 'string' && value ? [value] : defaults;
  return Array.isArray(value) ? value.filter(Boolean) : (value ? [value] : []);
}

function mergeResolved(target: ResolvedDomainProfileContext, source: Partial<Omit<ResolvedDomainProfileContext, 'profileId' | 'label'>>): void {
  target.editions.push(...(source.editions ?? []));
  target.themes.push(...(source.themes ?? []));
  target.mustInclude.push(...(source.mustInclude ?? []));
  target.mustAvoid.push(...(source.mustAvoid ?? []));
  target.sourcePolicies.push(...(source.sourcePolicies ?? []));
}

function dedupeResolved(value: ResolvedDomainProfileContext): ResolvedDomainProfileContext {
  return {
    ...value,
    editions: [...new Set(value.editions)],
    themes: [...new Set(value.themes)],
    mustInclude: [...new Set(value.mustInclude)],
    mustAvoid: [...new Set(value.mustAvoid)],
    sourcePolicies: [...new Set(value.sourcePolicies)],
  };
}
