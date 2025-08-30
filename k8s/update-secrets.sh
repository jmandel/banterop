#!/bin/bash

# Interactive secret updater for Kubernetes secrets
# This script prompts for API keys and updates the secret securely

echo "==================================="
echo "Kubernetes Secret Updater"
echo "Namespace: banterop"
echo "Secret: app-secrets"
echo "==================================="
echo

# Check if kubectl is available and can connect
if ! kubectl cluster-info &>/dev/null; then
    echo "Error: Cannot connect to Kubernetes cluster. Check your kubeconfig."
    exit 1
fi

# Check if secret exists
if ! kubectl -n banterop get secret app-secrets &>/dev/null; then
    echo "Warning: Secret 'app-secrets' does not exist in namespace 'banterop'"
    echo "Creating new secret..."
    kubectl -n banterop create secret generic app-secrets \
        --from-literal=OPENROUTER_API_KEY="" \
        --from-literal=GOOGLE_API_KEY="" \
        --from-literal=PUBLISHED_EDIT_TOKEN=""
fi

# Function to safely read password-like input
read_secret() {
    local prompt="$1"
    local var_name="$2"
    
    echo -n "$prompt"
    read -s -r "$var_name"
    echo  # New line after hidden input
}

# Prompt for OpenRouter API Key
echo "OpenRouter API Key Configuration"
echo "--------------------------------"
echo "Leave empty to skip, or enter '-' to explicitly clear"
echo
read_secret "Enter OpenRouter API Key (hidden): " OPENROUTER_KEY

# Prompt for Google API Key
echo
echo "Google API Key Configuration"
echo "----------------------------"
echo "Leave empty to skip, or enter '-' to explicitly clear"
echo
read_secret "Enter Google API Key (hidden): " GOOGLE_KEY

# Prompt for Published Edit Token
echo
echo "Published Edit Token"
echo "---------------------"
echo "Leave empty to skip, or enter '-' to explicitly clear"
echo
read_secret "Enter PUBLISHED_EDIT_TOKEN (hidden): " EDIT_TOKEN

# Build the patch JSON
echo
echo "Updating secrets..."

PATCH_JSON="{"

# Handle OpenRouter key
if [ -n "$OPENROUTER_KEY" ]; then
    if [ "$OPENROUTER_KEY" = "-" ]; then
        echo "  - Clearing OpenRouter API Key"
        OPENROUTER_B64=$(echo -n "" | base64 | tr -d '\n')
    else
        echo "  - Setting OpenRouter API Key (${#OPENROUTER_KEY} characters)"
        OPENROUTER_B64=$(echo -n "$OPENROUTER_KEY" | base64 | tr -d '\n')
    fi
    PATCH_JSON="${PATCH_JSON}\"data\":{\"OPENROUTER_API_KEY\":\"$OPENROUTER_B64\""
    PATCH_NEEDED=true
else
    echo "  - Skipping OpenRouter API Key (no change)"
fi

# Handle Gemini key
if [ -n "$GOOGLE_KEY" ]; then
    if [ "$GOOGLE_KEY" = "-" ]; then
        echo "  - Clearing Google API Key"
        GOOGLE_B64=$(echo -n "" | base64 | tr -d '\n')
    else
        echo "  - Setting Google API Key (${#GOOGLE_KEY} characters)"
        GOOGLE_B64=$(echo -n "$GOOGLE_KEY" | base64 | tr -d '\n')
    fi
    
    if [ -n "$PATCH_NEEDED" ]; then
        PATCH_JSON="${PATCH_JSON},\"GOOGLE_API_KEY\":\"$GOOGLE_B64\""
    else
        PATCH_JSON="${PATCH_JSON}\"data\":{\"GOOGLE_API_KEY\":\"$GOOGLE_B64\""
        PATCH_NEEDED=true
    fi
else
    echo "  - Skipping Google API Key (no change)"
fi

# Handle Published Edit Token
if [ -n "$EDIT_TOKEN" ]; then
    if [ "$EDIT_TOKEN" = "-" ]; then
        echo "  - Clearing PUBLISHED_EDIT_TOKEN"
        EDIT_B64=$(echo -n "" | base64 | tr -d '\n')
    else
        echo "  - Setting PUBLISHED_EDIT_TOKEN (${#EDIT_TOKEN} characters)"
        EDIT_B64=$(echo -n "$EDIT_TOKEN" | base64 | tr -d '\n')
    fi

    if [ -n "$PATCH_NEEDED" ]; then
        PATCH_JSON="${PATCH_JSON},\"PUBLISHED_EDIT_TOKEN\":\"$EDIT_B64\""
    else
        PATCH_JSON="${PATCH_JSON}\"data\":{\"PUBLISHED_EDIT_TOKEN\":\"$EDIT_B64\""
        PATCH_NEEDED=true
    fi
