module.exports = {
  // Avoid slow VM global lookups while retaining the original full suite and deadlines.
  sandboxInjectedGlobals: ['Math']
}
