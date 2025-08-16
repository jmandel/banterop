# Kubernetes deployment (file-driven)

This folder contains self-contained manifests to deploy the API + WS server behind nginx ingress with cert-manager TLS.

## Files
- `app.yaml`
  - Namespace: `interop`
  - PVC: `convo-db` (SQLite at `/data/data.db`)
  - ConfigMap/Secret: runtime config and optional API keys
  - Deployment: single replica of the server
  - Service: ClusterIP on port 80 → container 3000
  - Ingress: `chitchat.fhir.me` with TLS via `ClusterIssuer letsencrypt-prod`

## Prereqs
- Kubernetes cluster with:
  - nginx ingress controller (class `nginx`)
  - cert-manager installed and a `ClusterIssuer/letsencrypt-prod` Ready
  - StorageClass default (DigitalOcean block storage is fine)
- DNS:
  - `A chitchat.fhir.me → <ingress external IP>`
- Container image available in a public registry

## Build and push the image
Replace `your-dockerhub-username` below with your account.

```bash
# from repo root
IMAGE=your-dockerhub-username/interop-api:$(git rev-parse --short HEAD)

# build & push
docker build -t $IMAGE .
docker push $IMAGE

# (optional) also tag latest
docker tag $IMAGE your-dockerhub-username/interop-api:latest
docker push your-dockerhub-username/interop-api:latest
```

## Configure the manifests
Edit `app.yaml` once to set the Deployment image:

```yaml
containers:
  - name: api
    image: your-dockerhub-username/interop-api:latest  # <- set THIS
```

Secrets are managed separately to avoid accidental resets:

```bash
kubectl -n interop create secret generic app-secrets \
  --from-literal=OPENROUTER_API_KEY="..." \
  --from-literal=GEMINI_API_KEY="..." \
  --dry-run=client -o yaml | kubectl apply -f -
```

## Apply
```bash
kubectl apply -f k8s/app.yaml
kubectl -n interop rollout status deploy/interop-api
kubectl -n interop get ing interop-api
```

Within a minute or two cert-manager should create a certificate and the Ingress should serve HTTPS.

## Verify
```bash
curl -s https://chitchat.fhir.me/api/health
# Expect: {"ok":true}
```

## Updating
- Rebuild and push a new image tag.
- Update the Deployment image in `app.yaml` (or use a tag like `latest`).
- Apply again: `kubectl apply -f k8s/app.yaml`.

## Notes
- SQLite data is persisted in `convo-db` PVC. To reset, delete the PVC (will delete data).
- To restrict OpenRouter models, set:
  `LLM_MODELS_OPENROUTER_INCLUDE="openai/gpt-oss-120b:nitro,qwen/qwen3-235b-a22b-2507:nitro"` in the Deployment env.
- WebSocket endpoint is `/api/ws` under the same host.


