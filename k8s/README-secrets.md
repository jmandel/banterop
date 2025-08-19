# Managing Kubernetes Secrets

## Current Secret Status
Your secret `app-secrets` exists but has empty values (0 bytes) for the API keys.

## Quick Way to Set OpenRouter API Key

```bash
# Replace 'sk-or-v1-xxxxx' with your actual OpenRouter API key
kubectl -n interop create secret generic app-secrets \
  --from-literal=OPENROUTER_API_KEY='sk-or-v1-xxxxx' \
  --from-literal=GEMINI_API_KEY='' \
  --from-literal=PUBLISHED_EDIT_TOKEN='your-shared-edit-token' \
  --dry-run=client -o yaml | kubectl apply -f -
```

## Setting Individual Keys Without Recreating

```bash
# Just update OpenRouter key (base64 encode first)
echo -n 'your-openrouter-key-here' | base64
# Copy the output, then:
kubectl -n interop edit secret app-secrets
# Find OPENROUTER_API_KEY and replace the value with your base64 string
```

## Using kubectl patch (recommended for automation)

```bash
# Set your key in a variable
OPENROUTER_KEY="sk-or-v1-your-actual-key-here"

# Patch the secret (OpenRouter)
kubectl -n interop patch secret app-secrets -p '{"data":{"OPENROUTER_API_KEY":"'$(echo -n $OPENROUTER_KEY | base64)'"}}'

# Patch the secret (Published Edit Token)
EDIT_TOKEN="my-shared-token"
kubectl -n interop patch secret app-secrets -p '{"data":{"PUBLISHED_EDIT_TOKEN":"'$(echo -n $EDIT_TOKEN | base64)'"}}'
```

## Verify Secret is Set

```bash
# Check byte count (should be > 0)
kubectl -n interop describe secret app-secrets

# Decode and check (BE CAREFUL - this shows the actual key!)
kubectl -n interop get secret app-secrets -o jsonpath='{.data.OPENROUTER_API_KEY}' | base64 -d

# Check edit token (optional)
kubectl -n interop get secret app-secrets -o jsonpath='{.data.PUBLISHED_EDIT_TOKEN}' | base64 -d
```

## Apply the Updated Deployment

After setting the secrets:

```bash
# Apply the debug-enabled configuration
kubectl apply -f k8s/app-with-debug.yaml

# Restart the deployment to pick up secret changes
kubectl -n interop rollout restart deployment/interop-api

# Watch the rollout
kubectl -n interop rollout status deployment/interop-api
```

## Check Debug Logs

Once running with debug enabled:

```bash
# Get pod name
POD=$(kubectl -n interop get pods -l app=interop-api -o jsonpath='{.items[0].metadata.name}')

# Check if debug directory is created
kubectl -n interop exec $POD -- ls -la /debug/

# Tail debug logs (once they exist)
kubectl -n interop exec $POD -- tail -f /debug/llm-debug/requests.log
```

## Security Notes

1. **Never commit secrets to git** - Always use `.gitignore` for any files containing actual keys
2. **Use separate secrets per environment** - Don't share production keys with dev/staging
3. **Rotate keys regularly** - Update secrets periodically
4. **Use RBAC** - Limit who can read secrets in the namespace

## Alternative: Using Sealed Secrets (for GitOps)

If you want to store encrypted secrets in Git:

```bash
# Install sealed-secrets controller first
# Then create a sealed secret:
echo -n 'your-key' | kubectl create secret generic app-secrets \
  --dry-run=client --from-file=OPENROUTER_API_KEY=/dev/stdin -o yaml | \
  kubeseal -o yaml > sealed-secret.yaml

# Commit sealed-secret.yaml to Git (it's encrypted)
```
