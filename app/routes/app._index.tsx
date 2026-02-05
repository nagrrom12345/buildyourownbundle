import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

type Money = {
  amount: string;
  currencyCode: string;
};

type CustomerNode = {
  id: string;
  displayName: string | null;
  email: string | null;
  numberOfOrders: number | null;
  amountSpent: Money | null;
  orders?: {
    nodes?: Array<{
      createdAt?: string | null;
    }>;
  } | null;
};

type LoaderData = {
  range: {
    start: string;
    end: string;
  };
  customerLookup: {
    query: string;
    result:
      | {
          id: string;
          name: string;
          email: string;
          totalSpent: number;
          ordersCount: number;
          firstOrderDate: string | null;
          referrerChannel: string;
          referrerUrl: string | null;
          utmSummary: string | null;
        }
      | null;
  };
  totals: {
    customers: number;
    totalClv: number;
    averageClv: number;
    currencyCode: string;
  };
  topCustomers: Array<{
    id: string;
    name: string;
    email: string;
    totalSpent: number;
    ordersCount: number;
  }>;
  newCustomers: Array<{
    id: string;
    name: string;
    email: string;
    firstOrderDate: string;
    totalSpent: number;
    ordersCount: number;
  }>;
  notes: {
    customersTruncated: boolean;
    ordersTruncated: boolean;
    usedNewCustomerFallback: boolean;
  };
};

const DEFAULT_RANGE_DAYS = 30;
const PAGE_SIZE = 250;
const MAX_CUSTOMERS = 2000;
const MAX_ORDERS = 2000;

const toDateInput = (date: Date) => date.toISOString().slice(0, 10);

const parseDateParam = (value: string | null, fallback: Date) => {
  if (!value) return fallback;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
};

const getDateRange = (url: URL) => {
  const today = new Date();
  const endDefault = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
  );
  const startDefault = new Date(endDefault);
  startDefault.setUTCDate(startDefault.getUTCDate() - (DEFAULT_RANGE_DAYS - 1));

  const startDate = parseDateParam(url.searchParams.get("start"), startDefault);
  const endDate = parseDateParam(url.searchParams.get("end"), endDefault);

  const normalizedStart = new Date(
    Date.UTC(
      startDate.getUTCFullYear(),
      startDate.getUTCMonth(),
      startDate.getUTCDate(),
      0,
      0,
      0,
    ),
  );
  const normalizedEnd = new Date(
    Date.UTC(
      endDate.getUTCFullYear(),
      endDate.getUTCMonth(),
      endDate.getUTCDate(),
      23,
      59,
      59,
    ),
  );

  if (normalizedStart > normalizedEnd) {
    return {
      start: startDefault,
      end: endDefault,
    };
  }

  return { start: normalizedStart, end: normalizedEnd };
};

const formatCurrency = (value: number, currencyCode: string) => {
  if (!Number.isFinite(value)) return "-";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currencyCode || "USD",
    maximumFractionDigits: 2,
  }).format(value);
};

const formatUtm = (utm?: {
  source?: string | null;
  medium?: string | null;
  campaign?: string | null;
  term?: string | null;
  content?: string | null;
} | null) => {
  if (!utm) return null;
  const parts = [
    utm.source ? `source=${utm.source}` : null,
    utm.medium ? `medium=${utm.medium}` : null,
    utm.campaign ? `campaign=${utm.campaign}` : null,
    utm.term ? `term=${utm.term}` : null,
    utm.content ? `content=${utm.content}` : null,
  ].filter(Boolean);

  return parts.length ? parts.join(", ") : null;
};

const formatReferrerChannel = (visit?: {
  source?: string | null;
  sourceType?: string | null;
  sourceDescription?: string | null;
  referrerUrl?: string | null;
  landingPage?: string | null;
  utmParameters?: {
    source?: string | null;
    medium?: string | null;
    campaign?: string | null;
    term?: string | null;
    content?: string | null;
  } | null;
} | null) => {
  if (!visit) return "Unknown";

  if (visit.utmParameters?.source || visit.utmParameters?.medium) {
    const utm = formatUtm(visit.utmParameters);
    return utm ? `UTM (${utm})` : "UTM";
  }

  if (visit.source) {
    const description = visit.sourceDescription
      ? ` - ${visit.sourceDescription}`
      : "";
    return `${visit.source}${description}`;
  }

  if (visit.referrerUrl) {
    try {
      return new URL(visit.referrerUrl).hostname;
    } catch {
      return visit.referrerUrl;
    }
  }

  return "Unknown";
};

