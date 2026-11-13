import { isAbsolute, normalize } from 'node:path'

/** Test fixture configuration only. A pathname never bypasses the ordinary
 * native loader's exact build, platform, immutable-file or ownership checks. */
export function nativeTestExecutable(
  configured: string | undefined = process.env.TS_STACK_NATIVE_TEST_EXECUTABLE
): string {
  const filename = configured ?? '/work/native-contract'
  if (!isAbsolute(filename) || normalize(filename) !== filename || filename.includes('\0'))
    throw new Error('Native test executable must be a normalized absolute path')
  return filename
}
