# To configure OpenRouter provider routing (e.g., exclude providers, optimize for price/speed):
# kubectl -n banterop set env deploy/banterop-api OPENROUTER_PROVIDER_CONFIG='{"ignore":["baseten"],"sort":"throughput","allow_fallbacks":true}'
# 
# Other examples:
# - Price optimized: OPENROUTER_PROVIDER_CONFIG='{"sort":"price","max_price":{"input":1.0,"output":2.0}}'
# - Specific providers only: OPENROUTER_PROVIDER_CONFIG='{"only":["openai","anthropic"]}'
# - Privacy focused: OPENROUTER_PROVIDER_CONFIG='{"data_collection":"deny","ignore":["baseten"]}'

kubectl -n banterop exec deploy/banterop-api -- tar -czf - /data/banterop.db /data/banterop.db-wal /data/banterop.db-shm 2>/dev/null | tar -xzf -

