import { resolve } from 'node:path';
import { loadPromptTemplate } from '@wa/runtime';

export const promptInjectionGuardPromptPath = resolve(__dirname, 'prompts/prompt-injection-guard.system.md');

const promptInjectionGuard = loadPromptTemplate(promptInjectionGuardPromptPath);

export function loadWritingAssistantSystemPrompt(promptPath: string): string {
  return `${promptInjectionGuard}\n\n${loadPromptTemplate(promptPath)}`;
}

export function getPromptInjectionGuard(): string {
  return promptInjectionGuard;
}
