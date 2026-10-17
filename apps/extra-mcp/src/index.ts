/**
 * Single Docker entrypoint: `SERVER=notes|utils node dist/index.js`.
 * `src/notes.ts` and `src/utils.ts` are the fixed-choice equivalents.
 */
import { createLogger } from './logger.ts';
import { startServer, type ServerDefinition } from './server.ts';
import { selectDefinition } from './servers/registry.ts';

function main(): void {
  const requested = process.env.SERVER;
  let definition: ServerDefinition;
  try {
    definition = selectDefinition(requested);
  } catch (err) {
    createLogger('index').fatal(
      { SERVER: requested ?? null, err: err instanceof Error ? err.message : String(err) },
      'refusing to start',
    );
    process.exit(2);
  }
  startServer(definition);
}

main();
