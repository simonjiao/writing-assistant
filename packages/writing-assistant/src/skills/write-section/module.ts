import { resolve } from 'node:path';
import { defineProductSkillModule } from '@wa/runtime';

export default defineProductSkillModule({
  id: 'write-section',
  skillPath: resolve(__dirname, 'skill.md'),
  promptPaths: [
    resolve(__dirname, 'prompts/section-writer.system.md'),
    resolve(__dirname, 'prompts/section-writer.overlong-reviser.system.md'),
    resolve(__dirname, 'prompts/section-writer.source-ref-reviser.system.md'),
  ],
  tools: ['write_section'],
  actions: {
    write_section: { toolName: 'write_section' },
    write_next_section: { toolName: 'write_section' },
  },
});
