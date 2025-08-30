# Kubernetes Deployment for Banterop FlipProxy

This folder contains Kubernetes manifests and utilities to deploy the FlipProxy application to `banterop.fhir.me`.

## Quick Start

```bash
# Apply the deployment with debug logging enabled
kubectl apply -f k8s/app-with-debug.yaml

# Set secrets using the interactive script
./k8s/update-secrets.sh

# Restart to pick up secret changes  
kubectl -n banterop rollout restart deployment/banterop-api

# Check status
kubectl -n banterop rollout status deployment/banterop-api
```

## Configuration

### Namespace: `banterop`
- **Deployment**: `banterop-api`
- **Service**: `banterop-api` 
- **Domain**: `banterop.fhir.me`
- **TLS Secret**: `banterop-fhir-me-tls`
- **Database PVC**: `banterop-db`
- **Debug Logs PVC**: `debug-logs` (10GB, only in app-with-debug.yaml)

### Prerequisites
- Kubernetes cluster with:
  - nginx ingress controller (uses `spec.ingressClassName: nginx`)
  - cert-manager with `ClusterIssuer/letsencrypt-prod` configured
  - Default StorageClass for PVCs
- DNS A record: `banterop.fhir.me` → ingress external IP
- Docker image: `ghcr.io/jmandel/banterop:main` (built by GitHub Actions)

## Managing Secrets

Secrets are managed separately from the main deployment to avoid accidental resets. The `app-secrets` secret contains:
- `OPENROUTER_API_KEY` - OpenRouter AI Gateway API key
- `GOOGLE_API_KEY` - Google Gemini API key  
- `PUBLISHED_EDIT_TOKEN` - Optional token to protect published scenarios

### Interactive Secret Management (Recommended)

Use the provided script for secure, interactive secret updates:

```bash
# Prompts for all secrets, handles base64 encoding automatically
./k8s/update-secrets.sh

# Restart deployment to pick up changes
kubectl -n banterop rollout restart deployment/banterop-api
```

### Manual Secret Management

```bash
# Create/update all secrets at once
kubectl -n banterop create secret generic app-secrets \
  --from-literal=OPENROUTER_API_KEY='sk-or-v1-xxxxx' \
  --from-literal=GOOGLE_API_KEY='AIzaSyXXXXX' \
  --from-literal=PUBLISHED_EDIT_TOKEN='your-token' \
  --dry-run=client -o yaml | kubectl apply -f -
```

Update individual secrets:
```bash
# Set your key in a variable
OPENROUTER_KEY="sk-or-v1-your-key"

# Patch the secret
kubectl -n banterop patch secret app-secrets -p \
  '{"data":{"OPENROUTER_API_KEY":"'$(echo -n $OPENROUTER_KEY | base64)'"}}'
```

Verify secrets are set:
```bash
# Check byte counts (should be > 0)
kubectl -n banterop describe secret app-secrets

# Extract a specific key (BE CAREFUL - shows actual value!)
kubectl -n banterop get secret app-secrets -o jsonpath='{.data.OPENROUTER_API_KEY}' | base64 -d
```

## Published Edit Token

The `PUBLISHED_EDIT_TOKEN` provides a soft-lock for scenarios tagged as `published`. When set:
- Server returns `423 Locked` for PUT/DELETE on published scenarios without the token
- Clients must include `X-Edit-Token` header with the matching token
- The UI provides an "Unlock" flow that stores the token in localStorage

### Testing the Token

```bash
# Set the token
EDIT_TOKEN="my-shared-token"
kubectl -n banterop patch secret app-secrets -p \
  '{"data":{"PUBLISHED_EDIT_TOKEN":"'$(echo -n $EDIT_TOKEN | base64)'"}}'

kubectl -n banterop rollout restart deployment/banterop-api

# Test without token (expect 423)
curl -s -o /dev/null -w "%{http_code}\n" \
  -X PUT "https://banterop.fhir.me/api/scenarios/PUBLISHED_SCENARIO_ID" \
  -H 'Content-Type: application/json' \
  --data '{"name":"Test"}'

# Test with token (expect 200)  
curl -s -o /dev/null -w "%{http_code}\n" \
  -X PUT "https://banterop.fhir.me/api/scenarios/PUBLISHED_SCENARIO_ID" \
  -H 'Content-Type: application/json' \
  -H "X-Edit-Token: $EDIT_TOKEN" \
  --data '{"name":"Test"}'
```

## Database Management

### Download Database Backup

```bash
# Download SQLite database files from the pod
./k8s/get-app-db.sh

# Files are saved to ./data/
ls -lah data/banterop.db*
```

### Reset Database

#### Option A: Delete and Recreate PVCs

```bash
# Delete PVCs (this deletes all data)
kubectl -n banterop delete pvc banterop-db
kubectl -n banterop delete pvc debug-logs  # if using app-with-debug.yaml

# Recreate from manifest
kubectl apply -f k8s/app-with-debug.yaml

# Verify
kubectl -n banterop rollout status deploy/banterop-api
kubectl -n banterop get pvc
```

