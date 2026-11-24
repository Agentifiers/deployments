package provider

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/tfsdk"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Agentifiers/deployments/infrastructure/terraform-provider-deployments/internal/client"
	"github.com/Agentifiers/deployments/infrastructure/terraform-provider-deployments/internal/secrets"
)

const (
	testAccountID    = "01ARZ3NDEKTSV4RRFFQ69G5FAA"
	testCredentialID = "01ARZ3NDEKTSV4RRFFQ69G5FAB"
	testSecret       = "dpl_01ARZ3NDEKTSV4RRFFQ69G5FAB_issued"
	testSecretName   = "/app/platform-api-key"
)

type fakeAPI struct {
	mu          sync.Mutex
	accounts    []client.ServiceAccount
	credentials []client.APICredential
	createdKeys int
	probeSecret string
}

func (f *fakeAPI) handler(writer http.ResponseWriter, request *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	writer.Header().Set("content-type", "application/json")
	switch {
	case request.Method == http.MethodGet && request.URL.Path == "/v1/service-accounts":
		_ = json.NewEncoder(writer).Encode(map[string]any{"items": f.accounts})
	case request.Method == http.MethodPost && request.URL.Path == "/v1/service-accounts":
		account := client.ServiceAccount{
			ID:     testAccountID,
			Name:   "Runtime",
			Scopes: []string{"approvals:read", "runs:read", "runs:write"},
			Status: "active",
		}
		f.accounts = append(f.accounts, account)
		writer.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(writer).Encode(account)
	case request.Method == http.MethodGet && request.URL.Path == "/v1/api-keys":
		_ = json.NewEncoder(writer).Encode(map[string]any{"items": f.credentials})
	case request.Method == http.MethodGet && request.URL.Path == "/v1/api-keys/"+testCredentialID:
		for _, credential := range f.credentials {
			if credential.ID == testCredentialID {
				_ = json.NewEncoder(writer).Encode(credential)
				return
			}
		}
		writer.WriteHeader(http.StatusNotFound)
	case request.Method == http.MethodPost && request.URL.Path == "/v1/api-keys":
		f.createdKeys++
		issued := client.APICredential{
			ID:               testCredentialID,
			KeyPrefix:        "dpl_01AR",
			Name:             "Runtime",
			Scopes:           []string{"approvals:read", "runs:read", "runs:write"},
			ServiceAccountID: testAccountID,
			Status:           "active",
			Secret:           testSecret,
		}
		stored := issued
		stored.Secret = ""
		f.credentials = append(f.credentials, stored)
		writer.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(writer).Encode(issued)
	case request.Method == http.MethodGet && request.URL.Path == "/v1/approvals":
		if request.Header.Get("authorization") != "Bearer "+testSecret {
			writer.WriteHeader(http.StatusUnauthorized)
			return
		}
		f.probeSecret = strings.TrimPrefix(request.Header.Get("authorization"), "Bearer ")
		_ = json.NewEncoder(writer).Encode(map[string]any{"items": []any{}})
	default:
		writer.WriteHeader(http.StatusNotFound)
	}
}

func testPlan() environmentCredentialModel {
	return environmentCredentialModel{
		Name:       types.StringValue("Runtime"),
		SecretName: types.StringValue(testSecretName),
		Scopes: types.SetValueMust(types.StringType, []attr.Value{
			types.StringValue("approvals:read"),
			types.StringValue("runs:read"),
			types.StringValue("runs:write"),
		}),
	}
}

func testClient(t *testing.T, fake *fakeAPI) *client.Client {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(fake.handler))
	t.Cleanup(server.Close)
	api, err := client.New(server.URL, "operator", client.Tenancy{
		OrganizationID: "org",
		ProjectID:      "prj",
		EnvironmentID:  "env",
	}, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	return api
}

func TestReconcileIssuesSecretWithoutRetainingIt(t *testing.T) {
	t.Parallel()
	fake := &fakeAPI{}
	store := secrets.NewMemory()
	store.Seed(testSecretName, "arn:aws:ssm:us-east-2:1:parameter/app/platform-api-key", "")
	resource := &environmentCredentialResource{client: testClient(t, fake), secrets: store}

	state, err := resource.reconcile(context.Background(), testPlan())
	if err != nil {
		t.Fatal(err)
	}
	if state.APICredentialID.ValueString() != testCredentialID {
		t.Fatalf("credential id %s", state.APICredentialID.ValueString())
	}
	if strings.Contains(state.ID.ValueString(), "issued") {
		t.Fatalf("state id leaked secret: %s", state.ID.ValueString())
	}
	record, err := store.Get(context.Background(), testSecretName)
	if err != nil {
		t.Fatal(err)
	}
	if record.Value != testSecret {
		t.Fatalf("store %q", record.Value)
	}
	if fake.createdKeys != 1 {
		t.Fatalf("created %d keys", fake.createdKeys)
	}
}

