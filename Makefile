COMPOSE = docker compose --env-file .env -f infra/docker-compose.yml

.PHONY: up down logs build db-up db-push test

## Full stack (nginx :80 → gateway → services, postgres, pgbouncer, redis, web)
up:
	$(COMPOSE) up --build -d

down:
	$(COMPOSE) down

logs:
	$(COMPOSE) logs -f

build:
	$(COMPOSE) build

## Local development helpers (services run on the host via `npm run dev`)
db-up:
	$(COMPOSE) up -d postgres redis

db-push:
	npm run db:push

test:
	npm test
