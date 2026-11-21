#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerAuthCommands } from '../src/commands/auth.js';
import { registerCatalogCommands } from '../src/commands/catalog-cmd.js';
import { registerGenerateCommands } from '../src/commands/generate.js';
import { registerSystemCommands } from '../src/commands/system.js';
import { registerWorkflowCommands } from '../src/commands/workflow.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

const program = new Command();

program
  .name('gflow')
  .description(
    'Google AI Flow CLI — Gmail hesabınızla ücretsiz fotoğraf ve kredi-korumalı video üretimi + SQLite ID kataloğu'
  )
  .version(pkg.version);

registerAuthCommands(program);
registerGenerateCommands(program);
registerCatalogCommands(program);
registerWorkflowCommands(program);
registerSystemCommands(program);

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`✗ Beklenmeyen hata: ${err.message}\n`);
  process.exit(1);
});
