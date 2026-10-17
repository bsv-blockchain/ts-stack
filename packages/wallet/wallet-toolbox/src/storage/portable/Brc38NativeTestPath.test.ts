import { nativeTestExecutable } from './Brc38NativeTestPath'

// Configuration DATA only; genuine native suites separately open the exact pin.
test.each(['/private/native-contract', '/tmp/qualification/native-contract'])(
  'native test executable accepts the explicit absolute fixture path %s',
  filename => {
    expect(nativeTestExecutable(filename)).toBe(filename)
  }
)

test.each(['', 'native-contract', './native-contract', '/tmp/../native-contract', '/tmp/native\0contract'])(
  'native test executable refuses an ambiguous fixture path %p',
  filename => {
    expect(() => nativeTestExecutable(filename)).toThrow('normalized absolute path')
  }
)
