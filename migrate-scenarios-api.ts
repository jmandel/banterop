#!/usr/bin/env bun

// Configuration
const SOURCE_API_URL = process.env.SOURCE_API_URL || 'https://chitchat.fhir.me';
const TARGET_API_URL = process.env.TARGET_API_URL || 'https://banterop.fhir.me';
const DRY_RUN = process.env.DRY_RUN === 'true';
const STRIP_PUBLISHED = process.env.STRIP_PUBLISHED !== 'false'; // Default true

interface ScenarioListItem {
  id: string;
  name: string;
  config: any;
}

interface ScenarioConfig {
  metadata?: {
    id?: string;
    title?: string;
    tags?: string[];
    [key: string]: any;
  };
  [key: string]: any;
}

async function fetchScenarios(apiUrl: string): Promise<ScenarioConfig[]> {
  console.log(`📥 Fetching scenarios from ${apiUrl}/api/scenarios...`);
  
  const response = await fetch(`${apiUrl}/api/scenarios`);
  if (!response.ok) {
    throw new Error(`Failed to fetch scenarios: ${response.status} ${response.statusText}`);
  }
  
  const data = await response.json();
  
  // Handle both formats: array of configs or array of {id, name, config}
  if (Array.isArray(data)) {
    // If first item has a 'config' property, extract configs
    if (data.length > 0 && data[0].config) {
      return data.map(item => item.config);
    }
    // Otherwise assume it's already an array of configs
    return data;
  }
  
  throw new Error('Unexpected response format from API');
}

async function scenarioExists(apiUrl: string, scenarioId: string): Promise<boolean> {
  try {
    const response = await fetch(`${apiUrl}/api/scenarios/${scenarioId}`);
    return response.ok;
  } catch {
    return false;
  }
}

async function postScenario(apiUrl: string, config: ScenarioConfig): Promise<{ success: boolean; error?: string }> {
  // The API expects the config wrapped in a "config" property
  const payload = { config };
  
  const response = await fetch(`${apiUrl}/api/scenarios`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (response.ok) {
    return { success: true };
  } else {
    const errorText = await response.text();
    return { success: false, error: `${response.status} ${response.statusText}: ${errorText}` };
  }
}

async function main() {
  console.log('🚀 Starting API-to-API scenario migration...');
  console.log(`📂 Source API: ${SOURCE_API_URL}`);
  console.log(`🎯 Target API: ${TARGET_API_URL}`);
  console.log(`🔧 Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log(`✂️  Strip published tags: ${STRIP_PUBLISHED}\n`);

  try {
    // Fetch scenarios from source API
    const scenarios = await fetchScenarios(SOURCE_API_URL);
    console.log(`📊 Found ${scenarios.length} scenarios to migrate\n`);

    let successCount = 0;
    let skipCount = 0;
    let errorCount = 0;

    for (const scenario of scenarios) {
      const scenarioId = scenario.metadata?.id || 'unknown';
      const scenarioTitle = scenario.metadata?.title || scenario.metadata?.name || 'Untitled';
      
      console.log(`\n📝 Processing: ${scenarioTitle} (${scenarioId})`);
      
      try {
        // Make a copy to avoid modifying the original
        const configCopy = JSON.parse(JSON.stringify(scenario));
        
        // Strip "published" tag if requested
        if (STRIP_PUBLISHED && configCopy.metadata?.tags && Array.isArray(configCopy.metadata.tags)) {
          const originalTags = [...configCopy.metadata.tags];
          configCopy.metadata.tags = configCopy.metadata.tags.filter((tag: string) => tag !== 'published');
          if (originalTags.length !== configCopy.metadata.tags.length) {
            console.log('   ✂️  Removed "published" tag');
          }
        }

        // Check if scenario already exists at target
        const exists = await scenarioExists(TARGET_API_URL, scenarioId);
        if (exists) {
          console.log('   ⚠️  Scenario already exists at target, skipping...');
          skipCount++;
          continue;
        }

        if (DRY_RUN) {
          console.log('   🔍 DRY RUN - Would POST scenario:');
          console.log(`      ID: ${scenarioId}`);
          console.log(`      Title: ${scenarioTitle}`);
          console.log(`      Tags: ${configCopy.metadata?.tags?.join(', ') || 'none'}`);
          if (configCopy.agents?.length) {
            console.log(`      Agents: ${configCopy.agents.length}`);
          }
          successCount++;
        } else {
          // POST the scenario to the target API
          const result = await postScenario(TARGET_API_URL, configCopy);
          
          if (result.success) {
            console.log(`   ✅ Successfully migrated: ${scenarioId}`);
            successCount++;
          } else {
            console.error(`   ❌ Failed to migrate: ${result.error}`);
            errorCount++;
          }
        }
      } catch (error) {
        console.error(`   ❌ Error processing scenario: ${error}`);
        errorCount++;
      }
    }

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('📈 Migration Summary:');
    console.log(`   ✅ Successful: ${successCount}`);
    console.log(`   ⚠️  Skipped (already exists): ${skipCount}`);
    console.log(`   ❌ Errors: ${errorCount}`);
    console.log(`   📊 Total processed: ${scenarios.length}`);
    
    if (DRY_RUN) {
      console.log('\n⚠️  This was a DRY RUN. No changes were made.');
      console.log('To perform the actual migration, run without DRY_RUN=true');
    }

  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

// Run the migration
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});