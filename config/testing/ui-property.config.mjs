export default {
  test: {
    environment: 'node',
    include: ['tests/property/*.property.test.mjs'],
    restoreMocks: true
  }
}
