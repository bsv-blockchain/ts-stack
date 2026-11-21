module.exports = {
  // Bind stable intrinsics from this Jest realm, preserving prototypes and spies.
  // Replaceable clocks, fetch, WebAssembly, typed arrays and Buffer stay dynamic.
  sandboxInjectedGlobals: ['Math', 'String', 'Number', 'Object', 'Array', 'Reflect']
}
