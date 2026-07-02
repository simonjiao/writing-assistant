#!/usr/bin/env node

const requiredMajor = 22;
const actualMajor = Number.parseInt(process.versions.node.split('.')[0], 10);

if (actualMajor !== requiredMajor) {
  console.error(`This project requires Node.js ${requiredMajor}.x. Current runtime: ${process.version}.`);
  console.error('Run `nvm use` or otherwise switch your shell to Node.js 22 before running project commands.');
  process.exit(1);
}
