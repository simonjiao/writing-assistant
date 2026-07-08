const { cpSync, existsSync, mkdirSync } = require('node:fs');
const { dirname, resolve } = require('node:path');

const packageRoot = resolve(__dirname, '..');
const copies = [
  ['src/skills', 'dist/skills'],
  ['src/workflows', 'dist/workflows'],
  ['src/rules', 'dist/rules'],
];

for (const [sourceRel, targetRel] of copies) {
  const source = resolve(packageRoot, sourceRel);
  const target = resolve(packageRoot, targetRel);
  if (!existsSync(source)) continue;
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, {
    recursive: true,
    filter: (path) => path.endsWith('.md') || path.endsWith('.json') || !path.includes('.'),
  });
}
