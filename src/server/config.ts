import { z } from 'zod';

// Configuration schema with validation
const ConfigSchema = z.object({
  // Database
  dbPath: z.string().default('data.db'),
  
  // Server
  port: z.number().int().positive().default(3000),
  
  // Orchestrator
  idleTurnMs: z.number().int().positive().default(120_000),
  emitNextCandidates: z.boolean().default(true),
  
  // LLM Providers
  googleApiKey: z.string().optional(),
  openRouterApiKey: z.string().optional(),
  defaultLlmProvider: z.enum(['google', 'openrouter', 'mock']).default('mock'),
  
  // Logging
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  
  // Environment
  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),
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
      emitNextCandidates: process.env.EMIT_NEXT_CANDIDATES === 'false' ? false : undefined,
      
      // LLM Providers
      googleApiKey: process.env.GOOGLE_API_KEY,
      openRouterApiKey: process.env.OPENROUTER_API_KEY,
      defaultLlmProvider: process.env.DEFAULT_LLM_PROVIDER as Config['defaultLlmProvider'],
      
      // Logging
      logLevel: process.env.LOG_LEVEL as Config['logLevel'],
      
      // Environment
      nodeEnv: process.env.NODE_ENV as Config['nodeEnv'],
      
      // Apply overrides
      ...overrides,
    };
    
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
      emitNextCandidates: this.config.emitNextCandidates,
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
      emitNextCandidates: false, // Disable workers in tests
    });
  }
}