import { cmdFetch } from './lib/commands/fetch.mjs';
import { cmdExtractCode } from './lib/commands/extract-code.mjs';
import { cmdFinalize } from './lib/commands/finalize.mjs';
import { cmdVerifySource } from './lib/commands/verify-source.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

async function main() {
  const [, , command, ...rest] = process.argv;
  const args = parseArgs(rest);
  const commands = {
    fetch: () => cmdFetch(args),
    'extract-code': () => cmdExtractCode(args),
    finalize: () => cmdFinalize(args),
    'verify-source': () => cmdVerifySource(args),
  };
  if (command === 'check') {
    args['fail-on-stale'] = args['fail-on-stale'] ?? true;
    return cmdExtractCode(args);
  }
  const run = commands[command];
  if (!run) {
    console.error(
      `ERROR: Unknown command "${command ?? ''}". Use: fetch | extract-code | finalize | check | verify-source`,
    );
    process.exit(1);
  }
  return run();
}

main().catch((err) => {
  console.error(`ERROR: ${err.stack || err.message || err}`);
  process.exit(1);
});
