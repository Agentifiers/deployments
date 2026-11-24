import {
  appendNativeQueryFields,
  encodedPath,
  jsonProviderNativeBody,
  optionalToolBoolean,
  optionalToolNumber,
  optionalToolObject,
  optionalToolString,
  quickbooksRequestId,
  requirePositiveLimit,
  requireToolString,
  type ProviderNativeBody,
  type ProviderNativeHttpToolDefinition,
} from "../core.ts";

const GENERIC_READ_SCOPES = ["read"] as const;
const GENERIC_WRITE_SCOPES = ["write"] as const;

function setBodyField(body: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined || value === null || value === "") return;
  body[key] = value;
}

function quickbooksCustomerQuery(input: Record<string, unknown>): string {
  const explicitQuery = optionalToolString(input, "query");
  if (explicitQuery) return explicitQuery;
  const searchTerm = optionalToolString(input, "name");
  const maxResults = requirePositiveLimit(input, "limit", 25, 100);
  const escapedSearchTerm = searchTerm?.replace(/'/gu, "''");
  return [
    "SELECT * FROM Customer",
    escapedSearchTerm ? `WHERE DisplayName LIKE '%${escapedSearchTerm}%'` : undefined,
    `MAXRESULTS ${maxResults}`,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" ");
}

function quickbooksReference(
  value: string,
  name: string | undefined,
): { name?: string; value: string } {
  return {
    ...(name ? { name } : {}),
    value,
  };
}

function quickbooksInvoiceFromInput(
  input: Record<string, unknown>,
): Record<string, unknown> | null {
  const customerId =
    optionalToolString(input, "customerId") ?? optionalToolString(input, "customerRef");
  const amount = optionalToolNumber(input, "amount") ?? optionalToolNumber(input, "lineAmount");
  if (!customerId || amount === undefined) return null;
  const itemId = optionalToolString(input, "itemId") ?? optionalToolString(input, "itemRef");
  const itemName = optionalToolString(input, "itemName");
  const detail: Record<string, unknown> = {};
  if (itemId) detail.ItemRef = quickbooksReference(itemId, itemName);
  setBodyField(detail, "Qty", optionalToolNumber(input, "quantity"));
  setBodyField(detail, "UnitPrice", optionalToolNumber(input, "unitPrice"));
  setBodyField(detail, "ServiceDate", optionalToolString(input, "serviceDate"));

  const line: Record<string, unknown> = {
    Amount: amount,
    DetailType: "SalesItemLineDetail",
  };
  setBodyField(line, "Description", optionalToolString(input, "description"));
  if (Object.keys(detail).length > 0) line.SalesItemLineDetail = detail;

  const invoice: Record<string, unknown> = {
    CustomerRef: quickbooksReference(customerId, optionalToolString(input, "customerName")),
    Line: [line],
  };
  setBodyField(
    invoice,
    "BillEmail",
    optionalToolString(input, "billEmail")
      ? { Address: optionalToolString(input, "billEmail") }
      : undefined,
  );
  setBodyField(
    invoice,
    "CustomerMemo",
    optionalToolString(input, "customerMemo")
      ? { value: optionalToolString(input, "customerMemo") }
      : undefined,
  );
  setBodyField(invoice, "DocNumber", optionalToolString(input, "docNumber"));
  setBodyField(invoice, "DueDate", optionalToolString(input, "dueDate"));
  setBodyField(invoice, "PrivateNote", optionalToolString(input, "privateNote"));
  return invoice;
}

function quickbooksInvoiceCreateBody(input: Record<string, unknown>): ProviderNativeBody {
  const invoice = optionalToolObject(input, "invoice") ?? quickbooksInvoiceFromInput(input);
  if (!invoice) {
    throw new Error("Tool input invoice or customerId plus amount is required");
  }
  return jsonProviderNativeBody(invoice);
}

export const quickbooksNativeHttpToolDefinitions: readonly ProviderNativeHttpToolDefinition[] = [
  {
    toolName: "quickbooks.reports.read",
    description: "Read QuickBooks reports for reconciliation and finance review.",
    effect: "read",
    provider: "quickbooks",
    requiredScopes: GENERIC_READ_SCOPES,
    defaultPolicyAction: "allow",
    method: "GET",
    filePrefix: "quickbooks-report",
    buildUrl(input) {
      const sandbox = optionalToolBoolean(input, "sandbox") ?? false;
      const url = new URL(
        `https://${sandbox ? "sandbox-" : ""}quickbooks.api.intuit.com/v3/company/${encodeURIComponent(
          requireToolString(input, "companyId"),
        )}/reports/${encodedPath(optionalToolString(input, "reportName") ?? "ProfitAndLoss")}`,
      );
      url.searchParams.set("minorversion", optionalToolString(input, "minorVersion") ?? "75");
      appendNativeQueryFields(url, input, [
        "start_date",
        "end_date",
        "accounting_method",
        "summarize_column_by",
      ]);
      return url.toString();
    },
  },
  {
    toolName: "quickbooks.customers.search",
    description: "Search QuickBooks customers so invoice handoffs can resolve customer ids.",
    effect: "read",
    provider: "quickbooks",
    requiredScopes: GENERIC_READ_SCOPES,
    defaultPolicyAction: "allow",
    method: "GET",
    filePrefix: "quickbooks-customers-search",
    buildUrl(input) {
      const sandbox = optionalToolBoolean(input, "sandbox") ?? false;
      const url = new URL(
        `https://${sandbox ? "sandbox-" : ""}quickbooks.api.intuit.com/v3/company/${encodeURIComponent(
          requireToolString(input, "companyId"),
        )}/query`,
      );
      url.searchParams.set("minorversion", optionalToolString(input, "minorVersion") ?? "75");
      url.searchParams.set("query", quickbooksCustomerQuery(input));
      return url.toString();
    },
  },
  {
    toolName: "quickbooks.invoice.create",
    description: "Create a QuickBooks invoice after finance approval.",
    effect: "write",
    provider: "quickbooks",
    requiredScopes: GENERIC_WRITE_SCOPES,
    defaultPolicyAction: "require_approval",
    method: "POST",
    filePrefix: "quickbooks-invoice-create",
    buildUrl(input, _token, request) {
      const sandbox = optionalToolBoolean(input, "sandbox") ?? false;
      const url = new URL(
        `https://${sandbox ? "sandbox-" : ""}quickbooks.api.intuit.com/v3/company/${encodeURIComponent(
          requireToolString(input, "companyId"),
        )}/invoice`,
      );
      url.searchParams.set("minorversion", optionalToolString(input, "minorVersion") ?? "75");
      url.searchParams.set("requestid", quickbooksRequestId(request.idempotencyKey));
      return url.toString();
    },
    buildBody: quickbooksInvoiceCreateBody,
  },
];
