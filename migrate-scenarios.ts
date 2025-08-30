#!/usr/bin/env bun

import { Database } from 'bun:sqlite';

// Configuration
const OLD_DB_PATH = '/home/jmandel/hobby/language-track/v3/k8s/data/data.db';
const API_BASE_URL = process.env.API_URL || 'https://banterop.fhir.me';
const DRY_RUN = process.env.DRY_RUN === 'true';

interface OldScenario {
  id: string;
  name: string;
  config: string;
  created_at: string;
  modified_at: string;
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

async function main() {
  console.log('🚀 Starting scenario migration...');
  console.log(`📂 Source DB: ${OLD_DB_PATH}`);
  console.log(`🎯 Target API: ${API_BASE_URL}`);
  console.log(`🔧 Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}\n`);

  // Open the old database
  const oldDb = new Database(OLD_DB_PATH, { readonly: true });
  
  try {
    // Fetch all scenarios from old database
    const scenarios = oldDb.query<OldScenario, []>(`
      SELECT id, name, config, created_at, modified_at 
      FROM scenarios 
      ORDER BY created_at
    `).all();

    console.log(`📊 Found ${scenarios.length} scenarios to migrate\n`);

    let successCount = 0;
    let skipCount = 0;
    let errorCount = 0;

    for (const scenario of scenarios) {
      console.log(`\n📝 Processing: ${scenario.name} (${scenario.id})`);
      
      try {
        // Parse the config JSON
        const config: ScenarioConfig = JSON.parse(scenario.config);
        
        // Strip "published" tag if it exists
        if (config.metadata?.tags && Array.isArray(config.metadata.tags)) {
          const originalTags = [...config.metadata.tags];
          config.metadata.tags = config.metadata.tags.filter(tag => tag !== 'published');
          if (originalTags.length !== config.metadata.tags.length) {
            console.log('   ✂️  Removed "published" tag');
          }
        }

        // Check if scenario already exists
        const checkUrl = `${API_BASE_URL}/api/scenarios/${config.metadata?.id || scenario.id}`;
        const checkResponse = await fetch(checkUrl);
        
        if (checkResponse.ok) {
          console.log('   ⚠️  Scenario already exists, skipping...');
          skipCount++;
          continue;
        }

        if (DRY_RUN) {
          console.log('   🔍 DRY RUN - Would POST scenario:');
          console.log(`      ID: ${config.metadata?.id || scenario.id}`);
          console.log(`      Title: ${config.metadata?.title || scenario.name}`);
          console.log(`      Tags: ${config.metadata?.tags?.join(', ') || 'none'}`);
          successCount++;
        } else {
          // POST the scenario to the new API
          const response = await fetch(`${API_BASE_URL}/api/scenarios`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(config),
          });

          if (response.ok) {
            const result = await response.json();
            console.log(`   ✅ Successfully migrated: ${result.metadata?.id || scenario.id}`);
            successCount++;
          } else {
            const errorText = await response.text();
            console.error(`   ❌ Failed to migrate: ${response.status} ${response.statusText}`);
            console.error(`      Error: ${errorText}`);
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

  } finally {
    oldDb.close();
  }
}

// Run the migration
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});