func TestReconcileAdoptsMatchingInstalledCredential(t *testing.T) {
	t.Parallel()
	fake := &fakeAPI{
		accounts: []client.ServiceAccount{{
			ID:     testAccountID,
			Name:   "Runtime",
			Scopes: []string{"approvals:read", "runs:read", "runs:write"},
			Status: "active",
		}},
		credentials: []client.APICredential{{
			ID:               testCredentialID,
			KeyPrefix:        "dpl_01AR",
			Name:             "Runtime",
			Scopes:           []string{"approvals:read", "runs:read", "runs:write"},
			ServiceAccountID: testAccountID,
			Status:           "active",
		}},
	}
	store := secrets.NewMemory()
	store.Seed(testSecretName, "arn:aws:ssm:us-east-2:1:parameter/app/platform-api-key", testSecret)
	resource := &environmentCredentialResource{client: testClient(t, fake), secrets: store}

	state, err := resource.reconcile(context.Background(), testPlan())
	if err != nil {
		t.Fatal(err)
	}
	if fake.createdKeys != 0 {
		t.Fatalf("rotated live credential")
	}
	if state.ServiceAccountID.ValueString() != testAccountID {
		t.Fatalf("account %s", state.ServiceAccountID.ValueString())
	}
}

func TestReconcileRefusesScopeWidening(t *testing.T) {
	t.Parallel()
	fake := &fakeAPI{
		accounts: []client.ServiceAccount{{
			ID:     testAccountID,
			Name:   "Runtime",
			Scopes: []string{"runs:read"},
			Status: "active",
		}},
	}
	store := secrets.NewMemory()
	store.Seed(testSecretName, "arn:aws:ssm:us-east-2:1:parameter/app/platform-api-key", "")
	resource := &environmentCredentialResource{client: testClient(t, fake), secrets: store}
	_, err := resource.reconcile(context.Background(), testPlan())
	if err == nil || !strings.Contains(err.Error(), "unexpected scopes") {
		t.Fatalf("error %v", err)
	}
}

func TestCredentialIDFromSecret(t *testing.T) {
	t.Parallel()
	if got := credentialIDFromSecret(testSecret); got != testCredentialID {
		t.Fatalf("got %s", got)
	}
	if credentialIDFromSecret("not-a-key") != "" {
		t.Fatal("expected empty")
	}
}

func TestReconcileCreatesMissingParameter(t *testing.T) {
	t.Parallel()
	fake := &fakeAPI{}
	store := secrets.NewMemory()
	resource := &environmentCredentialResource{client: testClient(t, fake), secrets: store}
	state, err := resource.reconcile(context.Background(), testPlan())
	if err != nil {
		t.Fatal(err)
	}
	record, err := store.Get(context.Background(), testSecretName)
	if err != nil {
		t.Fatal(err)
	}
	if record.Value != testSecret || state.SecretVersionID.ValueString() != "1" {
		t.Fatalf("value %q version %s", record.Value, state.SecretVersionID.ValueString())
	}
}

// parameterStore rejects names that are not paths, as Parameter Store does for the
// Secrets Manager names that earlier releases kept in state.
type parameterStore struct{ *secrets.MemoryStore }

func (s parameterStore) Get(ctx context.Context, name string) (secrets.Record, error) {
	if !strings.HasPrefix(name, "/") {
		return secrets.Record{}, errors.New("ValidationException: parameter name is not a path")
	}
	return s.MemoryStore.Get(ctx, name)
}

func TestReadForgetsSecretsManagerState(t *testing.T) {
	t.Parallel()
	fake := &fakeAPI{credentials: []client.APICredential{{ID: testCredentialID, Status: "active"}}}
	store := parameterStore{secrets.NewMemory()}
	store.Seed(testSecretName, "arn:aws:ssm:us-east-2:1:parameter/app/platform-api-key", testSecret)
	r := &environmentCredentialResource{client: testClient(t, fake), secrets: store}
	var schemaResp resource.SchemaResponse
	r.Schema(context.Background(), resource.SchemaRequest{}, &schemaResp)

	for name, want := range map[string]bool{"app-dev/runtime/platform-api-key": false, testSecretName: true} {
		state := tfsdk.State{Schema: schemaResp.Schema}
		model := testPlan()
		model.SecretName = types.StringValue(name)
		model.APICredentialID = types.StringValue(testCredentialID)
		if diags := state.Set(context.Background(), &model); diags.HasError() {
			t.Fatal(diags)
		}
		resp := resource.ReadResponse{State: state}
		r.Read(context.Background(), resource.ReadRequest{State: state}, &resp)
		if resp.Diagnostics.HasError() {
			t.Fatalf("%s: %v", name, resp.Diagnostics)
		}
		if kept := !resp.State.Raw.IsNull(); kept != want {
			t.Fatalf("%s: kept %v, want %v", name, kept, want)
		}
	}
	if fake.createdKeys != 0 {
		t.Fatal("read issued a key")
	}
}
