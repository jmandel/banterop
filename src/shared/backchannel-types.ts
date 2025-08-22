export type ServerEvent =
  | { type: 'subscribe'; pairId: string; epoch: number; taskId: string; turn: 'a' | 'b' }
  | { type: 'unsubscribe'; pairId: string; epoch: number; reason?: string }
  | { type: 'redirect'; newPair: { pairId: string; aJoinUrl: string; bJoinUrl: string } };
