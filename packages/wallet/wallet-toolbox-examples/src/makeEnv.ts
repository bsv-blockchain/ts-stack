import { Setup } from '@bsv/wallet-toolbox'
import { runArgv2Function } from './runArgv2Function'
/**
 * Running the `makeEnv` function generates several new private keys
 * and related `.env` file initializers which simplify use of the `Setup`
 * functions.
 *
 * After running the function, copy or capture the output into a file named `.env`
 * in the `src` folder of this repository.
 *
 * Note that you can replace or add to the auto-generated keys.
 *
 * The following commands create a user-readable-only `.env` file. Never display,
 * share, or commit its contents; `DEV_KEYS` contains root private keys.
 *
 * ```bash
 * umask 077
 * npx tsx makeEnv > .env
 * ```
 *
 * @publicbody
 */
export function makeEnv(): void {
  process.stdout.write(Setup.makeEnv())
}

if (require.main === module) void runArgv2Function(module.exports)
