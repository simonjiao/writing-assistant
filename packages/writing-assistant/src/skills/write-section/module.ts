import { resolve } from 'node:path';
import { defineProductSkillModule } from '@wa/runtime';

export default defineProductSkillModule({
  id: 'write-section',
  skillPath: resolve(__dirname, 'skill.md'),
  tools: ['write_section'],
  actions: {
    write_section: { toolName: 'write_section' },
    write_next_section: { toolName: 'write_section' },
  },
});
