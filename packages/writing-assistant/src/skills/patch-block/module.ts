import { resolve } from 'node:path';
import { defineProductSkillModule } from '@wa/runtime';

export default defineProductSkillModule({
  id: 'patch-block',
  skillPath: resolve(__dirname, 'skill.md'),
  tools: ['patch_block'],
  actions: {},
});
