#!/bin/bash

echo "🔄 API-to-API Scenario Migration Tool"
echo "====================================="
echo ""
echo "This script migrates scenarios from one API to another."
echo "Default source: https://chitchat.fhir.me"
echo "Default target: https://banterop.fhir.me"
echo ""
echo "Options:"
echo "  1) Dry run: chitchat.fhir.me → banterop.fhir.me"
echo "  2) LIVE: chitchat.fhir.me → banterop.fhir.me"
echo "  3) Dry run: chitchat.fhir.me → localhost:3000"
echo "  4) LIVE: chitchat.fhir.me → localhost:3000"
echo "  5) Custom source and target (dry run)"
echo "  6) Custom source and target (LIVE)"
echo ""
read -p "Select option (1-6): " choice

case $choice in
    1)
        echo "Running DRY RUN: chitchat → banterop..."
        DRY_RUN=true bun run migrate-scenarios-api.ts
        ;;
    2)
        echo "⚠️  WARNING: This will migrate scenarios from chitchat to banterop PRODUCTION!"
        read -p "Are you sure? (yes/no): " confirm
        if [ "$confirm" = "yes" ]; then
            bun run migrate-scenarios-api.ts
        else
            echo "Migration cancelled."
        fi
        ;;
    3)
        echo "Running DRY RUN: chitchat → localhost..."
        DRY_RUN=true TARGET_API_URL=http://localhost:3000 bun run migrate-scenarios-api.ts
        ;;
    4)
        echo "Running LIVE: chitchat → localhost..."
        TARGET_API_URL=http://localhost:3000 bun run migrate-scenarios-api.ts
        ;;
    5)
        read -p "Enter source API URL (e.g., https://chitchat.fhir.me): " source_url
        read -p "Enter target API URL (e.g., https://banterop.fhir.me): " target_url
        read -p "Strip 'published' tags? (yes/no, default yes): " strip
        
        STRIP_VAL="true"
        if [ "$strip" = "no" ]; then
            STRIP_VAL="false"
        fi
        
        echo "Running DRY RUN: $source_url → $target_url..."
        DRY_RUN=true SOURCE_API_URL="$source_url" TARGET_API_URL="$target_url" STRIP_PUBLISHED="$STRIP_VAL" bun run migrate-scenarios-api.ts
        ;;
    6)
        read -p "Enter source API URL (e.g., https://chitchat.fhir.me): " source_url
        read -p "Enter target API URL (e.g., https://banterop.fhir.me): " target_url
        read -p "Strip 'published' tags? (yes/no, default yes): " strip
        
        STRIP_VAL="true"
        if [ "$strip" = "no" ]; then
            STRIP_VAL="false"
        fi
        
        echo "⚠️  WARNING: This will migrate scenarios from $source_url to $target_url!"
        read -p "Are you sure? (yes/no): " confirm
        if [ "$confirm" = "yes" ]; then
            SOURCE_API_URL="$source_url" TARGET_API_URL="$target_url" STRIP_PUBLISHED="$STRIP_VAL" bun run migrate-scenarios-api.ts
        else
            echo "Migration cancelled."
        fi
        ;;
    *)
        echo "Invalid option"
        exit 1
        ;;
esac