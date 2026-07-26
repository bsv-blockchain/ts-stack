declare module 'mock-knex' {
  import { Knex } from 'knex'

  export interface Tracker {
    install: () => void
    uninstall: () => void
    on: (event: 'query', callback: (query: any, step: number) => void) => void
  }

  export interface MockKnex {
    mock: (db: Knex) => void
    unmock: (db: Knex) => void
    getTracker: () => Tracker
  }

  const mockKnex: MockKnex
  export default mockKnex
}
