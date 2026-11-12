import { parseActionLabelPermission } from '../utility/actionLabelPermission'
describe('DPACP action-label presentation', () => {
  it('distinguishes legacy broad grants from reserved operation-specific scopes', () => {
    expect(parseActionLabelPermission(1, 'action label apply Poker')).toMatchObject({
      label: 'apply Poker',
      operation: 'both'
    })
    expect(parseActionLabelPermission(1, 'admin label apply Poker')).toMatchObject({
      label: 'Poker',
      operation: 'apply',
      metadataProtocol: 'action label Poker'
    })
    expect(parseActionLabelPermission(1, 'admin label list Poker')).toMatchObject({ label: 'Poker', operation: 'list' })
    expect(parseActionLabelPermission(2, 'action label Poker')).toBeNull()
    expect(parseActionLabelPermission(1, 'action label ')).toBeNull()
    expect(parseActionLabelPermission(1, 'unrelated feature')).toBeNull()
  })
})
