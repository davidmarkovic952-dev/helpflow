import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { createApp } from './app.js';

const cfg = loadConfig();
const clientDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist');
createApp(createPool(cfg.DATABASE_URL), cfg, { clientDir }).listen(cfg.PORT, () => console.log(`HelpFlow: http://localhost:${cfg.PORT}`));
