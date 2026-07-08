import { AgentContext, LLMProvider } from '@wa/core';

export interface PromptProgram<I, O> {
  manifest: {
    id: string;
    name: string;
    version: string;
    description: string;
    policies?: Record<string, unknown>;
  };
  invoke(input: { input: I; context: AgentContext; llm: LLMProvider }): Promise<O>;
}

export class PromptProgramRegistry {
  private readonly programs = new Map<string, PromptProgram<unknown, unknown>>();

  register<I, O>(program: PromptProgram<I, O>): void {
    this.programs.set(program.manifest.id, program as PromptProgram<unknown, unknown>);
  }

  get<I, O>(programId: string): PromptProgram<I, O> {
    const program = this.programs.get(programId);
    if (!program) throw new Error(`Prompt program not found: ${programId}`);
    return program as PromptProgram<I, O>;
  }

  list() {
    return [...this.programs.values()].map((program) => program.manifest);
  }
}
