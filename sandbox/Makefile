# pi-agent sandbox Makefile
#
# Convenience targets for the lima-based pi-coding-agent sandbox.
# Delegates to sandbox/scripts/*.sh and wraps common workflows.
#
# Usage:
#   make doctor          # preflight checks
#   make pi              # launch pi (default: cwd=workspace, full network)
#   make pi-offline      # launch pi with no network
#   make pi-fresh        # wipe + recreate the instance, then launch pi
#   make shell           # bash in the VM
#   make stop            # stop the instance
#   make delete          # delete the instance
#   make clean           # alias for delete (instance only — nothing else is built)

SANDBOX_DIR := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
SCRIPTS_DIR := $(SANDBOX_DIR)scripts
NAME ?= pi-agent

# ── Help ──────────────────────────────────────────────────────────────────────

.DEFAULT_GOAL := help

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'
	@echo
	@echo "Pass-through arguments to launch.sh:"
	@echo "  make pi ARGS='--pi-arg value'"
	@echo "  make pi SKILLS='/path/to/skill' EXTS='/path/to/ext'"
	@echo "  make pi CONFIGS='~/.pi/agent/pi-langfuse:pi-langfuse'"
	@echo
	@echo "Use PI_ARGS for arbitrary launch.sh flags (explicit --name overrides NAME):"
	@echo "  make NAME=mybox PI_ARGS='--workspace /other/proj' pi"

# ── Preflight ─────────────────────────────────────────────────────────────────

doctor: ## Run preflight checks (requires lima + SSH agent)
	$(SCRIPTS_DIR)/doctor.sh

# ── VM targets ───────────────────────────────────────────────────────────────

# Build shared flags: skill/extension/config mounts
ADHOC_ARGS := $(if $(SKILLS),$(foreach s,$(SKILLS),--skill $(s))) \
              $(if $(EXTS),$(foreach e,$(EXTS),--extension $(e))) \
              $(if $(CONFIGS),$(foreach c,$(CONFIGS),--config $(c)))

pi: ## Launch pi in the persistent VM (default: cwd=workspace)
	$(SCRIPTS_DIR)/launch.sh --name "$(NAME)" $(PI_ARGS) $(ADHOC_ARGS) -- $(ARGS)

pi-offline: ## Launch pi in the VM with no network
	$(SCRIPTS_DIR)/launch.sh --name "$(NAME)" $(PI_ARGS) $(ADHOC_ARGS) --allowlist offline -- $(ARGS)

pi-fresh: ## Wipe + recreate the instance, then launch pi
	$(SCRIPTS_DIR)/launch.sh --name "$(NAME)" $(PI_ARGS) $(ADHOC_ARGS) --fresh -- $(ARGS)

shell: ## Open bash shell in the VM
	$(SCRIPTS_DIR)/launch.sh --name "$(NAME)" $(PI_ARGS) --shell $(ADHOC_ARGS)

stop: ## Stop the instance
	@if limactl list --format '{{.Name}}' | grep -Fqx -- '$(NAME)'; then \
		limactl stop '$(NAME)'; \
	else \
		echo "No instance '$(NAME)' found."; \
	fi

delete: ## Delete the instance (wipes the disk; re-created on next launch)
	@if limactl list --format '{{.Name}}' | grep -Fqx -- '$(NAME)'; then \
		limactl stop '$(NAME)' 2>/dev/null || true; \
		limactl delete '$(NAME)'; \
	else \
		echo "No instance '$(NAME)' found."; \
	fi

# ── Cleanup ───────────────────────────────────────────────────────────────────

clean: delete ## Delete the instance (nothing else is built anymore)

# ── Phony targets ─────────────────────────────────────────────────────────────

.PHONY: help doctor pi pi-offline pi-fresh shell stop delete clean
