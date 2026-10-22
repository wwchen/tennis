.DEFAULT_GOAL := help
.PHONY: help install dev build test lint typecheck check image session-index up down logs clean

IMAGE ?= shot-lab/web

help: ## Show this help
	@grep -hE '^[a-z][a-zA-Z0-9_-]*:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies from the lockfile
	npm ci

dev: ## Run the Vite dev server on :5173
	npm run dev

build: ## Typecheck and build to dist/
	npm run build

test: ## Run unit tests once
	npm run test

lint: ## Run ESLint
	npm run lint

typecheck: ## Run tsc --noEmit
	npm run typecheck

check: lint typecheck test build ## Everything CI runs, in CI's order

image: ## Build the production container
	docker build --target web -t $(IMAGE) .

session-index: ## Rebuild the static /api/session payloads under out/_index
	node scripts/session-index.ts

up: session-index ## Serve the production build on 127.0.0.1:8080
	docker compose up -d --build
	@echo "http://127.0.0.1:8080"

down: ## Stop the stack
	docker compose --profile tunnel down

logs: ## Tail container logs
	docker compose logs -f

clean: ## Remove build output and caches
	rm -rf dist coverage node_modules/.vite
