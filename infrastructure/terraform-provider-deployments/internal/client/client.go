package client

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/google/uuid"
)

const userAgent = "terraform-provider-deployments/0.1.0"

var ErrNotFound = errors.New("platform resource not found")

type Tenancy struct {
	OrganizationID string
	ProjectID      string
	EnvironmentID  string
}

type Client struct {
	apiKey     string
	baseURL    *url.URL
	httpClient *http.Client
	tenancy    Tenancy
}

type ServiceAccount struct {
	ID     string   `json:"id"`
	Name   string   `json:"name"`
	Scopes []string `json:"scopes"`
	Status string   `json:"status"`
}

type APICredential struct {
	ID               string   `json:"id"`
	KeyPrefix        string   `json:"keyPrefix"`
	Name             string   `json:"name"`
	Scopes           []string `json:"scopes"`
	ServiceAccountID string   `json:"serviceAccountId"`
	Status           string   `json:"status"`
	Secret           string   `json:"secret"`
}

type Problem struct {
	Detail string `json:"detail"`
	Status int    `json:"status"`
	Title  string `json:"title"`
}

func (p Problem) Error() string {
	if strings.TrimSpace(p.Detail) != "" {
		return p.Detail
	}
	if strings.TrimSpace(p.Title) != "" {
		return p.Title
	}
	return "platform API request failed"
}

func New(baseURL, apiKey string, tenancy Tenancy, httpClient *http.Client) (*Client, error) {
	parsed, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil {
		return nil, fmt.Errorf("invalid platform API URL: %w", err)
	}
	if parsed.Path != "" && parsed.Path != "/" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, fmt.Errorf("platform API URL must be an origin without a path, query, or fragment")
	}
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	return &Client{
		apiKey:     strings.TrimSpace(apiKey),
		baseURL:    parsed,
		httpClient: httpClient,
		tenancy:    tenancy,
	}, nil
}

func (c *Client) ListServiceAccounts(ctx context.Context) ([]ServiceAccount, error) {
	return listAll[ServiceAccount](ctx, c, "/v1/service-accounts")
}

func (c *Client) CreateServiceAccount(ctx context.Context, name string, scopes []string) (ServiceAccount, error) {
	var created ServiceAccount
	err := c.do(ctx, http.MethodPost, "/v1/service-accounts", map[string]any{
		"name":   name,
		"scopes": scopes,
	}, &created)
	return created, err
}

func (c *Client) GetServiceAccount(ctx context.Context, id string) (ServiceAccount, error) {
	var account ServiceAccount
	err := c.do(ctx, http.MethodGet, "/v1/service-accounts/"+url.PathEscape(id), nil, &account)
	return account, err
}

func (c *Client) ListAPICredentials(ctx context.Context) ([]APICredential, error) {
	return listAll[APICredential](ctx, c, "/v1/api-keys")
}

func (c *Client) CreateAPICredential(ctx context.Context, name, serviceAccountID string, scopes []string) (APICredential, error) {
	var issued APICredential
	err := c.do(ctx, http.MethodPost, "/v1/api-keys", map[string]any{
		"name":             name,
		"scopes":           scopes,
		"serviceAccountId": serviceAccountID,
	}, &issued)
	return issued, err
}

func (c *Client) GetAPICredential(ctx context.Context, id string) (APICredential, error) {
	credentials, err := c.ListAPICredentials(ctx)
	if err != nil {
		return APICredential{}, err
	}
	for _, credential := range credentials {
		if credential.ID == id {
			return credential, nil
		}
	}
	return APICredential{}, ErrNotFound
}

func (c *Client) RevokeAPICredential(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodDelete, "/v1/api-keys/"+url.PathEscape(id), nil, nil)
}

func (c *Client) Probe(ctx context.Context, secret string, scopes []string) error {
	path, err := probePath(scopes)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(c.baseURL.String(), "/")+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("accept", "application/json")
	req.Header.Set("authorization", "Bearer "+secret)
	req.Header.Set("user-agent", userAgent)
	c.applyTenancy(req)
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode == http.StatusOK {
		return nil
	}
	if resp.StatusCode == http.StatusUnauthorized {
		return fmt.Errorf("issued API credential was rejected by %s", path)
	}
	return fmt.Errorf("issued API credential probe returned HTTP %d for %s", resp.StatusCode, path)
}

