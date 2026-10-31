# Local production server for this branch. Listens on every interface.
# Webpack builds into .next-common or .next-common-b, then `next start` serves
# that build. `restart` builds into the dir the running server is not using, so
# the live app keeps answering until the build is done and the swap is quick.
# The process is detached, so closing the terminal leaves it running. Run
# `make restart` inside the web terminal and it re-spawns itself detached, since
# the caller dies with the server it is stopping; watch .run/restart.log.
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
