package provider

import (
	"context"
	"os"
	"strings"

	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/provider"
	"github.com/hashicorp/terraform-plugin-framework/provider/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Agentifiers/deployments/infrastructure/terraform-provider-deployments/internal/client"
	"github.com/Agentifiers/deployments/infrastructure/terraform-provider-deployments/internal/secrets"
)

const defaultAPIURL = "https://api.us.deployments.ai"

type deploymentsProvider struct {
	version string
	secrets secrets.Store
}

type providerModel struct {
	APIKey         types.String `tfsdk:"api_key"`
	APIURL         types.String `tfsdk:"api_url"`
	AWSRegion      types.String `tfsdk:"aws_region"`
	EnvironmentID  types.String `tfsdk:"environment_id"`
	OrganizationID types.String `tfsdk:"organization_id"`
	ProjectID      types.String `tfsdk:"project_id"`
}

type configured struct {
	Client  *client.Client
	Secrets secrets.Store
}

func New(version string) func() provider.Provider {
	return func() provider.Provider {
		return &deploymentsProvider{version: version}
	}
}

func NewWithSecrets(version string, store secrets.Store) func() provider.Provider {
	return func() provider.Provider {
		return &deploymentsProvider{version: version, secrets: store}
	}
}

func (p *deploymentsProvider) Metadata(_ context.Context, _ provider.MetadataRequest, resp *provider.MetadataResponse) {
	resp.TypeName = "deployments"
	resp.Version = p.version
}

func (p *deploymentsProvider) Schema(_ context.Context, _ provider.SchemaRequest, resp *provider.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Issues Deployments.ai environment credentials and writes the key to an AWS Parameter Store SecureString parameter. The secret value never enters OpenTofu state.",
		Attributes: map[string]schema.Attribute{
			"api_key": schema.StringAttribute{
				Optional:            true,
				Sensitive:           true,
				MarkdownDescription: "Operator API key. Defaults to DEPLOYMENTS_API_KEY.",
			},
			"api_url": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "Platform API origin. Defaults to DEPLOYMENTS_API_URL or https://api.us.deployments.ai.",
			},
			"aws_region": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "AWS region for the Parameter Store parameter. Defaults to AWS_REGION or us-east-2.",
			},
			"environment_id": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "Tenancy environment. Defaults to DEPLOYMENTS_ENVIRONMENT_ID or DEPLOYMENTS_ENVIRONMENT.",
			},
			"organization_id": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "Tenancy organization. Defaults to DEPLOYMENTS_ORGANIZATION_ID or DEPLOYMENTS_ORG.",
			},
			"project_id": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "Tenancy project. Defaults to DEPLOYMENTS_PROJECT_ID or DEPLOYMENTS_PROJECT.",
			},
		},
	}
}

func (p *deploymentsProvider) Configure(ctx context.Context, req provider.ConfigureRequest, resp *provider.ConfigureResponse) {
	var config providerModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &config)...)
	if resp.Diagnostics.HasError() {
		return
	}

	apiKey := firstNonEmpty(config.APIKey.ValueString(), os.Getenv("DEPLOYMENTS_API_KEY"))
	apiURL := firstNonEmpty(config.APIURL.ValueString(), os.Getenv("DEPLOYMENTS_API_URL"), defaultAPIURL)
	region := firstNonEmpty(config.AWSRegion.ValueString(), os.Getenv("AWS_REGION"), os.Getenv("AWS_DEFAULT_REGION"), "us-east-2")
	tenancy := client.Tenancy{
		OrganizationID: firstNonEmpty(config.OrganizationID.ValueString(), os.Getenv("DEPLOYMENTS_ORGANIZATION_ID"), os.Getenv("DEPLOYMENTS_ORG")),
		ProjectID:      firstNonEmpty(config.ProjectID.ValueString(), os.Getenv("DEPLOYMENTS_PROJECT_ID"), os.Getenv("DEPLOYMENTS_PROJECT")),
		EnvironmentID:  firstNonEmpty(config.EnvironmentID.ValueString(), os.Getenv("DEPLOYMENTS_ENVIRONMENT_ID"), os.Getenv("DEPLOYMENTS_ENVIRONMENT")),
	}
	if apiKey == "" {
		resp.Diagnostics.AddError("Missing operator API key", "Set provider.api_key or DEPLOYMENTS_API_KEY.")
	}
	if tenancy.OrganizationID == "" || tenancy.ProjectID == "" || tenancy.EnvironmentID == "" {
		resp.Diagnostics.AddError(
			"Missing tenancy",
			"Set provider organization_id, project_id, and environment_id, or the matching DEPLOYMENTS_* environment variables.",
		)
	}
	if resp.Diagnostics.HasError() {
		return
	}

	api, err := client.New(apiURL, apiKey, tenancy, nil)
	if err != nil {
		resp.Diagnostics.AddError("Invalid platform API URL", err.Error())
		return
	}
	store := p.secrets
	if store == nil {
		store, err = secrets.NewAWS(ctx, region)
		if err != nil {
			resp.Diagnostics.AddError("AWS configuration", err.Error())
			return
		}
	}
	data := &configured{Client: api, Secrets: store}
	resp.ResourceData = data
}

func (p *deploymentsProvider) Resources(_ context.Context) []func() resource.Resource {
	return []func() resource.Resource{NewEnvironmentCredentialResource}
}

func (p *deploymentsProvider) DataSources(_ context.Context) []func() datasource.DataSource {
	return nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}