const insertTopCustomer = (
  list: LoaderData["topCustomers"],
  customer: LoaderData["topCustomers"][number],
) => {
  const next = [...list, customer].sort((a, b) => b.totalSpent - a.totalSpent);
  return next.slice(0, 10);
};

const fetchAllCustomers = async (admin: any) => {
  let hasNextPage = true;
  let after: string | null = null;
  let customersCount = 0;
  let totalClv = 0;
  let topCustomers: LoaderData["topCustomers"] = [];
  let currencyCode = "USD";
  let truncated = false;

  while (hasNextPage && customersCount < MAX_CUSTOMERS) {
    const response = await admin.graphql(
      `#graphql
        query Customers($first: Int!, $after: String) {
          customers(first: $first, after: $after) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              displayName
              email
              numberOfOrders
              amountSpent {
                amount
                currencyCode
              }
            }
          }
        }`,
      {
        variables: {
          first: PAGE_SIZE,
          after,
        },
      },
    );

    const json = await response.json();
    if (json.errors) {
      throw new Error(JSON.stringify(json.errors));
    }

    const customers = json.data.customers.nodes as CustomerNode[];
    for (const customer of customers) {
      const amount = Number(customer.amountSpent?.amount || 0);
      const ordersCount = customer.numberOfOrders || 0;
      const name = customer.displayName || customer.email || "Unknown";
      const email = customer.email || "-";

      if (customer.amountSpent?.currencyCode) {
        currencyCode = customer.amountSpent.currencyCode;
      }

      customersCount += 1;
      totalClv += amount;

      topCustomers = insertTopCustomer(topCustomers, {
        id: customer.id,
        name,
        email,
        totalSpent: amount,
        ordersCount,
      });
    }

    hasNextPage = json.data.customers.pageInfo.hasNextPage;
    after = json.data.customers.pageInfo.endCursor;

    if (customersCount >= MAX_CUSTOMERS && hasNextPage) {
      truncated = true;
    }
  }

  return {
    customersCount,
    totalClv,
    averageClv: customersCount ? totalClv / customersCount : 0,
    currencyCode,
    topCustomers,
    truncated,
  };
};

const fetchCustomerLookup = async (admin: any, email: string) => {
  const response = await admin.graphql(
    `#graphql
      query CustomerLookup($first: Int!, $query: String!) {
        customers(first: $first, query: $query) {
          nodes {
            id
            displayName
            email
            numberOfOrders
            amountSpent {
              amount
              currencyCode
            }
            orders(first: 1, sortKey: CREATED_AT) {
              nodes {
                createdAt
                customerJourneySummary {
                  firstVisit {
                    source
                    sourceType
                    sourceDescription
                    referrerUrl
                    landingPage
                    utmParameters {
                      source
                      medium
                      campaign
                      term
                      content
                    }
                  }
                }
              }
            }
          }
        }
      }`,
    {
      variables: {
        first: 1,
        query: `email:${email}`,
      },
    },
  );

  const json = await response.json();
  if (json.errors) {
    throw new Error(JSON.stringify(json.errors));
  }

  const customer = (json.data.customers.nodes as CustomerNode[])[0];
  if (!customer) return null;

  const name = customer.displayName || customer.email || "Unknown";
  const totalSpent = Number(customer.amountSpent?.amount || 0);
  const ordersCount = customer.numberOfOrders || 0;
  const firstOrder = customer.orders?.nodes?.[0] || null;
  const visit = firstOrder?.customerJourneySummary?.firstVisit || null;

  return {
    id: customer.id,
    name,
    email: customer.email || "-",
    totalSpent,
    ordersCount,
    firstOrderDate: firstOrder?.createdAt || null,
    referrerChannel: formatReferrerChannel(visit),
    referrerUrl: visit?.referrerUrl || null,
    utmSummary: formatUtm(visit?.utmParameters || null),
  };
};

