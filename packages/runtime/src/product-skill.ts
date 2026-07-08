import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { ProductSkillModule } from './product-module';

export interface ProductSkillSpec {
  id: string;
  title: string;
  version: number;
  goal: string;
  whenToUse: string[];
  inputContract: string[];
  steps: string[];
  ragPolicy: string[];
  humanGatePolicy: string[];
  toolBindings: string[];
  completionCriteria: string[];
  failurePolicy: string[];
  promptRules: string[];
  actionHints: Record<string, string>;
}

export interface ProductSkillPromptContext {
  id: string;
  title: string;
  version: number;
  goal: string;
  rules: string[];
}

const allowedFrontmatterFields = new Set(['id', 'title', 'version', 'tools', 'actions']);
const requiredSections = [
  'Goal',
  'When To Use',
  'Inputs',
  'Process',
  'RAG Policy',
  'Human Gate Policy',
  'Completion Criteria',
  'Failure Policy',
  'Prompt Rules',
] as const;
const allowedSections = new Set<string>([...requiredSections, 'Notes']);

const frontmatterSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  version: z.number().int().positive(),
  tools: z.array(z.string().min(1)).min(1),
  actions: z.record(z.string(), z.string().min(1)),
}).strict();

const productSkillSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  version: z.number().int().positive(),
  goal: z.string().min(1),
  whenToUse: z.array(z.string().min(1)).min(1),
  inputContract: z.array(z.string().min(1)).min(1),
  steps: z.array(z.string().min(1)).min(1),
  ragPolicy: z.array(z.string().min(1)).min(1),
  humanGatePolicy: z.array(z.string().min(1)).min(1),
  toolBindings: z.array(z.string().min(1)).min(1),
  completionCriteria: z.array(z.string().min(1)).min(1),
  failurePolicy: z.array(z.string().min(1)).min(1),
  promptRules: z.array(z.string().min(1)).min(1),
  actionHints: z.record(z.string(), z.string().min(1)),
}).strict();

export function loadProductSkillsFromDirectory(directory: string): ProductSkillSpec[] {
  if (!existsSync(directory)) throw new Error(`Product skill directory not found: ${directory}`);
  const files = readdirSync(directory)
    .filter((file) => file.endsWith('.md'))
    .sort();
  if (!files.length) throw new Error(`Product skill directory has no Markdown skill files: ${directory}`);
  return files.map((file) => parseProductSkillMarkdown(readFileSync(resolve(directory, file), 'utf8'), resolve(directory, file)));
}

export function loadProductSkillsFromModules(modules: ProductSkillModule[]): ProductSkillSpec[] {
  return modules.map((module) => {
    if (!existsSync(module.skillPath)) throw new Error(`Product skill file not found for ${module.id}: ${module.skillPath}`);
    const skill = parseProductSkillMarkdown(readFileSync(module.skillPath, 'utf8'), module.skillPath);
    if (skill.id !== module.id) throw new Error(`Product skill module id ${module.id} does not match skill.md id ${skill.id}.`);
    const moduleTools = new Set(module.tools);
    for (const toolName of moduleTools) {
      if (!skill.toolBindings.includes(toolName)) throw new Error(`Product skill ${skill.id} module declares tool ${toolName}, but skill.md does not list it.`);
    }
    for (const toolName of skill.toolBindings) {
      if (!moduleTools.has(toolName)) throw new Error(`Product skill ${skill.id} skill.md lists tool ${toolName}, but module.ts does not bind it.`);
    }
    return skill;
  });
}

export function registerProductSkillsFromModules(modules: ProductSkillModule[], registry = new ProductSkillRegistry()): ProductSkillRegistry {
  for (const skill of loadProductSkillsFromModules(modules)) registry.register(skill);
  return registry;
}

export function parseProductSkillMarkdown(markdown: string, sourcePath = 'inline product skill'): ProductSkillSpec {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) throw new Error(`Product skill ${sourcePath} must start with YAML frontmatter.`);
  const frontmatter = parseFrontmatter(match[1], sourcePath);
  const sections = parseSections(match[2], sourcePath);
  for (const section of requiredSections) {
    if (!sections.has(section)) throw new Error(`Product skill ${sourcePath} is missing required section: ${section}`);
  }
  const skill = productSkillSchema.parse({
    id: frontmatter.id,
    title: frontmatter.title,
    version: frontmatter.version,
    goal: parseGoalSection(sections.get('Goal') ?? '', sourcePath),
    whenToUse: parseListSection(sections.get('When To Use') ?? '', 'When To Use', sourcePath),
    inputContract: parseListSection(sections.get('Inputs') ?? '', 'Inputs', sourcePath),
    steps: parseListSection(sections.get('Process') ?? '', 'Process', sourcePath),
    ragPolicy: parseListSection(sections.get('RAG Policy') ?? '', 'RAG Policy', sourcePath),
    humanGatePolicy: parseListSection(sections.get('Human Gate Policy') ?? '', 'Human Gate Policy', sourcePath),
    toolBindings: frontmatter.tools,
    completionCriteria: parseListSection(sections.get('Completion Criteria') ?? '', 'Completion Criteria', sourcePath),
    failurePolicy: parseListSection(sections.get('Failure Policy') ?? '', 'Failure Policy', sourcePath),
    promptRules: parseListSection(sections.get('Prompt Rules') ?? '', 'Prompt Rules', sourcePath),
    actionHints: frontmatter.actions,
  });
  return skill as ProductSkillSpec;
}

export class ProductSkillRegistry {
  private readonly skills = new Map<string, ProductSkillSpec>();

