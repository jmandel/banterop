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
  --from-literal=PUBLISHED_EDIT_TOKEN="..." \
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
- To restrict OpenRouter models, set:
  `LLM_MODELS_OPENROUTER_INCLUDE="openai/gpt-oss-120b:nitro,qwen/qwen3-235b-a22b-2507:nitro"` in the Deployment env.
- WebSocket endpoint is `/api/ws` under the same host.

## Published Edit Token (optional)

Enable a soft-lock for scenarios tagged `published`. When set, the API returns `423 Locked` for `PUT`/`DELETE` on published scenarios unless the `X-Edit-Token` header matches the configured token. The UI always offers an Unlock flow and includes the header if present.

### Set or rotate the token

Option A: Guided script (recommended)

```bash
# Prompts for all secrets, including PUBLISHED_EDIT_TOKEN
./k8s/update-secrets.sh

# Restart to pick up the change
kubectl -n interop rollout restart deploy/interop-api
```

Option B: kubectl patch

```bash
# Set your token; keep it simple but unguessable for your environment
EDIT_TOKEN="my-shared-edit-token"
kubectl -n interop patch secret app-secrets -p \
  '{"data":{"PUBLISHED_EDIT_TOKEN":"'$(echo -n $EDIT_TOKEN | base64)'"}}'

# Restart to pick up the change
kubectl -n interop rollout restart deploy/interop-api
```

To disable server enforcement, clear the secret value (empty string) and restart:

```bash
kubectl -n interop patch secret app-secrets -p '{"data":{"PUBLISHED_EDIT_TOKEN":""}}'
kubectl -n interop rollout restart deploy/interop-api
```

### Verify

1) Identify a scenario whose config includes `metadata.tags: ["published"]`.

2) Without a token (expect 423):

```bash
SCENARIO_ID=your_published_scenario_id
BASE=https://chitchat.fhir.me
curl -s -o /dev/null -w "%{http_code}\n" \
  -X PUT "$BASE/api/scenarios/$SCENARIO_ID" \
  -H 'Content-Type: application/json' \
  --data '{"name":"Test"}'
# Expect: 423
```

3) With the correct token (expect 200):

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -X PUT "$BASE/api/scenarios/$SCENARIO_ID" \
  -H 'Content-Type: application/json' \
  -H "X-Edit-Token: $EDIT_TOKEN" \
  --data '{"name":"Test"}'
# Expect: 200
```

UI notes:
- The editor shows a banner and an Unlock flow for published scenarios.
- Unlock is local (stored in `localStorage`) with a 24h TTL; users can "Lock again" or "Forget token".
- If the token is wrong or not required, the server response makes it obvious (423 vs 200).

## Reset / Wipe Data

SQLite state is stored on the `convo-db` PersistentVolumeClaim (PVC) mounted at `/data` in the container (DB file at `/data/data.db`). If you used `app-with-debug.yaml`, LLM debug logs are on a separate `debug-logs` PVC mounted at `/debug`.

Choose one of the approaches below depending on whether you want to keep the PVC(s) or fully delete and re-create them.

### Option A: Delete PVC(s) to fully reset

This removes the volume and all data. A new, empty volume is created on the next apply. On most clusters with a default StorageClass, deleting the PVC will delete the backing PV and data. If your StorageClass uses a `Retain` reclaim policy, also delete the PV or wipe it manually.

1) Delete the conversation DB PVC (and debug logs PVC if present):

```bash
kubectl -n interop delete pvc convo-db
# If using app-with-debug.yaml
kubectl -n interop delete pvc debug-logs
```

2) Recreate from manifests (choose the manifest you use):

```bash
kubectl apply -f k8s/app.yaml
# or
kubectl apply -f k8s/app-with-debug.yaml
```

3) Verify the app rolls out and binds new volumes:

```bash
kubectl -n interop rollout status deploy/interop-api
kubectl -n interop get pvc
```

Check reclaim policy if you need to confirm deletion behavior:

```bash
kubectl get sc
kubectl get pv | grep convo-db
```

### Option B: Wipe files but keep PVC(s)

If you want to preserve the claim itself but clear the data inside, run a short-lived Job that mounts the PVC and removes files. This avoids re-provisioning storage and keeps any StorageClass settings the same.

Wipe the conversation DB file(s):

```bash
kubectl apply -f - <<'YAML'
apiVersion: batch/v1
kind: Job
metadata:
  name: wipe-convo-db
  namespace: interop
spec:
  template:
    spec:
      restartPolicy: OnFailure
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: convo-db
      containers:
        - name: wipe
          image: busybox:1.36
          command: ["/bin/sh","-lc","rm -f /data/data.db /data/data.db-* && echo 'DB removed'"]
          volumeMounts:
            - name: data
              mountPath: /data
  backoffLimit: 0
YAML

# Wait for completion, then clean up the Job (optional)
kubectl -n interop wait --for=condition=complete job/wipe-convo-db --timeout=60s || true
kubectl -n interop delete job wipe-convo-db
```

Wipe debug logs (only if using `app-with-debug.yaml`):

```bash
kubectl apply -f - <<'YAML'
apiVersion: batch/v1
kind: Job
metadata:
  name: wipe-debug-logs
  namespace: interop
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
          command: ["/bin/sh","-lc","rm -rf /debug/llm-debug/* && echo 'Logs removed'"]
          volumeMounts:
            - name: debug
              mountPath: /debug
  backoffLimit: 0
YAML

kubectl -n interop wait --for=condition=complete job/wipe-debug-logs --timeout=60s || true
kubectl -n interop delete job wipe-debug-logs
```

Notes:
- The Deployment uses `strategy: Recreate` and a single replica; you do not need to scale down to wipe files, but active writes may briefly fail during deletion. For a perfectly clean reset, perform the wipe during a quiet period.
- The server recreates and migrates the SQLite schema automatically on startup or first access when the DB file is missing.
