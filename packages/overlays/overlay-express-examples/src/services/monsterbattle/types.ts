export interface MonsterBattleRecord {
  txid: string
  outputIndex: number
  createdAt: Date
}

export interface UTXOReference {
  txid: string
  outputIndex: number
}