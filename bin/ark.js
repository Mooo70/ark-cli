#!/usr/bin/env node
import { main } from '../src/cli.js';

main(process.argv.slice(2)).catch((err) => {
  const msg = err && err.message ? err.message : String(err);
  console.error(`\n[ark] 失败：${msg}`);
  if (process.env.ARK_DEBUG && err && err.stack) console.error(err.stack);
  process.exit(err && err.exitCode ? err.exitCode : 1);
});
