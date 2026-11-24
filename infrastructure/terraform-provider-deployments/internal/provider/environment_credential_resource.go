package provider

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/setplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Agentifiers/deployments/infrastructure/terraform-provider-deployments/internal/client"
	"github.com/Agentifiers/deployments/infrastructure/terraform-provider-deployments/internal/secrets"
)

var credentialIDPattern = regexp.MustCompile(`^dpl_([0-7][0-9A-HJKMNP-TV-Z]{25})_`)

type environmentCredentialResource struct {
	client  *client.Client
	secrets secrets.Store
}

type environmentCredentialModel struct {
	APICredentialID  types.String `tfsdk:"api_credential_id"`
	ID               types.String `tfsdk:"id"`
	KeyPrefix        types.String `tfsdk:"key_prefix"`
	Name             types.String `tfsdk:"name"`
	Scopes           types.Set    `tfsdk:"scopes"`
	SecretARN        types.String `tfsdk:"secret_arn"`
	SecretName       types.String `tfsdk:"secret_name"`
	SecretVersionID  types.String `tfsdk:"secret_version_id"`
	ServiceAccountID types.String `tfsdk:"service_account_id"`
}

func NewEnvironmentCredentialResource() resource.Resource {
	return &environmentCredentialResource{}
}

func (r *environmentCredentialResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_environment_credential"
}

func (r *environmentCredentialResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Ensures one named service account and API credential, then writes the issued key to a Parameter Store SecureString parameter. OpenTofu state stores IDs only.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed: true,
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.UseStateForUnknown(),
				},
			},
			"name": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Service account and API credential name.",
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.RequiresReplace(),
				},
			},
			"scopes": schema.SetAttribute{
				ElementType:         types.StringType,
				Required:            true,
				MarkdownDescription: "Least-privilege capability scopes. Changing scopes replaces the credential.",
				PlanModifiers: []planmodifier.Set{
					setplanmodifier.RequiresReplace(),
				},
			},
			"secret_name": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Parameter Store parameter name, such as /app/platform-api-key, that receives the API key as a SecureString. The provider creates it when it is missing.",
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.RequiresReplace(),
				},
			},
			"api_credential_id": schema.StringAttribute{
				Computed: true,
			},
			"key_prefix": schema.StringAttribute{
				Computed: true,
			},
			"secret_arn": schema.StringAttribute{
				Computed: true,
			},
			"secret_version_id": schema.StringAttribute{
				Computed: true,
			},
			"service_account_id": schema.StringAttribute{
				Computed: true,
			},
		},
	}
}

func (r *environmentCredentialResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	if req.ProviderData == nil {
		return
	}
	data, ok := req.ProviderData.(*configured)
	if !ok {
		resp.Diagnostics.AddError("Unexpected provider data", "The deployments provider did not configure an environment credential client.")
		return
	}
	r.client = data.Client
	r.secrets = data.Secrets
}

func (r *environmentCredentialResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan environmentCredentialModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	state, err := r.reconcile(ctx, plan)
	if err != nil {
		resp.Diagnostics.AddError("Create environment credential", err.Error())
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *environmentCredentialResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state environmentCredentialModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	// Earlier releases wrote the key to a Secrets Manager secret, whose name is not a parameter
	// path. Forgetting the resource, rather than replacing it, keeps the live key: the next
	// create finds the key the operator copied to the new parameter and adopts it.
	if !strings.HasPrefix(state.SecretName.ValueString(), "/") {
		resp.State.RemoveResource(ctx)
		return
	}
	credential, err := r.client.GetAPICredential(ctx, state.APICredentialID.ValueString())
	if errors.Is(err, client.ErrNotFound) {
		resp.State.RemoveResource(ctx)
		return
	}
	if err != nil {
		resp.Diagnostics.AddError("Read environment credential", err.Error())
		return
	}
	if credential.Status != "active" {
		resp.State.RemoveResource(ctx)
		return
	}
	record, err := r.secrets.Get(ctx, state.SecretName.ValueString())
	if errors.Is(err, secrets.ErrNotFound) {
		resp.State.RemoveResource(ctx)
		return
	}
	if err != nil {
		resp.Diagnostics.AddError("Read environment credential secret", err.Error())
		return
	}
	state.KeyPrefix = types.StringValue(credential.KeyPrefix)
	state.SecretARN = types.StringValue(record.ARN)
	state.SecretVersionID = types.StringValue(record.Version)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *environmentCredentialResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	resp.Diagnostics.AddError("Update not supported", "Environment credentials are replaced when name, scopes, or secret_name change.")
}

func (r *environmentCredentialResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state environmentCredentialModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	err := r.client.RevokeAPICredential(ctx, state.APICredentialID.ValueString())
	if err != nil && !errors.Is(err, client.ErrNotFound) {
		resp.Diagnostics.AddError("Revoke environment credential", err.Error())
	}
}

func (r *environmentCredentialResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	parts := strings.Split(req.ID, ",")
	if len(parts) != 3 {
		resp.Diagnostics.AddError("Invalid import ID", "Use service_account_id,api_credential_id,secret_name.")
		return
	}
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("service_account_id"), parts[0])...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("api_credential_id"), parts[1])...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("secret_name"), parts[2])...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), parts[0]+"/"+parts[1])...)
}

