import { z } from 'zod';

// Configuration schema with validation
const ConfigSchema = z.object({
  // Database
  dbPath: z.string().default('dbs/data.db'),
  
  // Server
  port: z.number().int().positive().default(3000),
  
  // Orchestrator
  idleTurnMs: z.number().int().positive().default(120_000),
  maxTurnsDefault: z.number().int().positive().default(40),
  
  // LLM Providers
  googleApiKey: z.string().optional(),
  openRouterApiKey: z.string().optional(),
  defaultLlmProvider: z.enum(['google', 'openrouter', 'mock']).default('mock'),
  defaultLlmModel: z.string().optional(), // e.g. 'gemini-2.5-flash'
  
  // Logging
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  
  // Environment
  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),
  
  // Watchdog
  watchdogEnabled: z.boolean().default(true),
  watchdogIntervalMs: z.number().int().positive().default(5 * 60 * 1000),
  watchdogStalledThresholdMs: z.number().int().positive().default(10 * 60 * 1000),
});

export type Config = z.infer<typeof ConfigSchema>;

export class ConfigManager {
  private config: Config;
  
  constructor(overrides?: Partial<Config>) {
    // Build config from environment variables and overrides
    const raw = {
      // Database
      dbPath: process.env.DB_PATH,
      
      // Server
      port: process.env.PORT ? Number(process.env.PORT) : undefined,
      
      // Orchestrator
      idleTurnMs: process.env.IDLE_TURN_MS ? Number(process.env.IDLE_TURN_MS) : undefined,
      maxTurnsDefault: process.env.MAX_TURNS_DEFAULT ? Number(process.env.MAX_TURNS_DEFAULT) : undefined,
      
      // LLM Providers
      googleApiKey: process.env.GEMINI_API_KEY,
      openRouterApiKey: process.env.OPENROUTER_API_KEY,
      defaultLlmProvider: process.env.DEFAULT_LLM_PROVIDER as Config['defaultLlmProvider'],
      defaultLlmModel: process.env.DEFAULT_LLM_MODEL,
      
      // Logging
      logLevel: process.env.LOG_LEVEL as Config['logLevel'],
      
      // Environment
      nodeEnv: process.env.NODE_ENV as Config['nodeEnv'],
      
      // Watchdog (only set if env var exists)
      watchdogEnabled: process.env.WATCHDOG_ENABLED ? process.env.WATCHDOG_ENABLED !== 'false' : undefined,
      watchdogIntervalMs: process.env.WATCHDOG_INTERVAL_MS ? Number(process.env.WATCHDOG_INTERVAL_MS) : undefined,
      watchdogStalledThresholdMs: process.env.WATCHDOG_STALLED_THRESHOLD_MS ? Number(process.env.WATCHDOG_STALLED_THRESHOLD_MS) : undefined,
      
      // Apply overrides
      ...overrides,
    };

    // In test environments, never use real API keys from env
    const effectiveNodeEnv = (overrides?.nodeEnv as string) ?? process.env.NODE_ENV;
    if (effectiveNodeEnv === 'test') {
      (raw as any).googleApiKey = undefined;
      (raw as any).openRouterApiKey = undefined;
    }
    
    // Filter out undefined values
    const filtered = Object.fromEntries(
      Object.entries(raw).filter(([_, v]) => v !== undefined)
    );
    
    // Parse and validate
    const result = ConfigSchema.safeParse(filtered);
    if (!result.success) {
      throw new Error(`Invalid configuration: ${result.error.message}`);
    }
    
    this.config = result.data;
  }
  
  get(): Config {
    return this.config;
  }
  
  // Convenience getters
  get dbPath(): string {
    return this.config.dbPath;
  }
  
  get port(): number {
    return this.config.port;
  }
  
  get orchestratorConfig() {
    return {
      idleTurnMs: this.config.idleTurnMs,
      maxTurnsDefault: this.config.maxTurnsDefault,
      // Disable heartbeat in tests to avoid timer/teardown races
      disableHeartbeat: this.config.nodeEnv === 'test',
    };
  }
  
  get isProduction(): boolean {
    return this.config.nodeEnv === 'production';
  }
  
  get isTest(): boolean {
    return this.config.nodeEnv === 'test';
  }
  
  get isDevelopment(): boolean {
    return this.config.nodeEnv === 'development';
  }
  
  // Get configuration for test environments
  static forTest(): ConfigManager {
    return new ConfigManager({
      dbPath: ':memory:',
      nodeEnv: 'test',
      logLevel: 'error',
      watchdogEnabled: false
    });
  }
}
