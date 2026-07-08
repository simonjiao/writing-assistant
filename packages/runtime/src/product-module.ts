import { existsSync, readFileSync } from 'node:fs';
import { WorkflowPolicy } from '@wa/core';
import type { ProductSkillSpec } from './product-skill';

export interface ProductActionBinding {
  type: string;
  skillId: string;
  skillVersion: number;
  toolName?: string;
  hint: string;
  requiresHumanGate?: boolean;
}

export interface ProductSkillModule {
  id: string;
  skillPath: string;
  promptPaths?: string[];
  tools: string[];
  actions: Record<string, { toolName?: string; hint?: string; requiresHumanGate?: boolean }>;
}

export interface ProductWorkflowModule {
  id: string;
  workflowPath: string;
  policy: WorkflowPolicy;
  skillIds: string[];
}

export interface ProductModule {
  id: string;
  skills: ProductSkillModule[];
  workflows: ProductWorkflowModule[];
}

export class ActionCatalog {
  private readonly bindings = new Map<string, ProductActionBinding>();

  register(binding: ProductActionBinding): void {
    const existing = this.bindings.get(binding.type);
    if (existing) throw new Error(`Duplicate product action type: ${binding.type}`);
    this.bindings.set(binding.type, binding);
  }

  get(type: string): ProductActionBinding | undefined {
    return this.bindings.get(type);
  }

  require(type: string): ProductActionBinding {
    const binding = this.get(type);
    if (!binding) throw new Error(`Product action is not registered: ${type}`);
    return binding;
  }

  list(): ProductActionBinding[] {
    return [...this.bindings.values()];
  }
}

export function buildActionCatalog(skillModules: ProductSkillModule[], skills: ProductSkillSpec[]): ActionCatalog {
  const skillsById = new Map(skills.map((skill) => [skill.id, skill]));
  const catalog = new ActionCatalog();
  for (const module of skillModules) {
    const skill = skillsById.get(module.id);
    if (!skill) throw new Error(`Cannot register actions for missing product skill: ${module.id}`);
    for (const [type, action] of Object.entries(module.actions)) {
      if (action.toolName && !skill.toolBindings.includes(action.toolName)) {
        throw new Error(`Product action ${type} binds unknown tool ${action.toolName} in skill ${skill.id}.`);
      }
      catalog.register({
        type,
        skillId: skill.id,
        skillVersion: skill.version,
        toolName: action.toolName,
        hint: action.hint ?? skill.actionHints[type] ?? skill.goal,
        requiresHumanGate: action.requiresHumanGate,
      });
    }
  }
  return catalog;
}

export function defineProductModule(module: ProductModule): ProductModule {
  const skillIds = new Set<string>();
  for (const skill of module.skills) {
    if (skillIds.has(skill.id)) throw new Error(`Duplicate product skill module id: ${skill.id}`);
    skillIds.add(skill.id);
    if (!existsSync(skill.skillPath)) throw new Error(`Product skill module ${skill.id} is missing skill.md: ${skill.skillPath}`);
    for (const promptPath of skill.promptPaths ?? []) {
      if (!existsSync(promptPath)) throw new Error(`Product skill module ${skill.id} is missing prompt template: ${promptPath}`);
      if (!readFileSync(promptPath, 'utf8').trim()) throw new Error(`Product skill module ${skill.id} has empty prompt template: ${promptPath}`);
    }
  }
  const workflowIds = new Set<string>();
  for (const workflow of module.workflows) {
    if (workflowIds.has(workflow.id)) throw new Error(`Duplicate product workflow module id: ${workflow.id}`);
    workflowIds.add(workflow.id);
    if (!existsSync(workflow.workflowPath)) throw new Error(`Product workflow module ${workflow.id} is missing workflow.md: ${workflow.workflowPath}`);
    for (const skillId of workflow.skillIds) {
      if (!skillIds.has(skillId)) throw new Error(`Product workflow ${workflow.id} references unknown skill module: ${skillId}`);
    }
  }
  return module;
}

export function defineProductSkillModule(module: ProductSkillModule): ProductSkillModule {
  return module;
}

export function defineProductWorkflowModule(module: ProductWorkflowModule): ProductWorkflowModule {
  return module;
}
