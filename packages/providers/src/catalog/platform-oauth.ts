import type { ProviderDefinitionInput } from "../provider-definitions.ts";
import { oauthScopesVerification, platformOauthDefinition } from "./shared.ts";

/** Platform-owned OAuth route for shop-specific Shopify installation and callbacks. */
export const PLATFORM_OAUTH_PROVIDER_DEFINITION_INPUTS: readonly ProviderDefinitionInput[] =
  Object.freeze([
    platformOauthDefinition({
      key: "shopify",
      oauthProviderKey: "shopify",
      displayName: "Shopify",
      category: "commerce",
      aliases: Object.freeze(["shopify_store"]),
      auth: Object.freeze({
        kind: "oauth",
        fields: Object.freeze([
          Object.freeze({
            key: "shopDomain",
            displayName: "Shop domain",
            sensitive: false,
            required: true,
            displayFormat: "none",
          }),
        ]),
      }),
      originPolicy: Object.freeze({ fieldKey: "shopDomain", requireHttps: true }),
      apiHosts: Object.freeze(["myshopify.com"]),
      authorizationScopes: Object.freeze([
        "read_customers",
        "read_inventory",
        "read_orders",
        "read_products",
        "write_fulfillments",
        "write_inventory",
      ]),
      defaultScopes: Object.freeze([
        "read_customers",
        "read_inventory",
        "read_orders",
        "read_products",
        "write_fulfillments",
        "write_inventory",
      ]),
      supportsMultipleAccounts: true,
      status: "configured",
      verification: oauthScopesVerification(
        "Validate the shop-specific install URL, callback HMAC, immutable HTTPS shop origin, and granted read scopes before enabling Shopify tools.",
      ),
      tools: Object.freeze([
        "shopify.products.search",
        "shopify.orders.search",
        "shopify.customers.search",
        "shopify.inventory_levels.list",
        "shopify.fulfillments.create",
        "shopify.inventory.adjust",
      ]),
    }),
  ]);
