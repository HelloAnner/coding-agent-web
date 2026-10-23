# Local server for this branch. Listens on every interface.
# Turbopack compiles incrementally and keeps the cache in .next-common.
# The process is detached, so closing the terminal leaves it running.
# Login password: PI_WEB_PASSWORD in .env.local. That file stays out of git.

HOST := 0.0.0.0
PORT := 20169

.DEFAULT_GOAL := start
.PHONY: start stop restart

start:
	@PI_WEB_HOST=$(HOST) PI_WEB_PORT=$(PORT) node scripts/serve.mjs start

stop:
	@PI_WEB_HOST=$(HOST) PI_WEB_PORT=$(PORT) node scripts/serve.mjs stop

restart:
	@PI_WEB_HOST=$(HOST) PI_WEB_PORT=$(PORT) node scripts/serve.mjs restart