  register(skill: ProductSkillSpec): void {
    if (this.skills.has(skill.id)) throw new Error(`Duplicate product skill id: ${skill.id}`);
    if (!skill.toolBindings.length) throw new Error(`Product skill ${skill.id} must bind at least one tool.`);
    this.skills.set(skill.id, skill);
  }

  get(skillId: string): ProductSkillSpec {
    const skill = this.skills.get(skillId);
    if (!skill) throw new Error(`Product skill not found: ${skillId}`);
    return skill;
  }

  list(): ProductSkillSpec[] {
    return [...this.skills.values()];
  }
}

export function productSkillPromptContext(skill: ProductSkillSpec): ProductSkillPromptContext {
  return {
    id: skill.id,
    title: skill.title,
    version: skill.version,
    goal: skill.goal,
    rules: [
      ...skill.promptRules,
      ...skill.ragPolicy.map((rule) => `RAG：${rule}`),
      ...skill.humanGatePolicy.map((rule) => `人工确认：${rule}`),
      ...skill.completionCriteria.map((rule) => `完成标准：${rule}`),
    ].slice(0, 18),
  };
}

export function formatProductSkillPromptBlock(skill: ProductSkillPromptContext): string {
  return [
    '当前产品 Skill：',
    `- id：${skill.id}`,
    `- version：${skill.version}`,
    `- 名称：${skill.title}`,
    `- 目标：${skill.goal}`,
    ...skill.rules.map((rule) => `- ${rule}`),
  ].join('\n');
}

function parseFrontmatter(raw: string, sourcePath: string): z.infer<typeof frontmatterSchema> {
  const result: Record<string, unknown> = {};
  let currentBlock: 'tools' | 'actions' | undefined;
  const seen = new Set<string>();
  for (const [index, line] of raw.split('\n').entries()) {
    if (!line.trim()) continue;
    const lineNumber = index + 2;
    const listMatch = line.match(/^  - (.+)$/);
    if (listMatch) {
      if (currentBlock !== 'tools') throw new Error(`Invalid list item in ${sourcePath}:${lineNumber}. Only tools supports list items.`);
      result.tools = [...((result.tools as string[] | undefined) ?? []), cleanScalar(listMatch[1])];
      continue;
    }
    const mapMatch = line.match(/^  ([A-Za-z_][A-Za-z0-9_]*): (.+)$/);
    if (mapMatch) {
      if (currentBlock !== 'actions') throw new Error(`Invalid map item in ${sourcePath}:${lineNumber}. Only actions supports map items.`);
      result.actions = { ...((result.actions as Record<string, string> | undefined) ?? {}), [mapMatch[1]]: cleanScalar(mapMatch[2]) };
      continue;
    }
    if (/^\s/.test(line)) throw new Error(`Invalid indentation in ${sourcePath}:${lineNumber}.`);
    const scalarMatch = line.match(/^([A-Za-z][A-Za-z0-9_-]*):(.*)$/);
    if (!scalarMatch) throw new Error(`Invalid frontmatter line in ${sourcePath}:${lineNumber}.`);
    const key = scalarMatch[1];
    const value = scalarMatch[2].trim();
    if (!allowedFrontmatterFields.has(key)) throw new Error(`Unknown frontmatter field in ${sourcePath}:${lineNumber}: ${key}`);
    if (seen.has(key)) throw new Error(`Duplicate frontmatter field in ${sourcePath}:${lineNumber}: ${key}`);
    seen.add(key);
    currentBlock = undefined;
    if (key === 'tools') {
      if (value) throw new Error(`tools must be a block list in ${sourcePath}:${lineNumber}.`);
      result.tools = [];
      currentBlock = 'tools';
      continue;
    }
    if (key === 'actions') {
      result.actions = value === '{}' || !value ? {} : fail(`actions must be a block map or {} in ${sourcePath}:${lineNumber}.`);
      currentBlock = 'actions';
      continue;
    }
    if (key === 'version') {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isInteger(parsed) || String(parsed) !== value) throw new Error(`version must be an integer in ${sourcePath}:${lineNumber}.`);
      result.version = parsed;
      continue;
    }
    result[key] = cleanScalar(value);
  }
  return frontmatterSchema.parse(result);
}

function parseSections(body: string, sourcePath: string): Map<string, string> {
  const sections = new Map<string, string[]>();
  let current: string | undefined;
  for (const [index, line] of body.split('\n').entries()) {
    const heading = line.match(/^## (.+)$/);
    if (heading) {
      const name = heading[1].trim();
      if (!allowedSections.has(name)) throw new Error(`Unknown product skill section in ${sourcePath}:${index + 1}: ${name}`);
      if (sections.has(name)) throw new Error(`Duplicate product skill section in ${sourcePath}:${index + 1}: ${name}`);
      current = name;
      sections.set(name, []);
      continue;
    }
    if (!current) {
      if (line.trim()) throw new Error(`Content before first section in ${sourcePath}:${index + 1}.`);
      continue;
    }
    sections.get(current)?.push(line);
  }
  return new Map([...sections.entries()].map(([key, lines]) => [key, lines.join('\n').trim()]));
}

function parseGoalSection(raw: string, sourcePath: string): string {
  const value = raw.trim();
  if (!value) throw new Error(`Goal section is empty in ${sourcePath}.`);
  return value.replace(/\n+/g, ' ');
}

function parseListSection(raw: string, section: string, sourcePath: string): string[] {
  if (!raw.trim()) throw new Error(`${section} section is empty in ${sourcePath}.`);
  return raw.split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^- (.+)$/);
      if (!match) throw new Error(`${section} entries must be bullet lines in ${sourcePath}: ${line}`);
      return match[1].trim();
    });
}

function cleanScalar(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function fail(message: string): never {
  throw new Error(message);
}