const fetchOrdersInRange = async (
  admin: any,
  start: Date,
  end: Date,
) => {
  let hasNextPage = true;
  let after: string | null = null;
  let ordersCount = 0;
  let truncated = false;
  let usedFallback = false;

  const newCustomersMap = new Map<string, LoaderData["newCustomers"][number]>();

  const query = `created_at:>=${start.toISOString()} created_at:<=${end.toISOString()}`;

  while (hasNextPage && ordersCount < MAX_ORDERS) {
    const response = await admin.graphql(
      `#graphql
        query OrdersInRange($first: Int!, $after: String, $query: String!) {
          orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              createdAt
              customer {
                id
                displayName
                email
                numberOfOrders
                amountSpent {
                  amount
                  currencyCode
                }
                orders(first: 1, sortKey: CREATED_AT) {
                  nodes {
                    createdAt
                  }
                }
              }
            }
          }
        }`,
      {
        variables: {
          first: PAGE_SIZE,
          after,
          query,
        },
      },
    );

    const json = await response.json();
    if (json.errors) {
      throw new Error(JSON.stringify(json.errors));
    }

    const orders = json.data.orders.nodes as Array<{
      createdAt: string;
      customer: CustomerNode | null;
    }>;

    for (const order of orders) {
      ordersCount += 1;
      const customer = order.customer;
      if (!customer?.id) continue;

      const amount = Number(customer.amountSpent?.amount || 0);
      const ordersCountCustomer = customer.numberOfOrders || 0;
      const name = customer.displayName || customer.email || "Unknown";
      const email = customer.email || "-";

      const firstOrderDateRaw =
        customer.orders?.nodes?.[0]?.createdAt || null;

      let isNewCustomer = false;
      let firstOrderDate = firstOrderDateRaw || "";

      if (firstOrderDateRaw) {
        const firstOrder = new Date(firstOrderDateRaw);
        isNewCustomer = firstOrder >= start && firstOrder <= end;
      } else if (ordersCountCustomer === 1) {
        usedFallback = true;
        isNewCustomer = true;
        firstOrderDate = order.createdAt;
      }

      if (!isNewCustomer) continue;

      if (!newCustomersMap.has(customer.id)) {
        newCustomersMap.set(customer.id, {
          id: customer.id,
          name,
          email,
          firstOrderDate: firstOrderDate || order.createdAt,
          totalSpent: amount,
          ordersCount: ordersCountCustomer,
        });
      }
    }

    hasNextPage = json.data.orders.pageInfo.hasNextPage;
    after = json.data.orders.pageInfo.endCursor;

    if (ordersCount >= MAX_ORDERS && hasNextPage) {
      truncated = true;
    }
  }

  return {
    newCustomers: Array.from(newCustomersMap.values()).sort((a, b) =>
      a.firstOrderDate.localeCompare(b.firstOrderDate),
    ),
    truncated,
    usedFallback,
  };
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const { start, end } = getDateRange(url);
  const lookupEmail = url.searchParams.get("customer_email")?.trim() || "";

  const customerSummary = await fetchAllCustomers(admin);
  const ordersSummary = await fetchOrdersInRange(admin, start, end);
  const lookupResult = lookupEmail
    ? await fetchCustomerLookup(admin, lookupEmail)
    : null;

  const data: LoaderData = {
    range: {
      start: toDateInput(start),
      end: toDateInput(end),
    },
    customerLookup: {
      query: lookupEmail,
      result: lookupResult,
    },
    totals: {
      customers: customerSummary.customersCount,
      totalClv: customerSummary.totalClv,
      averageClv: customerSummary.averageClv,
      currencyCode: customerSummary.currencyCode,
    },
    topCustomers: customerSummary.topCustomers,
    newCustomers: ordersSummary.newCustomers,
    notes: {
      customersTruncated: customerSummary.truncated,
      ordersTruncated: ordersSummary.truncated,
      usedNewCustomerFallback: ordersSummary.usedFallback,
    },
  };

  return data;
};

