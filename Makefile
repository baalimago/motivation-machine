APP           ?= motivational-racoon-and-friends
VOLUME        ?= blessings
BLESSINGS_DIR ?= agent/staging

# Remote Postgres connection string. Grab credentials from the app dashboard
# (Storage → Database), then either:
#   export DATABASE_URL=postgres://user:pass@host:port/dbname
# or pass the DB_* pieces individually.
DATABASE_URL ?= postgres://$(DB_USERNAME):$(DB_PASSWORD)@$(DB_HOST):$(DB_PORT)/$(DB_NAME)

.PHONY: dev deploy migrate-db-remote bless publish-blessings

dev:
	npm run dev

deploy:
	wasmer deploy

# Apply all migrations, in order, against the remote db. Idempotent SQL only.
migrate-db-remote:
	@test -n "$(DATABASE_URL)" || (echo "set DATABASE_URL or DB_* vars" && exit 1)
	@for f in db/migrations/*.sql; do \
		echo "==> $$f"; \
		psql "$(DATABASE_URL)" -v ON_ERROR_STOP=1 -f $$f || exit 1; \
	done
	@echo "db blessed ✨"

# Run the daily agent locally: writes image + manifest into $(BLESSINGS_DIR).
# (On Edge the daily job does this in-process via POST /api/trigger-blessing.)
bless:
	BLESSINGS_DIR=$(BLESSINGS_DIR) npm run agent

# Push locally produced blessings to the app's volume (served at /blessings/*).
# One-time setup: wasmer app volumes credentials $(APP) --format=rclone
# and add the printed remote as [racoon-vol] in ~/.config/rclone/rclone.conf
publish-blessings:
	rclone copy $(BLESSINGS_DIR) racoon-vol:$(VOLUME)/ --progress
	@echo "blessings published 🦝"
