export interface WatchdogStats {
  lastCheckTime: Date;
  conversationsChecked: number;
  conversationsCanceled: number;
  errors: number;
}