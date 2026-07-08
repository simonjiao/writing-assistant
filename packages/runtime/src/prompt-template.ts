import { existsSync, readFileSync } from 'node:fs';

export function loadPromptTemplate(path: string): string {
  if (!existsSync(path)) throw new Error(`Prompt template not found: ${path}`);
  const content = readFileSync(path, 'utf8').trim();
  if (!content) throw new Error(`Prompt template is empty: ${path}`);
  return content;
}
