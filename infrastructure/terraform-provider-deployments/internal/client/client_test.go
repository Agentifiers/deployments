package client

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestListServiceAccountsPages(t *testing.T) {
	t.Parallel()
	var calls int
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		calls++
		if request.URL.Path != "/v1/service-accounts" {
			t.Fatalf("path %s", request.URL.Path)
		}
		if request.Header.Get("x-deployments-environment") != "env_1" {
			t.Fatalf("missing tenancy header")
		}
		writer.Header().Set("content-type", "application/json")
		if request.URL.Query().Get("cursor") == "" {
			next := "next"
			_ = json.NewEncoder(writer).Encode(map[string]any{
				"items":      []map[string]any{{"id": "sa_1", "name": "Runtime", "scopes": []string{"runs:read"}, "status": "active"}},
				"nextCursor": next,
			})
			return
		}
		_ = json.NewEncoder(writer).Encode(map[string]any{
			"items": []map[string]any{{"id": "sa_2", "name": "Other", "scopes": []string{"runs:read"}, "status": "active"}},
		})
	}))
	t.Cleanup(server.Close)

	api, err := New(server.URL, "operator", Tenancy{
		OrganizationID: "org_1",
		ProjectID:      "prj_1",
		EnvironmentID:  "env_1",
	}, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	accounts, err := api.ListServiceAccounts(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if calls != 2 || len(accounts) != 2 || accounts[1].ID != "sa_2" {
		t.Fatalf("calls=%d accounts=%v", calls, accounts)
	}
}

func TestCreateAPICredentialReturnsSecretOnce(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/v1/api-keys" {
			t.Fatalf("%s %s", request.Method, request.URL.Path)
		}
		if request.Header.Get("idempotency-key") == "" {
			t.Fatal("missing idempotency key")
		}
		writer.Header().Set("content-type", "application/json")
		writer.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(writer).Encode(map[string]any{
			"id":                "01ARZ3NDEKTSV4RRFFQ69G5FAV",
			"keyPrefix":         "dpl_01AR",
			"name":              "Runtime",
			"scopes":            []string{"runs:read"},
			"serviceAccountId":  "sa_1",
			"status":            "active",
			"secret":            "dpl_01ARZ3NDEKTSV4RRFFQ69G5FAV_secret",
			"secretVisibleOnce": true,
		})
	}))
	t.Cleanup(server.Close)
	api, err := New(server.URL, "operator", Tenancy{OrganizationID: "org", ProjectID: "prj", EnvironmentID: "env"}, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	issued, err := api.CreateAPICredential(context.Background(), "Runtime", "sa_1", []string{"runs:read"})
	if err != nil {
		t.Fatal(err)
	}
	if issued.Secret != "dpl_01ARZ3NDEKTSV4RRFFQ69G5FAV_secret" {
		t.Fatalf("secret %q", issued.Secret)
	}
}

func TestRevokeAPICredentialSatisfiesMutationContract(t *testing.T) {
	t.Parallel()
	var revoked atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodDelete || request.URL.Path != "/v1/api-keys/credential" {
			http.NotFound(writer, request)
			return
		}
		if request.Header.Get("idempotency-key") == "" {
			http.Error(writer, "mutation requires an idempotency key", http.StatusBadRequest)
			return
		}
		revoked.Store(true)
		writer.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(server.Close)
	api, err := New(server.URL, "operator", Tenancy{OrganizationID: "org", ProjectID: "prj", EnvironmentID: "env"}, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if err := api.RevokeAPICredential(context.Background(), "credential"); err != nil {
		t.Fatal(err)
	}
	if !revoked.Load() {
		t.Fatal("credential remains active")
	}
}

func TestSameScopesIgnoresOrder(t *testing.T) {
	t.Parallel()
	if !SameScopes([]string{"runs:write", "runs:read"}, []string{"runs:read", "runs:write"}) {
		t.Fatal("expected equal")
	}
	if SameScopes([]string{"runs:read"}, []string{"runs:read", "runs:write"}) {
		t.Fatal("did not expect extra scope")
	}
}

func TestActiveNamedScopedPicksMatchingDuplicate(t *testing.T) {
	t.Parallel()
	accounts := []ServiceAccount{
		{ID: "old", Name: "Runtime", Scopes: []string{"runs:read"}, Status: "active"},
		{ID: "new", Name: "Runtime", Scopes: []string{"approvals:read", "runs:read"}, Status: "active"},
	}
	match, found, err := ActiveNamedScoped(accounts, "Runtime", "service accounts", []string{"approvals:read", "runs:read"})
	if err != nil || !found || match.ID != "new" {
		t.Fatalf("match=%v found=%v err=%v", match, found, err)
	}
}

func TestProbeRejectsUnauthorized(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v1/approvals" {
			t.Fatalf("path %s", request.URL.Path)
		}
		if request.Header.Get("authorization") != "Bearer issued" {
			t.Fatalf("authorization %s", request.Header.Get("authorization"))
		}
		writer.WriteHeader(http.StatusUnauthorized)
	}))
	t.Cleanup(server.Close)
	api, err := New(server.URL, "operator", Tenancy{OrganizationID: "org", ProjectID: "prj", EnvironmentID: "env"}, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	err = api.Probe(context.Background(), "issued", []string{"approvals:read"})
	if err == nil {
		t.Fatal("expected probe failure")
	}
}

func TestProbeSupportsAgentAndChannelCredentials(t *testing.T) {
	t.Parallel()
	for _, capability := range []struct {
		scope string
		path  string
	}{
		{"agents:read", "/v1/agent-definitions"},
		{"channels:read", "/v1/channel-bindings"},
	} {
		t.Run(capability.scope, func(t *testing.T) {
			t.Parallel()
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				if request.Method != http.MethodGet || request.URL.Path != capability.path ||
					request.Header.Get("authorization") != "Bearer issued" {
					writer.WriteHeader(http.StatusForbidden)
					return
				}
				writer.WriteHeader(http.StatusOK)
			}))
			t.Cleanup(server.Close)
			api, err := New(server.URL, "operator", Tenancy{OrganizationID: "org", ProjectID: "prj", EnvironmentID: "env"}, server.Client())
			if err != nil {
				t.Fatal(err)
			}
			if err := api.Probe(context.Background(), "issued", []string{capability.scope}); err != nil {
				t.Fatal(err)
			}
		})
	}
}