func probePath(scopes []string) (string, error) {
	permitted := make(map[string]struct{}, len(scopes))
	for _, scope := range scopes {
		permitted[scope] = struct{}{}
	}
	for _, probe := range []struct {
		scope string
		path  string
	}{
		{"approvals:read", "/v1/approvals?limit=1"},
		{"agents:read", "/v1/agent-definitions?limit=1"},
		{"channels:read", "/v1/channel-bindings?limit=1"},
		{"workspaces:read", "/v1/workspaces?limit=1"},
		{"tools:read", "/v1/extensions?limit=1"},
		{"schedules:read", "/v1/schedules?limit=1"},
		{"webhooks:read", "/v1/webhooks?limit=1"},
	} {
		if _, ok := permitted[probe.scope]; ok {
			return probe.path, nil
		}
	}
	return "", fmt.Errorf("scopes must include a supported read capability for authentication validation")
}

type listPage[T any] struct {
	Items      []T     `json:"items"`
	NextCursor *string `json:"nextCursor"`
}

func listAll[T any](ctx context.Context, c *Client, path string) ([]T, error) {
	var items []T
	cursor := ""
	for {
		pagedPath := path + "?limit=100"
		if cursor != "" {
			pagedPath += "&cursor=" + url.QueryEscape(cursor)
		}
		var page listPage[T]
		if err := c.do(ctx, http.MethodGet, pagedPath, nil, &page); err != nil {
			return nil, err
		}
		items = append(items, page.Items...)
		if page.NextCursor == nil || strings.TrimSpace(*page.NextCursor) == "" {
			return items, nil
		}
		cursor = *page.NextCursor
	}
}

func (c *Client) do(ctx context.Context, method, path string, body any, dest any) error {
	var reader io.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(payload)
	}
	parsed, err := url.Parse(c.baseURL.String() + path)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, method, parsed.String(), reader)
	if err != nil {
		return err
	}
	req.Header.Set("accept", "application/json")
	req.Header.Set("authorization", "Bearer "+c.apiKey)
	req.Header.Set("user-agent", userAgent)
	if body != nil {
		req.Header.Set("content-type", "application/json")
	}
	switch method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		req.Header.Set("idempotency-key", uuid.NewString())
	}
	c.applyTenancy(req)
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	payload, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode == http.StatusNotFound {
		return ErrNotFound
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var problem Problem
		if json.Unmarshal(payload, &problem) == nil && (problem.Detail != "" || problem.Title != "") {
			return problem
		}
		return fmt.Errorf("platform API %s %s returned HTTP %d", method, path, resp.StatusCode)
	}
	if dest == nil || resp.StatusCode == http.StatusNoContent || len(bytes.TrimSpace(payload)) == 0 {
		return nil
	}
	if err := json.Unmarshal(payload, dest); err != nil {
		return fmt.Errorf("decode platform API response: %w", err)
	}
	return nil
}

func (c *Client) applyTenancy(req *http.Request) {
	req.Header.Set("x-deployments-organization", c.tenancy.OrganizationID)
	req.Header.Set("x-deployments-project", c.tenancy.ProjectID)
	req.Header.Set("x-deployments-environment", c.tenancy.EnvironmentID)
}

func SameScopes(actual, expected []string) bool {
	if len(actual) != len(expected) {
		return false
	}
	wanted := make(map[string]struct{}, len(expected))
	for _, scope := range expected {
		wanted[scope] = struct{}{}
	}
	for _, scope := range actual {
		if _, ok := wanted[scope]; !ok {
			return false
		}
	}
	return true
}

func ActiveNamed[T interface {
	GetName() string
	GetStatus() string
}](items []T, name, label string) (T, bool, error) {
	return ActiveNamedScoped(items, name, label, nil)
}

func ActiveNamedScoped[T interface {
	GetName() string
	GetStatus() string
}](items []T, name, label string, scopes []string) (T, bool, error) {
	var zero T
	var matches []T
	for _, item := range items {
		if item.GetName() == name && item.GetStatus() == "active" {
			matches = append(matches, item)
		}
	}
	if len(matches) == 0 {
		return zero, false, nil
	}
	if len(matches) == 1 {
		return matches[0], true, nil
	}
	if len(scopes) == 0 {
		return zero, false, fmt.Errorf("multiple active %s named %q", label, name)
	}
	var scoped []T
	for _, item := range matches {
		account, ok := any(item).(interface{ GetScopes() []string })
		if !ok || !SameScopes(account.GetScopes(), scopes) {
			continue
		}
		scoped = append(scoped, item)
	}
	if len(scoped) == 1 {
		return scoped[0], true, nil
	}
	return zero, false, fmt.Errorf("multiple active %s named %q", label, name)
}

func (s ServiceAccount) GetName() string     { return s.Name }
func (s ServiceAccount) GetStatus() string   { return s.Status }
func (s ServiceAccount) GetScopes() []string { return s.Scopes }
func (c APICredential) GetName() string      { return c.Name }
func (c APICredential) GetStatus() string    { return c.Status }