#### Option B: Wipe Files Inside PVCs

Keep the PVCs but clear the data:

```bash
# Wipe database files
kubectl apply -f - <<'EOF'
apiVersion: batch/v1
kind: Job
metadata:
  name: wipe-db
  namespace: banterop
spec:
  template:
    spec:
      restartPolicy: OnFailure
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: banterop-db
      containers:
        - name: wipe
          image: busybox:1.36
          command: ["/bin/sh","-c","rm -f /data/banterop.db /data/banterop.db-* && echo 'DB wiped'"]
          volumeMounts:
            - name: data
              mountPath: /data
  backoffLimit: 0
EOF

kubectl -n banterop wait --for=condition=complete job/wipe-db --timeout=60s
kubectl -n banterop delete job wipe-db

# Wipe debug logs (if using app-with-debug.yaml)
kubectl apply -f - <<'EOF'
apiVersion: batch/v1
kind: Job
metadata:
  name: wipe-debug
  namespace: banterop
spec:
  template:
    spec:
      restartPolicy: OnFailure
      volumes:
        - name: debug
          persistentVolumeClaim:
            claimName: debug-logs
      containers:
        - name: wipe
          image: busybox:1.36
          command: ["/bin/sh","-c","rm -rf /debug/* && echo 'Debug logs wiped'"]
          volumeMounts:
            - name: debug
              mountPath: /debug
  backoffLimit: 0
EOF

kubectl -n banterop wait --for=condition=complete job/wipe-debug --timeout=60s
kubectl -n banterop delete job wipe-debug
```

## Debug Logging

When using `app-with-debug.yaml`, LLM requests/responses are logged to `/debug/llm-debug/`:

```bash
# Get pod name
POD=$(kubectl -n banterop get pods -l app=banterop-api -o jsonpath='{.items[0].metadata.name}')

# Check debug directory
kubectl -n banterop exec $POD -- ls -la /debug/llm-debug/

# Tail logs
kubectl -n banterop exec $POD -- tail -f /debug/llm-debug/requests.log

# The logs are also accessible via the public URL (when PUBLISH_LLM_DEBUG_LOGS_OPENLY=true)
curl https://banterop.fhir.me/debug-logs/
```

## OpenRouter Configuration

Configure provider routing via environment variable:

```bash
# Examples of OPENROUTER_PROVIDER_CONFIG settings:

# Default (throughput optimized)
kubectl -n banterop set env deploy/banterop-api \
  OPENROUTER_PROVIDER_CONFIG='{"ignore":["baseten"],"sort":"throughput","allow_fallbacks":true}'

# Price optimized
kubectl -n banterop set env deploy/banterop-api \
  OPENROUTER_PROVIDER_CONFIG='{"sort":"price","max_price":{"input":1.0,"output":2.0}}'

# Specific providers only
kubectl -n banterop set env deploy/banterop-api \
  OPENROUTER_PROVIDER_CONFIG='{"only":["openai","anthropic"]}'

# Privacy focused
kubectl -n banterop set env deploy/banterop-api \
  OPENROUTER_PROVIDER_CONFIG='{"data_collection":"deny","ignore":["baseten"]}'
```

## CI/CD Integration

The GitHub Actions workflow builds and pushes Docker images on push to main or v4 branches:

```yaml
# .github/workflows/build-and-push.yml
- Builds image: ghcr.io/jmandel/banterop:main
- Also tags: ghcr.io/jmandel/banterop:latest
- On v4 branch: ghcr.io/jmandel/banterop:v4
```

To deploy a new version:
```bash
# After GitHub Actions builds the new image
kubectl -n banterop set image deployment/banterop-api api=ghcr.io/jmandel/banterop:main

# Or force a pull of :main tag
kubectl -n banterop rollout restart deployment/banterop-api
```

## Troubleshooting

### Check pod status
```bash
kubectl -n banterop get pods
kubectl -n banterop describe pod <pod-name>
kubectl -n banterop logs <pod-name>
```

### Check ingress and certificate
```bash
kubectl -n banterop get ingress
kubectl -n banterop get certificate
kubectl -n banterop describe certificate banterop-fhir-me
```

### Test health endpoint
```bash
curl -s https://banterop.fhir.me/api/health
# Expected: {"ok":true}
```

### Security Notes

1. **Never commit secrets to git** - Use `.gitignore` for any files with keys
2. **Rotate keys regularly** - Update secrets periodically  
3. **Use RBAC** - Limit who can read secrets in the namespace
4. **Consider Sealed Secrets** - For GitOps workflows, encrypt secrets before committing:

```bash
# Install sealed-secrets controller first, then:
echo -n 'your-key' | kubectl create secret generic app-secrets \
  --dry-run=client --from-file=OPENROUTER_API_KEY=/dev/stdin -o yaml | \
  kubeseal -o yaml > sealed-secret.yaml
# Commit sealed-secret.yaml to git (it's encrypted)
```