else
    echo "  - Skipping PUBLISHED_EDIT_TOKEN (no change)"
fi

# Apply the patch if needed
if [ -n "$PATCH_NEEDED" ]; then
    PATCH_JSON="${PATCH_JSON}}}"
    
    # Debug: show the patch command (without the actual secret values)
    echo "  - Applying patch..."
    
    # Try the patch and capture error
    if ERROR=$(kubectl -n banterop patch secret app-secrets -p "$PATCH_JSON" 2>&1); then
        echo
        echo "✓ Secret updated successfully!"
    else
        echo
        echo "✗ Failed to update secret"
        echo "Error: $ERROR"
        echo
        echo "Trying alternative method..."
        
        # Alternative: recreate the secret
        echo "Recreating secret with new values..."
        
        # Build kubectl create command
        CMD="kubectl -n banterop create secret generic app-secrets"
        
        if [ -n "$OPENROUTER_KEY" ] && [ "$OPENROUTER_KEY" != "-" ]; then
            CMD="$CMD --from-literal=OPENROUTER_API_KEY='$OPENROUTER_KEY'"
        else
            CMD="$CMD --from-literal=OPENROUTER_API_KEY=''"
        fi
        
        if [ -n "$GOOGLE_KEY" ] && [ "$GOOGLE_KEY" != "-" ]; then
            CMD="$CMD --from-literal=GOOGLE_API_KEY='$GOOGLE_KEY'"
        else
            CMD="$CMD --from-literal=GOOGLE_API_KEY=''"
        fi
        if [ -n "$EDIT_TOKEN" ] && [ "$EDIT_TOKEN" != "-" ]; then
            CMD="$CMD --from-literal=PUBLISHED_EDIT_TOKEN='$EDIT_TOKEN'"
        else
            CMD="$CMD --from-literal=PUBLISHED_EDIT_TOKEN=''"
        fi
        
        CMD="$CMD --dry-run=client -o yaml"
        
        if eval "$CMD" | kubectl apply -f -; then
            echo "✓ Secret updated successfully using apply method!"
        else
            echo "✗ Failed to update secret with both methods"
            exit 1
        fi
    fi
else
    echo
    echo "No changes to apply."
fi

# Clear sensitive variables
unset OPENROUTER_KEY GOOGLE_KEY EDIT_TOKEN OPENROUTER_B64 GOOGLE_B64 EDIT_B64 PATCH_JSON

# Verify the secret
echo
echo "==================================="
echo "Verification"
echo "==================================="
echo -n "OpenRouter API Key: "
OR_LEN=$(kubectl -n banterop get secret app-secrets -o jsonpath='{.data.OPENROUTER_API_KEY}' 2>/dev/null | base64 -d 2>/dev/null | wc -c)
if [ "$OR_LEN" -gt 0 ]; then
    echo "✓ Set ($OR_LEN bytes)"
else
    echo "✗ Not set (0 bytes)"
fi

echo -n "Google API Key:     "
GOOGLE_LEN=$(kubectl -n banterop get secret app-secrets -o jsonpath='{.data.GOOGLE_API_KEY}' 2>/dev/null | base64 -d 2>/dev/null | wc -c)
if [ "$GOOGLE_LEN" -gt 0 ]; then
    echo "✓ Set ($GOOGLE_LEN bytes)"
else
    echo "✗ Not set (0 bytes)"
fi

echo -n "PUBLISHED_EDIT_TOKEN: "
ED_LEN=$(kubectl -n banterop get secret app-secrets -o jsonpath='{.data.PUBLISHED_EDIT_TOKEN}' 2>/dev/null | base64 -d 2>/dev/null | wc -c)
if [ "$ED_LEN" -gt 0 ]; then
    echo "✓ Set ($ED_LEN bytes)"
else
    echo "✗ Not set (0 bytes)"
fi

echo
echo "==================================="
echo "Next Steps"
echo "==================================="
echo "1. Apply the deployment if needed:"
echo "   kubectl apply -f k8s/app-with-debug.yaml"
echo
echo "2. Restart the deployment to pick up changes:"
echo "   kubectl -n banterop rollout restart deployment/banterop-api"
echo
echo "3. Check status:"
echo "   kubectl -n banterop rollout status deployment/banterop-api"
