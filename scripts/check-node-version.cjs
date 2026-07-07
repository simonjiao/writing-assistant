#!/usr/bin/env node

const requiredMajor = 22;
const requiredMinor = 19;
const [actualMajor, actualMinor] = process.versions.node.split('.').map((part) => Number.parseInt(part, 10));

if (actualMajor !== requiredMajor || actualMinor < requiredMinor) {
  console.error(`This project requires Node.js >=${requiredMajor}.${requiredMinor}.0 <23. Current runtime: ${process.version}.`);
  console.error('Run `nvm use` or otherwise switch your shell to the project Node.js version before running project commands.');
  process.exit(1);
}
