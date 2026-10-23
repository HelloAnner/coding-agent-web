# Local server for this branch. Still the pi harness.
# Turbopack compiles incrementally and keeps the cache in .next-common.
# The process is detached, so closing the terminal leaves it running.

HOST := 127.0.0.1
PORT := 20169

.PHONY: start stop restart

start:
	@PI_WEB_HOST=$(HOST) PI_WEB_PORT=$(PORT) node scripts/serve.mjs start

stop:
	@PI_WEB_HOST=$(HOST) PI_WEB_PORT=$(PORT) node scripts/serve.mjs stop

restart:
	@PI_WEB_HOST=$(HOST) PI_WEB_PORT=$(PORT) node scripts/serve.mjs restart
