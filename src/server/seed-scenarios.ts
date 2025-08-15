#!/usr/bin/env bun

/**
 * Seed script to pre-load scenarios into the database.
 * This ensures common scenarios are available for testing and demos.
 * 
 * Usage:
 *   bun run src/server/seed-scenarios.ts
 */

import { App } from './app';
import kneeMriScenario from '$src/db/fixtures/knee-mri-scenario.json';
import visionScreeningScenario from '$src/db/fixtures/vision-screening-scenario.json';

async function seedScenarios() {
  console.log('🌱 Seeding scenarios...\n');
  
  // Initialize app
  const app = new App({
    dbPath: process.env.DB_PATH || './data.db',
    defaultLlmProvider: 'google' as any,
  });

  const scenarios = [
    kneeMriScenario as any,
    visionScreeningScenario as any,
  ];

  let created = 0;
  let skipped = 0;

  for (const scenario of scenarios) {
    const id = scenario.metadata.id;
    const name = scenario.metadata.title;
    
    try {
      // Check if scenario already exists
      const existing = app.orchestrator.storage.scenarios.findScenarioById(id);
      
      if (existing) {
        console.log(`⏭️  Skipping existing scenario: ${id} - ${name}`);
        skipped++;
      } else {
        // Insert new scenario
        app.orchestrator.storage.scenarios.insertScenario({
          id,
          name,
          config: scenario,
          history: []
        });
        console.log(`✅ Created scenario: ${id} - ${name}`);
        created++;
      }
    } catch (error) {
      console.error(`❌ Error with scenario ${id}:`, error);
    }
  }

  console.log(`\n📊 Summary:`);
  console.log(`   Created: ${created} scenarios`);
  console.log(`   Skipped: ${skipped} scenarios (already exist)`);
  console.log(`   Total:   ${app.orchestrator.storage.scenarios.listScenarios().length} scenarios in database`);
  
  // List all scenarios
  console.log(`\n📋 All scenarios in database:`);
  const allScenarios = app.orchestrator.storage.scenarios.listScenarios();
  for (const scenario of allScenarios) {
    const tags = scenario.config?.metadata?.tags?.join(', ') || 'no tags';
    console.log(`   - ${scenario.id}: ${scenario.name} [${tags}]`);
  }

  // Clean shutdown
  await app.shutdown();
  console.log('\n✨ Done!');
}

// Run the seed script
seedScenarios().catch(err => {
  console.error('Seed script failed:', err);
  process.exit(1);
});
