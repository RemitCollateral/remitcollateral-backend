WASM_TARGET := wasm32v1-none
OUT         := target/$(WASM_TARGET)/release
CONTRACTS   := property_registry mortgage_pool

# Soroban mainnet caps an uploaded contract at 64 KiB of wasm. Anything at or
# above this is undeployable, so `make size` treats it as a hard failure and
# warns once a contract passes 80% of the budget.
MAX_WASM_BYTES := 65536
WARN_PCT       := 80

.PHONY: all build test check fmt fmt-check clippy size clean

all: build size

build:
	cargo build --release --target $(WASM_TARGET)

# Host target on purpose: tests need std and the testutils feature. Depends on
# `build` because mortgage-pool's cross-contract test imports the registry's
# compiled wasm, to check its hand-written client against the real artifact.
test: build
	cargo test

fmt:
	cargo fmt --all

# Verification form, for `check` and CI -- `fmt` itself rewrites files, which is
# not what you want a check to do.
fmt-check:
	cargo fmt --all -- --check

# Two passes: the contracts as they are actually compiled (wasm, libs only),
# then everything including tests on the host. Linting --all-targets against
# wasm does not work -- the test targets need `testutils`, which pulls in
# host-only crates.
#
# Depends on `build` for the same reason `test` does: the host pass compiles the
# test modules, one of which imports the registry's wasm.
clippy: build
	cargo clippy --release --target $(WASM_TARGET) --lib -- -D warnings
	cargo clippy --all-targets -- -D warnings

check: fmt-check clippy test size

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
