import { resolve } from 'node:path';
import { defineProductSkillModule } from '@wa/runtime';

export default defineProductSkillModule({
  id: 'update-dialogue-brief',
  skillPath: resolve(__dirname, 'skill.md'),
  promptPaths: [resolve(__dirname, 'prompts/dialogue-brief-updater.system.md')],
  tools: ['update_dialogue_brief'],
  actions: {},
});
