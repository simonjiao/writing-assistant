const { cpSync, existsSync, mkdirSync, rmSync } = require('node:fs');
const { resolve } = require('node:path');

const packageRoot = resolve(__dirname, '..');
const source = resolve(packageRoot, 'product-skills');
const target = resolve(packageRoot, 'dist', 'product-skills');

if (!existsSync(source)) {
  throw new Error(`Product skill source directory not found: ${source}`);
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });
