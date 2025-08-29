#!/bin/bash

# A2A Protocol Validation Tools - Setup Script

set -e

echo "==============================================="
echo "A2A Protocol Validation Tools - Setup"
echo "==============================================="

# Check for uv
if ! command -v uv &> /dev/null; then
    echo "❌ uv is not installed"
    echo ""
    echo "Please install uv first:"
    echo "  curl -LsSf https://astral.sh/uv/install.sh | sh"
    echo ""
    echo "Or via pip:"
    echo "  pip install uv"
    exit 1
fi

echo "✅ uv found: $(which uv)"

# Create virtual environment if it doesn't exist
if [ ! -d ".venv" ]; then
    echo ""
    echo "Creating virtual environment..."
    uv venv
    echo "✅ Virtual environment created"
else
    echo "✅ Virtual environment already exists"
fi

# Activate virtual environment
echo ""
echo "Activating virtual environment..."
source .venv/bin/activate

# Install dependencies
echo ""
echo "Installing dependencies..."
uv pip install a2a-sdk httpx

echo ""
echo "==============================================="
echo "✅ Setup complete!"
echo "==============================================="
echo ""
echo "To use the tools:"
echo "  1. Activate the environment: source .venv/bin/activate"
echo "  2. Run the interactive client: ./run_client.sh"
echo "  3. Or validate an agent card: python validate_a2a_card.py <url>"
echo ""