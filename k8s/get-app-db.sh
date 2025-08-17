kubectl -n interop exec deploy/interop-api -- tar -czf - /data/data.db /data/data.db-wal /data/data.db-shm 2>/dev/null | tar -xzf -

