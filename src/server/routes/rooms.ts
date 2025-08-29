import { Hono } from 'hono'
import type { AppBindings } from '../index'

export function createRoomsRoutes() {
  const app = new Hono<AppBindings>()

  // Agent card is now served from /api/rooms/:roomId/.well-known/agent-card.json (see a2a.ts)
  // This route file handles room UI and other room-specific endpoints

  return app
}
