import { readFile } from 'node:fs/promises';

import { importCatalogMarkdown } from '../src/catalog/catalog-markdown-importer.mjs';
import { initializeDatabase } from '../src/db/database.mjs';

function usage() {
  return [
    'Usage:',
    '  node server/scripts/import-catalog-markdown.mjs --target-kind fixture|copy --database PATH --markdown PATH [--image-map PATH] [--apply] [--backup PATH]',
    '',
    'Without --apply the command performs a dry-run. Production targets are rejected.',
  ].join('\n');
}

function parseArguments(argv) {
  const values = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') {
      values.apply = true;
      continue;
    }
    const match = argument.match(/^--([a-z-]+)=(.*)$/);
    if (match) {
      values[match[1]] = match[2];
      continue;
    }
    const key = argument.match(/^--([a-z-]+)$/)?.[1];
    if (!key || index + 1 >= argv.length || argv[index + 1].startsWith('--')) throw new Error(usage());
    values[key] = argv[++index];
  }
  return values;
}

const options = parseArguments(process.argv.slice(2));
if (!options['target-kind'] || !options.database || !options.markdown) throw new Error(usage());

const markdown = await readFile(options.markdown, 'utf8');
const imageMappingMarkdown = options['image-map'] ? await readFile(options['image-map'], 'utf8') : undefined;
const connection = initializeDatabase({ databasePath: options.database });
try {
  const result = await importCatalogMarkdown({
    database: connection.database,
    databasePath: options.database,
    targetKind: options['target-kind'],
    markdown,
    imageMappingMarkdown,
    dryRun: !options.apply,
    backupPath: options.backup,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.errors.length > 0) process.exitCode = 1;
} finally {
  connection.close();
}
