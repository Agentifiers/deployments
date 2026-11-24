import {
  jsonProviderNativeBody,
  optionalToolString,
  requirePositiveLimit,
  requireProviderBaseUrl,
  requireToolString,
  type ProviderAccessToken,
  type ProviderNativeHttpToolDefinition,
} from "../core.ts";
import { requiredObject } from "../tool-input-guards.ts";

const SHOPIFY_PRODUCT_READ_SCOPES = ["read_products"] as const;
const SHOPIFY_ORDER_READ_SCOPES = ["read_orders"] as const;
const SHOPIFY_CUSTOMER_READ_SCOPES = ["read_customers"] as const;
const SHOPIFY_INVENTORY_READ_SCOPES = ["read_inventory"] as const;
const SHOPIFY_FULFILLMENT_WRITE_SCOPES = ["write_fulfillments"] as const;
const SHOPIFY_INVENTORY_WRITE_SCOPES = ["write_inventory"] as const;

function shopifyGraphqlUrl(input: Record<string, unknown>): string {
  const shopUrl = requireProviderBaseUrl(input, "oauthResource", "shopify");
  const version = optionalToolString(input, "apiVersion") ?? "2026-07";
  if (!/^\d{4}-\d{2}$/u.test(version))
    throw new Error("Tool input apiVersion must use YYYY-MM format");
  return new URL(`/admin/api/${version}/graphql.json`, shopUrl).toString();
}

function shopifyHeaders(_input: Record<string, unknown>, token: ProviderAccessToken) {
  return { authorization: undefined, "x-shopify-access-token": token.token };
}

function shopifyReadBody(query: string, input: Record<string, unknown>) {
  return jsonProviderNativeBody({
    query,
    variables: {
      first: requirePositiveLimit(input, "limit", 25, 100),
      ...(optionalToolString(input, "query") ? { query: optionalToolString(input, "query") } : {}),
      ...(optionalToolString(input, "after") ? { after: optionalToolString(input, "after") } : {}),
      ...(optionalToolString(input, "id") ? { id: optionalToolString(input, "id") } : {}),
    },
  });
}

export const shopifyNativeHttpToolDefinitions: readonly ProviderNativeHttpToolDefinition[] = [
  {
    toolName: "shopify.products.search",
    description: "Search Shopify products and inventory summaries.",
    effect: "read",
    provider: "shopify",
    requiredScopes: SHOPIFY_PRODUCT_READ_SCOPES,
    defaultPolicyAction: "allow",
    method: "POST",
    filePrefix: "shopify-products-search",
    buildUrl: shopifyGraphqlUrl,
    buildBody: (input) =>
      shopifyReadBody(
        "query Products($first: Int!, $query: String, $after: String) { products(first: $first, query: $query, after: $after) { nodes { id title handle status totalInventory updatedAt vendor productType } pageInfo { hasNextPage endCursor } } }",
        input,
      ),
    buildHeaders: shopifyHeaders,
  },
  {
    toolName: "shopify.orders.search",
    description: "Search Shopify orders and fulfillment state.",
    effect: "read",
    provider: "shopify",
    requiredScopes: SHOPIFY_ORDER_READ_SCOPES,
    defaultPolicyAction: "allow",
    method: "POST",
    filePrefix: "shopify-orders-search",
    buildUrl: shopifyGraphqlUrl,
    buildBody: (input) =>
      shopifyReadBody(
        "query Orders($first: Int!, $query: String, $after: String) { orders(first: $first, query: $query, after: $after) { nodes { id name createdAt updatedAt displayFinancialStatus displayFulfillmentStatus totalPriceSet { shopMoney { amount currencyCode } } customer { id displayName email } } pageInfo { hasNextPage endCursor } } }",
        input,
      ),
    buildHeaders: shopifyHeaders,
  },
  {
    toolName: "shopify.customers.search",
    description: "Search Shopify customers and account history.",
    effect: "read",
    provider: "shopify",
    requiredScopes: SHOPIFY_CUSTOMER_READ_SCOPES,
    defaultPolicyAction: "allow",
    method: "POST",
    filePrefix: "shopify-customers-search",
    buildUrl: shopifyGraphqlUrl,
    buildBody: (input) =>
      shopifyReadBody(
        "query Customers($first: Int!, $query: String, $after: String) { customers(first: $first, query: $query, after: $after) { nodes { id displayName email phone state numberOfOrders createdAt updatedAt amountSpent { amount currencyCode } } pageInfo { hasNextPage endCursor } } }",
        input,
      ),
    buildHeaders: shopifyHeaders,
  },
  {
    toolName: "shopify.inventory_levels.list",
    description: "Read Shopify inventory levels for a location.",
    effect: "read",
    provider: "shopify",
    requiredScopes: SHOPIFY_INVENTORY_READ_SCOPES,
    defaultPolicyAction: "allow",
    method: "POST",
    filePrefix: "shopify-inventory-levels-list",
    buildUrl: shopifyGraphqlUrl,
    buildBody: (input) =>
      shopifyReadBody(
        'query InventoryLevels($id: ID!, $first: Int!, $after: String) { location(id: $id) { id name inventoryLevels(first: $first, after: $after) { nodes { id quantities(names: ["available", "committed", "incoming", "on_hand"]) { name quantity } item { id sku tracked } } pageInfo { hasNextPage endCursor } } } }',
        { ...input, id: requireToolString(input, "locationId") },
      ),
    buildHeaders: shopifyHeaders,
  },
  {
    toolName: "shopify.fulfillments.create",
    description: "Create a Shopify fulfillment after approval.",
    effect: "write",
    provider: "shopify",
    requiredScopes: SHOPIFY_FULFILLMENT_WRITE_SCOPES,
    defaultPolicyAction: "require_approval",
    method: "POST",
    filePrefix: "shopify-fulfillment-create",
    buildUrl: shopifyGraphqlUrl,
    buildBody: (input) =>
      jsonProviderNativeBody({
        query:
          "mutation FulfillmentCreate($fulfillment: FulfillmentInput!, $message: String) { fulfillmentCreate(fulfillment: $fulfillment, message: $message) { fulfillment { id status createdAt } userErrors { field message } } }",
        variables: requiredObject(input, "variables"),
      }),
    buildHeaders: shopifyHeaders,
  },
  {
    toolName: "shopify.inventory.adjust",
    description: "Adjust Shopify inventory quantities after approval.",
    effect: "write",
    provider: "shopify",
    requiredScopes: SHOPIFY_INVENTORY_WRITE_SCOPES,
    defaultPolicyAction: "require_approval",
    method: "POST",
    filePrefix: "shopify-inventory-adjust",
    buildUrl: shopifyGraphqlUrl,
    buildBody: (input) =>
      jsonProviderNativeBody({
        query:
          "mutation InventoryAdjust($input: InventoryAdjustQuantitiesInput!) { inventoryAdjustQuantities(input: $input) { inventoryAdjustmentGroup { createdAt reason referenceDocumentUri changes { name delta } } userErrors { field message } } }",
        variables: requiredObject(input, "variables"),
      }),
    buildHeaders: shopifyHeaders,
  },
];
