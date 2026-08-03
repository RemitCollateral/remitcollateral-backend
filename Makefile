WASM_TARGET := wasm32v1-none
OUT         := target/$(WASM_TARGET)/release
CONTRACTS   := property_registry mortgage_pool

# Soroban mainnet caps an uploaded contract at 64 KiB of wasm. Anything at or
# above this is undeployable, so `make size` treats it as a hard failure and
# warns once a contract passes 80% of the budget.
MAX_WASM_BYTES := 65536
WARN_PCT       := 80

.PHONY: all build test check fmt clippy size clean

all: build size

# property-registry is built first because mortgage-pool currently pulls its
# client in with `contractimport!`, which reads the registry's .wasm off disk at
# macro-expansion time. Cargo does not know about that edge, so a cold
# `cargo build` of the whole workspace can race and fail.
build:
	cargo build --release --target $(WASM_TARGET) -p property-registry
	cargo build --release --target $(WASM_TARGET)

# Host target on purpose: tests need std and the testutils feature.
test:
	cargo test

fmt:
	cargo fmt --all

clippy:
	cargo clippy --release --target $(WASM_TARGET) --all-targets -- -D warnings

check: fmt clippy test

# Reports each contract against the mainnet budget and fails the build if any
# contract no longer fits. Wire this into CI so a size regression is caught at
# review time rather than at upload time.
size: build
	@status=0; \
	printf '%-22s %10s %8s %s\n' CONTRACT BYTES USED ''; \
	for c in $(CONTRACTS); do \
		f="$(OUT)/$$c.wasm"; \
		if [ ! -f "$$f" ]; then echo "missing $$f"; status=1; continue; fi; \
		b=`wc -c < "$$f" | tr -d ' '`; \
		pct=`expr $$b \* 100 / $(MAX_WASM_BYTES)`; \
		note=ok; \
		if [ $$b -ge $(MAX_WASM_BYTES) ]; then note='OVER LIMIT'; status=1; \
		elif [ $$pct -ge $(WARN_PCT) ]; then note='near limit'; fi; \
		printf '%-22s %10d %7d%% %s\n' "$$c" "$$b" "$$pct" "$$note"; \
	done; \
	printf '%-22s %10d\n' 'budget' $(MAX_WASM_BYTES); \
	exit $$status

clean:
	cargo clean
