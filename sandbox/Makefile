# pi-agent sandbox Makefile
#
# Convenience targets for smolvm-based pi-coding-agent sandbox.
# Delegates to sandbox/scripts/*.sh and wraps common workflows.
#
# Usage:
#   make doctor          # preflight checks
#   make build           # build VM image
#   make pi              # launch pi in ephemeral VM (default allowlist)
#   make pi-offline      # launch pi in offline VM
#   make pi-persist      # launch pi in persistent VM
#   make shell           # bash in ephemeral VM
#   make shell-persist   # bash in persistent VM
#   make stop            # stop persistent VM
#   make delete          # delete persistent VM (wipe overlay + storage)
#   make clean           # delete persistent VM + clean build artifacts

SANDBOX_DIR := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
SCRIPTS_DIR := $(SANDBOX_DIR)scripts

# ── Help ──────────────────────────────────────────────────────────────────────

.DEFAULT_GOAL := help

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'
	@echo
	@echo "Pass-through arguments to run-agent.sh:"
	@echo "  make pi ARGS='--persistent --name mybox -- --pi-arg value'"
	@echo "  make pi SKILLS='/path/to/skill' EXTS='/path/to/ext'"
	@echo
	@echo "Use PI_ARGS for arbitrary run-agent.sh flags:"
	@echo "  make PI_ARGS='--workspace /other/proj --allowlist offline' pi"

# ── Preflight ─────────────────────────────────────────────────────────────────

doctor: ## Run preflight checks (requires smolvm + image builder + SSH agent)
	$(SCRIPTS_DIR)/doctor.sh

# ── Image ─────────────────────────────────────────────────────────────────────

build: ## Build the pi-agent VM image (podman/docker → images/pi-agent.tar)
	$(SCRIPTS_DIR)/build-image.sh

# ── Ephemeral VM targets ─────────────────────────────────────────────────────

# Build shared flags: workspace dir, skill/extension mounts
ADHOC_ARGS := $(if $(SKILLS),$(foreach s,$(SKILLS),--skill $(s))) \
              $(if $(EXTS),$(foreach e,$(EXTS),--extension $(e)))

pi: ## Launch pi in ephemeral VM (default: cwd=workspace, default allowlist)
	$(SCRIPTS_DIR)/run-agent.sh $(PI_ARGS) $(ADHOC_ARGS) -- $(ARGS)

pi-offline: ## Launch pi in ephemeral VM with no network
	$(SCRIPTS_DIR)/run-agent.sh $(PI_ARGS) $(ADHOC_ARGS) --allowlist offline -- $(ARGS)

shell: ## Open bash shell in ephemeral VM
	$(SCRIPTS_DIR)/run-agent.sh $(PI_ARGS) --shell $(ADHOC_ARGS)

# ── Persistent VM targets ────────────────────────────────────────────────────

pi-persist: ## Launch pi in persistent VM (installs survive across sessions)
	$(SCRIPTS_DIR)/run-agent.sh $(PI_ARGS) --persistent $(ADHOC_ARGS) -- $(ARGS)

shell-persist: ## Open bash shell in persistent VM
	$(SCRIPTS_DIR)/run-agent.sh $(PI_ARGS) --persistent --shell $(ADHOC_ARGS)

stop: ## Stop the persistent machine
	@if smolvm machine status --name pi-agent >/dev/null 2>&1; then \
		smolvm machine stop --name pi-agent; \
	else \
		echo "No persistent machine 'pi-agent' found."; \
	fi

delete: ## Delete the persistent machine (wipes overlay + storage)
	if smolvm machine status --name pi-agent >/dev/null 2>&1; then \
		smolvm machine stop --name pi-agent 2>/dev/null || true; \
		smolvm machine delete --name pi-agent; \
	else \
		echo "No persistent machine 'pi-agent' found."; \
	fi

# ── Cleanup ───────────────────────────────────────────────────────────────────

clean: delete ## Delete persistent machine + remove built image
	rm -f $(SANDBOX_DIR)images/pi-agent.tar
	@echo "Removed images/pi-agent.tar"

# ── Phony targets ─────────────────────────────────────────────────────────────

.PHONY: help doctor build pi pi-offline shell pi-persist shell-persist stop delete clean
