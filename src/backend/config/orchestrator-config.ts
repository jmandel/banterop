export interface OrchestratorConfig {
  resurrectionLookbackHours: number;
  // Add other config options here as needed
}

export class OrchestratorConfigLoader {
  private static readonly DEFAULTS: OrchestratorConfig = {
    resurrectionLookbackHours: 24
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
    
    return config;
  }
}