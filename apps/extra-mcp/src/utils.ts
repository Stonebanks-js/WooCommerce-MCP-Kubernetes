/** Entrypoint for the utils server: `npm run start:utils` / `npm run dev:utils`. */
import { startServer } from './server.ts';
import { utilsServer } from './servers/utils.ts';

startServer(utilsServer);