export default function Index() {
  const data = useLoaderData<typeof loader>();

  return (
    <s-page heading="Customer analytics">
      <s-section heading="Customer lookup">
        <Form method="get">
          <s-stack direction="inline" gap="base" align="center">
            <label>
              <s-text>Customer email</s-text>
              <input
                type="email"
                name="customer_email"
                placeholder="customer@example.com"
                defaultValue={data.customerLookup.query}
              />
            </label>
            <s-button type="submit">Find customer</s-button>
          </s-stack>
        </Form>
        {data.customerLookup.query && !data.customerLookup.result && (
          <s-paragraph>No customer found for that email.</s-paragraph>
        )}
        {data.customerLookup.result && (
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="base">
              <s-heading>{data.customerLookup.result.name}</s-heading>
              <s-paragraph>Email: {data.customerLookup.result.email}</s-paragraph>
              <s-paragraph>
                Total spent:{" "}
                {formatCurrency(
                  data.customerLookup.result.totalSpent,
                  data.totals.currencyCode,
                )}
              </s-paragraph>
              <s-paragraph>
                Orders: {data.customerLookup.result.ordersCount}
              </s-paragraph>
              <s-paragraph>
                First order:{" "}
                {data.customerLookup.result.firstOrderDate
                  ? data.customerLookup.result.firstOrderDate.slice(0, 10)
                  : "Unknown"}
              </s-paragraph>
              <s-paragraph>
                Original referrer channel:{" "}
                {data.customerLookup.result.referrerChannel}
              </s-paragraph>
              {data.customerLookup.result.utmSummary && (
                <s-paragraph>
                  UTM: {data.customerLookup.result.utmSummary}
                </s-paragraph>
              )}
              {data.customerLookup.result.referrerUrl && (
                <s-paragraph>
                  Referrer URL: {data.customerLookup.result.referrerUrl}
                </s-paragraph>
              )}
            </s-stack>
          </s-box>
        )}
      </s-section>

      <s-section heading="Date range">
        <Form method="get">
          <s-stack direction="inline" gap="base" align="center">
            <label>
              <s-text>Start</s-text>
              <input type="date" name="start" defaultValue={data.range.start} />
            </label>
            <label>
              <s-text>End</s-text>
              <input type="date" name="end" defaultValue={data.range.end} />
            </label>
            <s-button type="submit">Update</s-button>
          </s-stack>
        </Form>
      </s-section>

      <s-section heading="Overview">
        <s-stack direction="inline" gap="base">
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-heading>Customers</s-heading>
            <s-paragraph>{data.totals.customers}</s-paragraph>
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-heading>Total CLV</s-heading>
            <s-paragraph>
              {formatCurrency(data.totals.totalClv, data.totals.currencyCode)}
            </s-paragraph>
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-heading>Average CLV</s-heading>
            <s-paragraph>
              {formatCurrency(data.totals.averageClv, data.totals.currencyCode)}
            </s-paragraph>
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-heading>New customers</s-heading>
            <s-paragraph>{data.newCustomers.length}</s-paragraph>
          </s-box>
        </s-stack>
      </s-section>

      <s-section heading="New customers (first order in range)">
        {data.newCustomers.length === 0 ? (
          <s-paragraph>No new customers in this range.</s-paragraph>
        ) : (
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th align="left">Customer</th>
                  <th align="left">Email</th>
                  <th align="left">First order</th>
                  <th align="right">Orders</th>
                  <th align="right">Total spent</th>
                </tr>
              </thead>
              <tbody>
                {data.newCustomers.map((customer) => (
                  <tr key={customer.id}>
                    <td>{customer.name}</td>
                    <td>{customer.email}</td>
                    <td>{customer.firstOrderDate.slice(0, 10)}</td>
                    <td align="right">{customer.ordersCount}</td>
                    <td align="right">
                      {formatCurrency(
                        customer.totalSpent,
                        data.totals.currencyCode,
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </s-box>
        )}
      </s-section>

      <s-section heading="Top customers by lifetime value">
        {data.topCustomers.length === 0 ? (
          <s-paragraph>No customers found yet.</s-paragraph>
        ) : (
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th align="left">Customer</th>
                  <th align="left">Email</th>
                  <th align="right">Orders</th>
                  <th align="right">Total spent</th>
                </tr>
              </thead>
              <tbody>
                {data.topCustomers.map((customer) => (
                  <tr key={customer.id}>
                    <td>{customer.name}</td>
                    <td>{customer.email}</td>
                    <td align="right">{customer.ordersCount}</td>
                    <td align="right">
                      {formatCurrency(
                        customer.totalSpent,
                        data.totals.currencyCode,
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </s-box>
        )}
      </s-section>

      <s-section heading="Notes">
        <s-paragraph>
          CLV is calculated as total spend to date per customer.
        </s-paragraph>
        {data.notes.usedNewCustomerFallback && (
          <s-paragraph>
            Some customers were counted as new based on having only one order
            because their first order date was unavailable.
          </s-paragraph>
        )}
        {data.notes.customersTruncated && (
          <s-paragraph>
            Customer totals were truncated at {MAX_CUSTOMERS} customers to keep
            the dashboard fast.
          </s-paragraph>
        )}
        {data.notes.ordersTruncated && (
          <s-paragraph>
            New customer calculation was truncated at {MAX_ORDERS} orders to keep
            the dashboard fast.
          </s-paragraph>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
