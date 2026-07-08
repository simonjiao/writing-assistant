import { resolve } from 'node:path';
import { defineProductSkillModule } from '@wa/runtime';

export default defineProductSkillModule({
  id: 'patch-block',
  skillPath: resolve(__dirname, 'skill.md'),
  promptPaths: [resolve(__dirname, 'prompts/patch-editor.system.md')],
  tools: ['patch_block'],
  actions: {},
});
