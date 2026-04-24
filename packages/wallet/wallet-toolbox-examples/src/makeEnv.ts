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
 * The following command will run the function,
 * capture the output into a file named '.env',
 * and display the file's contents:
 *
 * ```bash
 * npx tsx makeEnv > .env; cat .env
 * ```
 *
 * @publicbody
 */
export function makeEnv() {
  Setup.makeEnv()
}

makeEnv()
