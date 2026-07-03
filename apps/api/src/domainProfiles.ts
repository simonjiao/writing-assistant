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

const domainProfiles: DomainProfile[] = [{
  id: 'hongloumeng-baodai',
  label: '红楼梦：宝黛关系',
  description: '适用于宝黛关系、精神相通、版本边界类写作。',
  recommendation: {
    includeAny: ['宝黛关系', '宝黛', '贾宝玉林黛玉', '宝玉黛玉', '精神相通', '木石前盟'],
    excludeAny: ['宝黛钗', '宝钗', '薛宝钗', '钗黛', '金玉良缘'],
  },
  groups: [
    {
      id: 'edition',
      label: '版本',
      type: 'single',
      options: [
        {
          id: 'zhiyanzhai',
          label: '脂评本',
          defaultSelected: true,
          apply: {
            editions: ['脂评本'],
            sourcePolicies: ['以脂评本前八十回为主要依据，后四十回内容默认不作为论据。'],
            mustAvoid: ['以后四十回情节作为主要论据'],
          },
        },
        {
          id: 'include-later-40',
          label: '包含后四十回',
          apply: {
            editions: ['通行本含后四十回'],
            sourcePolicies: ['可使用通行本后四十回，但需要标明版本边界。'],
          },
        },
      ],
    },
    {
      id: 'themes',
      label: '重点',
      type: 'multi',
      options: [
        {
          id: 'wood-stone',
          label: '木石前盟',
          apply: {
            themes: ['木石前盟'],
            mustInclude: ['把木石前盟作为宝黛精神相通的神话根源处理，避免大段复述原文。'],
          },
        },
        {
          id: 'qinqing',
          label: '情不情 / 情情',
          apply: {
            themes: ['情不情', '情情'],
            mustInclude: ['区分宝玉的情不情与黛玉的情情，用于说明二人精神契合。'],
          },
        },
        {
          id: 'career-economy-boundary',
          label: '仕途经济边界',
          apply: {
            themes: ['仕途经济边界'],
            mustInclude: ['黛玉对宝玉有规劝，但这不等于认同仕途经济价值，也不是把她写成仕途经济代言人。'],
            mustAvoid: ['黛玉从不要求宝玉', '黛玉从不以世俗标准要求宝玉', '把黛玉写成仕途经济代言人', '反对仕途经济的共同体'],
          },
        },
        {
          id: 'zijuan-test',
          label: '紫鹃试玉',
          apply: {
            themes: ['紫鹃试玉'],
            mustInclude: ['用紫鹃试玉说明宝黛关系中的试探、确认与精神牵连。'],
          },
        },
      ],
    },
    {
      id: 'guardrails',
      label: '边界',
      type: 'multi',
      options: [
        {
          id: 'avoid-anti-feudal-alliance',
          label: '不写反封建同盟',
          defaultSelected: true,
          apply: {
            mustAvoid: ['把宝黛关系写成简单的反封建同盟', '反叛的同盟', '反对封建礼教'],
          },
        },
        {
          id: 'avoid-retelling',
          label: '少复述情节',
          defaultSelected: true,
          apply: {
            mustAvoid: ['按故事发生顺序复述情节', '大段复述原文'],
            sourcePolicies: ['材料只能作为论据线索，正文应以分析和写作为主。'],
          },
        },
        {
          id: 'avoid-absolute-daiyu',
          label: '不绝对化黛玉',
          defaultSelected: true,
          apply: {
            mustInclude: ['保留黛玉有规劝但不等于认同功利价值的复杂性。'],
            mustAvoid: ['黛玉从不要求宝玉', '黛玉完全不要求宝玉', '黛玉没有要求宝玉'],
          },
        },
      ],
    },
  ],
}];

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
