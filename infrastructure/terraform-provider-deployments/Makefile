VERSION ?= 0.1.0
OS_ARCH := $(shell go env GOOS)_$(shell go env GOARCH)
PLUGIN_DIR := $(HOME)/.terraform.d/plugins/terraform.local/deployments-ai/deployments/$(VERSION)/$(OS_ARCH)
BINARY := terraform-provider-deployments

.PHONY: build test install fmt

build:
	go build -o $(BINARY) .

test:
	go test ./...

fmt:
	gofmt -w .

install: build
	mkdir -p "$(PLUGIN_DIR)"
	cp "$(BINARY)" "$(PLUGIN_DIR)/$(BINARY)"