func (r *environmentCredentialResource) reconcile(ctx context.Context, plan environmentCredentialModel) (environmentCredentialModel, error) {
	scopes, err := setValues(plan.Scopes)
	if err != nil {
		return environmentCredentialModel{}, err
	}
	name := plan.Name.ValueString()
	accounts, err := r.client.ListServiceAccounts(ctx)
	if err != nil {
		return environmentCredentialModel{}, err
	}
	account, found, err := client.ActiveNamedScoped(accounts, name, "service accounts", scopes)
	if err != nil {
		return environmentCredentialModel{}, err
	}
	if found && !client.SameScopes(account.Scopes, scopes) {
		return environmentCredentialModel{}, fmt.Errorf("managed service account %q has unexpected scopes; refusing to widen it", name)
	}
	if !found {
		account, err = r.client.CreateServiceAccount(ctx, name, scopes)
		if err != nil {
			return environmentCredentialModel{}, err
		}
	}

	secretName := plan.SecretName.ValueString()
	record, err := r.secrets.Get(ctx, secretName)
	if err != nil && !errors.Is(err, secrets.ErrNotFound) {
		return environmentCredentialModel{}, err
	}

	if credentialID := credentialIDFromSecret(record.Value); credentialID != "" {
		credential, getErr := r.client.GetAPICredential(ctx, credentialID)
		if getErr == nil && credential.Status == "active" && credential.ServiceAccountID == account.ID && credential.Name == name {
			if !client.SameScopes(credential.Scopes, scopes) {
				return environmentCredentialModel{}, fmt.Errorf("installed API credential %s has unexpected scopes; refusing to widen it", credential.ID)
			}
			return modelFrom(plan, account, credential, record), nil
		}
		if getErr != nil && !errors.Is(getErr, client.ErrNotFound) {
			return environmentCredentialModel{}, getErr
		}
	}

	issued, err := r.client.CreateAPICredential(ctx, name, account.ID, scopes)
	if err != nil {
		return environmentCredentialModel{}, err
	}
	if strings.TrimSpace(issued.Secret) == "" {
		return environmentCredentialModel{}, fmt.Errorf("platform API did not return a one-time credential secret")
	}
	if err := r.client.Probe(ctx, issued.Secret, scopes); err != nil {
		return environmentCredentialModel{}, err
	}
	written, err := r.secrets.Put(ctx, secretName, issued.Secret)
	if err != nil {
		return environmentCredentialModel{}, err
	}
	issued.Secret = ""
	return modelFrom(plan, account, issued, written), nil
}

func modelFrom(plan environmentCredentialModel, account client.ServiceAccount, credential client.APICredential, record secrets.Record) environmentCredentialModel {
	return environmentCredentialModel{
		APICredentialID:  types.StringValue(credential.ID),
		ID:               types.StringValue(account.ID + "/" + credential.ID),
		KeyPrefix:        types.StringValue(credential.KeyPrefix),
		Name:             plan.Name,
		Scopes:           plan.Scopes,
		SecretARN:        types.StringValue(record.ARN),
		SecretName:       plan.SecretName,
		SecretVersionID:  types.StringValue(record.Version),
		ServiceAccountID: types.StringValue(account.ID),
	}
}

func credentialIDFromSecret(value string) string {
	match := credentialIDPattern.FindStringSubmatch(strings.TrimSpace(value))
	if len(match) != 2 {
		return ""
	}
	return match[1]
}

func setValues(value types.Set) ([]string, error) {
	if value.IsNull() || value.IsUnknown() {
		return nil, fmt.Errorf("scopes are required")
	}
	var scopes []string
	for _, element := range value.Elements() {
		str, ok := element.(types.String)
		if !ok {
			return nil, fmt.Errorf("scopes must be strings")
		}
		scopes = append(scopes, str.ValueString())
	}
	return scopes, nil
}
