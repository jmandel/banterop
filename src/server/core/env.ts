export type Env = { PORT?: string; BASE_URL: string; FLIPPROXY_DB?: string; AGENT_CARD_TEMPLATE?: string }
export function loadEnv(): Env {
  const port = process.env.PORT || '3000'
  return {
    PORT: port,
    BASE_URL: process.env.BASE_URL ?? `http://localhost:${port}`,
    FLIPPROXY_DB: process.env.FLIPPROXY_DB,
    AGENT_CARD_TEMPLATE: process.env.AGENT_CARD_TEMPLATE,
  }
}
