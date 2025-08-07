export interface OrchestratorConfig {
  resurrectionLookbackHours: number;
  bridgeReplyTimeoutMs: number;
  // Add other config options here as needed
}

export class OrchestratorConfigLoader {
  private static readonly DEFAULTS: OrchestratorConfig = {
    resurrectionLookbackHours: 24,
    bridgeReplyTimeoutMs: 5000 // 5 seconds default (for testing)
  };

  /**
   * Load configuration with proper layering:
   * 1. Start with defaults
   * 2. Layer on environment variables (highest precedence)
   */
  static load(): OrchestratorConfig {
    // Start with defaults
    const config: OrchestratorConfig = { ...this.DEFAULTS };

    // Layer on environment variables
    if (process.env.RESURRECTION_LOOKBACK_HOURS) {
      const hours = parseInt(process.env.RESURRECTION_LOOKBACK_HOURS, 10);
      if (!isNaN(hours) && hours > 0) {
        config.resurrectionLookbackHours = hours;
        console.log(`[Config] Using RESURRECTION_LOOKBACK_HOURS from env: ${hours} hours`);
      } else {
        console.warn(`[Config] Invalid RESURRECTION_LOOKBACK_HOURS env value: ${process.env.RESURRECTION_LOOKBACK_HOURS}, using default: ${config.resurrectionLookbackHours}`);
      }
    } else {
      console.log(`[Config] Using default resurrection lookback: ${config.resurrectionLookbackHours} hours`);
    }

    // Load bridge reply timeout from environment
    if (process.env.BRIDGE_REPLY_TIMEOUT_MS) {
      const timeout = parseInt(process.env.BRIDGE_REPLY_TIMEOUT_MS, 10);
      if (!isNaN(timeout) && timeout > 0) {
        config.bridgeReplyTimeoutMs = timeout;
        console.log(`[Config] Using BRIDGE_REPLY_TIMEOUT_MS from env: ${timeout}ms`);
      } else {
        console.warn(`[Config] Invalid BRIDGE_REPLY_TIMEOUT_MS env value: ${process.env.BRIDGE_REPLY_TIMEOUT_MS}, using default: ${config.bridgeReplyTimeoutMs}`);
      }
    } else {
      console.log(`[Config] Using default bridge reply timeout: ${config.bridgeReplyTimeoutMs}ms`);
    }

    return config;
  }

  /**
   * Create a config object from partial input, applying defaults and env vars
   */
  static fromPartial(partial?: Partial<OrchestratorConfig>): OrchestratorConfig {
    // Start with defaults
    const config = { ...this.DEFAULTS, ...partial };
    
    // Layer on environment variables (they override partial config)
    if (process.env.RESURRECTION_LOOKBACK_HOURS) {
      const hours = parseInt(process.env.RESURRECTION_LOOKBACK_HOURS, 10);
      if (!isNaN(hours) && hours > 0) {
        config.resurrectionLookbackHours = hours;
      }
    }
    
    if (process.env.BRIDGE_REPLY_TIMEOUT_MS) {
      const timeout = parseInt(process.env.BRIDGE_REPLY_TIMEOUT_MS, 10);
      if (!isNaN(timeout) && timeout > 0) {
        config.bridgeReplyTimeoutMs = timeout;
      }
    }
    
    return config;
  }
}