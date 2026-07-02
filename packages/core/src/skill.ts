import { LLMProvider } from './types';
import { AgentContext } from './context';

export interface SkillManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  policies?: Record<string, unknown>;
}

export interface SkillInvokeContext<I> {
  input: I;
  context: AgentContext;
  llm: LLMProvider;
}

export interface Skill<I = unknown, O = unknown> {
  manifest: SkillManifest;
  invoke(ctx: SkillInvokeContext<I>): Promise<O>;
}

export class SkillRegistry {
  private readonly skills = new Map<string, Skill>();

  register(skill: Skill): void {
    if (this.skills.has(skill.manifest.id)) {
      throw new Error(`Skill already registered: ${skill.manifest.id}`);
    }
    this.skills.set(skill.manifest.id, skill);
  }

  get<I = unknown, O = unknown>(skillId: string): Skill<I, O> {
    const skill = this.skills.get(skillId);
    if (!skill) {
      throw new Error(`Skill not found: ${skillId}`);
    }
    return skill as Skill<I, O>;
  }

  list(): SkillManifest[] {
    return [...this.skills.values()].map((skill) => skill.manifest);
  }
}
