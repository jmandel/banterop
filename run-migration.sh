#!/bin/bash

echo "🔄 Scenario Migration Tool"
echo "========================="
echo ""
echo "This script migrates scenarios from the old database to the new Banterop API."
echo ""
echo "Options:"
echo "  1) Dry run against production (banterop.fhir.me)"
echo "  2) Live migration to production (banterop.fhir.me)"
echo "  3) Dry run against localhost:3000"
echo "  4) Live migration to localhost:3000"
echo "  5) Custom URL (dry run)"
echo "  6) Custom URL (live)"
echo ""
read -p "Select option (1-6): " choice

case $choice in
    1)
        echo "Running DRY RUN against production..."
        DRY_RUN=true API_URL=https://banterop.fhir.me bun run migrate-scenarios.ts
        ;;
    2)
        echo "⚠️  WARNING: This will migrate scenarios to PRODUCTION!"
        read -p "Are you sure? (yes/no): " confirm
        if [ "$confirm" = "yes" ]; then
            API_URL=https://banterop.fhir.me bun run migrate-scenarios.ts
        else
            echo "Migration cancelled."
        fi
        ;;
    3)
        echo "Running DRY RUN against localhost..."
        DRY_RUN=true API_URL=http://localhost:3000 bun run migrate-scenarios.ts
        ;;
    4)
        echo "Running LIVE migration to localhost..."
        API_URL=http://localhost:3000 bun run migrate-scenarios.ts
        ;;
    5)
        read -p "Enter API URL: " custom_url
        echo "Running DRY RUN against $custom_url..."
        DRY_RUN=true API_URL="$custom_url" bun run migrate-scenarios.ts
        ;;
    6)
        read -p "Enter API URL: " custom_url
        echo "⚠️  WARNING: This will migrate scenarios to $custom_url!"
        read -p "Are you sure? (yes/no): " confirm
        if [ "$confirm" = "yes" ]; then
            API_URL="$custom_url" bun run migrate-scenarios.ts
        else
            echo "Migration cancelled."
        fi
        ;;
    *)
        echo "Invalid option"
        exit 1
        ;;
esac