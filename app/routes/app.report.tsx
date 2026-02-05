import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Form, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

type Money = {
  amount: string;
  currencyCode: string;
};

type CustomerNode = {
  id: string;
  displayName: string | null;
  email: string | null;
  createdAt?: string | null;
  numberOfOrders: number | null;
  tags?: string[] | null;
  amountSpent: Money | null;
  orders?: {
    nodes?: Array<{
      createdAt?: string | null;
    }>;
  } | null;
};

type SortKey = "ltv_desc" | "ltv_asc" | "orders_desc" | "orders_asc";
type TagsMode = "any" | "all";
type ReportPreset = {
  id: string;
  name: string;
  params: string;
};

type LoaderData = {
  sort: SortKey;
  page: number;
  perPage: number;
  perPageSelection: string;
  query: string;
  tags: string;
  tagsMode: TagsMode;
  minOrders: string;
  maxOrders: string;
  minSpent: string;
  maxSpent: string;
  createdStart: string;
  createdEnd: string;
  firstOrderStart: string;
  firstOrderEnd: string;
  presets: ReportPreset[];
  charts: {
    ltvBuckets: Array<{ label: string; count: number }>;
    orderBuckets: Array<{ label: string; count: number }>;
  };
  totalCustomers: number;
  currencyCode: string;
  customers: Array<{
    id: string;
    name: string;
    email: string;
    totalSpent: number;
    ordersCount: number;
    createdAt: string | null;
    firstOrderDate: string | null;
    tags: string[];
  }>;
};

const PAGE_SIZE_OPTIONS = [50, 100, 250, 500];
const DEFAULT_PAGE_SIZE = 250;
const CONFIG_KEYS = [
  "sort",
  "per_page",
  "q",
  "tags",
  "tags_mode",
  "min_orders",
  "max_orders",
  "min_spent",
  "max_spent",
  "created_start",
  "created_end",
  "first_order_start",
  "first_order_end",
] as const;

const parseNumber = (value: string | null, fallback: number) => {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parseSort = (value: string | null): SortKey => {
  if (
    value === "ltv_desc" ||
    value === "ltv_asc" ||
    value === "orders_desc" ||
    value === "orders_asc"
  ) {
    return value;
  }

  return "ltv_desc";
};

const normalizeQuery = (value: string | null) =>
  (value || "").trim().toLowerCase();

const parseOptionalNumber = (value: string | null) => {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const parseDate = (value: string | null, endOfDay = false) => {
  if (!value) return null;
  const suffix = endOfDay ? "T23:59:59Z" : "T00:00:00Z";
  const parsed = new Date(`${value}${suffix}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const parseTags = (value: string | null) =>
  (value || "")
    .split(",")
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);

const parseTagsMode = (value: string | null): TagsMode =>
  value === "all" ? "all" : "any";

const buildConfig = (params: URLSearchParams) => {
  const config: Record<string, string> = {};
  for (const key of CONFIG_KEYS) {
    const value = params.get(key);
    if (value) {
      config[key] = value;
    }
  }
  return config;
};

const configToParams = (config: Record<string, string>) => {
  const params = new URLSearchParams();
  for (const key of CONFIG_KEYS) {
    const value = config[key];
    if (value) {
      params.set(key, value);
    }
  }
  return params.toString();
};

const formatCurrency = (value: number, currencyCode: string) => {
  if (!Number.isFinite(value)) return "-";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currencyCode || "USD",
    maximumFractionDigits: 2,
  }).format(value);
};

const escapeCsv = (value: string | number | null) => {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, "\"\"")}"`;
  }
  return text;
};

const buildBuckets = (values: number[], edges: number[]) => {
  const buckets = edges.map((edge, index) => ({
    label:
      index === edges.length - 1
        ? `${edge}+`
        : `${edge}-${edges[index + 1] - 1}`,
    count: 0,
  }));

  for (const value of values) {
    const index = edges.findIndex((edge, i) => {
      const next = edges[i + 1];
      if (next === undefined) return value >= edge;
      return value >= edge && value < next;
    });
    const bucketIndex = index === -1 ? buckets.length - 1 : index;
    buckets[bucketIndex].count += 1;
  }

  return buckets;
};

const fetchAllCustomers = async (admin: any) => {
  let hasNextPage = true;
  let after: string | null = null;
  let currencyCode = "USD";
  const customers: Array<{
    id: string;
    name: string;
    email: string;
    totalSpent: number;
    ordersCount: number;
    createdAt: string | null;
    firstOrderDate: string | null;
    tags: string[];
  }> = [];

  while (hasNextPage) {
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
              createdAt
              numberOfOrders
              tags
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
        }`,
      {
        variables: {
          first: 250,
          after,
        },
      },
    );

    const json = await response.json();
    if (json.errors) {
      throw new Error(JSON.stringify(json.errors));
    }

    const nodes = json.data.customers.nodes as CustomerNode[];
    for (const customer of nodes) {
      const amount = Number(customer.amountSpent?.amount || 0);
      const ordersCount = customer.numberOfOrders || 0;
      const name = customer.displayName || customer.email || "Unknown";
      const email = customer.email || "-";
      const createdAt = customer.createdAt || null;
      const firstOrderDate = customer.orders?.nodes?.[0]?.createdAt || null;
      const tags = (customer.tags || []).map((tag) => tag.toLowerCase());

      if (customer.amountSpent?.currencyCode) {
        currencyCode = customer.amountSpent.currencyCode;
      }

      customers.push({
        id: customer.id,
        name,
        email,
        totalSpent: amount,
        ordersCount,
        createdAt,
        firstOrderDate,
        tags,
      });
    }

    hasNextPage = json.data.customers.pageInfo.hasNextPage;
    after = json.data.customers.pageInfo.endCursor;
  }

  return { customers, currencyCode };
};

const sortCustomers = (
  customers: LoaderData["customers"],
  sort: SortKey,
) => {
  const sorted = [...customers];

  switch (sort) {
    case "ltv_asc":
      sorted.sort((a, b) => a.totalSpent - b.totalSpent || a.ordersCount - b.ordersCount);
      break;
    case "ltv_desc":
      sorted.sort((a, b) => b.totalSpent - a.totalSpent || b.ordersCount - a.ordersCount);
      break;
    case "orders_asc":
      sorted.sort((a, b) => a.ordersCount - b.ordersCount || a.totalSpent - b.totalSpent);
      break;
    case "orders_desc":
      sorted.sort((a, b) => b.ordersCount - a.ordersCount || b.totalSpent - a.totalSpent);
      break;
  }

  return sorted;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent === "save") {
    const name = String(formData.get("report_name") || "").trim();
    if (!name) {
      return { ok: false, error: "Report name is required." };
    }

    const config: Record<string, string> = {};
    for (const key of CONFIG_KEYS) {
      const value = formData.get(key);
      if (typeof value === "string" && value.length > 0) {
        config[key] = value;
      }
    }

    await prisma.reportPreset.create({
      data: {
        shop: session.shop,
        name,
        config: JSON.stringify(config),
      },
    });

    return { ok: true };
  }

  if (intent === "delete") {
    const id = String(formData.get("preset_id") || "");
    if (id) {
      await prisma.reportPreset.delete({
        where: { id },
      });
    }
    return { ok: true };
  }

  return { ok: false, error: "Unknown action." };
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);

  const sort = parseSort(url.searchParams.get("sort"));
  const perPageParam = url.searchParams.get("per_page");
  const page = parseNumber(url.searchParams.get("page"), 1);
  const query = normalizeQuery(url.searchParams.get("q"));
  const tags = url.searchParams.get("tags") || "";
  const tagsMode = parseTagsMode(url.searchParams.get("tags_mode"));
  const minOrders = url.searchParams.get("min_orders") || "";
  const maxOrders = url.searchParams.get("max_orders") || "";
  const minSpent = url.searchParams.get("min_spent") || "";
  const maxSpent = url.searchParams.get("max_spent") || "";
  const createdStart = url.searchParams.get("created_start") || "";
  const createdEnd = url.searchParams.get("created_end") || "";
  const firstOrderStart = url.searchParams.get("first_order_start") || "";
  const firstOrderEnd = url.searchParams.get("first_order_end") || "";
  const exportCsv = url.searchParams.get("export") === "csv";

  const tagsList = parseTags(tags);
  const minOrdersValue = parseOptionalNumber(minOrders);
  const maxOrdersValue = parseOptionalNumber(maxOrders);
  const minSpentValue = parseOptionalNumber(minSpent);
  const maxSpentValue = parseOptionalNumber(maxSpent);
  const createdStartDate = parseDate(createdStart, false);
  const createdEndDate = parseDate(createdEnd, true);
  const firstOrderStartDate = parseDate(firstOrderStart, false);
  const firstOrderEndDate = parseDate(firstOrderEnd, true);

  const { customers, currencyCode } = await fetchAllCustomers(admin);
  const filtered = customers.filter((customer) => {
    if (query) {
      const name = customer.name.toLowerCase();
      const email = customer.email.toLowerCase();
      if (!name.includes(query) && !email.includes(query)) {
        return false;
      }
    }

    if (minOrdersValue !== null && customer.ordersCount < minOrdersValue) {
      return false;
    }

    if (maxOrdersValue !== null && customer.ordersCount > maxOrdersValue) {
      return false;
    }

    if (minSpentValue !== null && customer.totalSpent < minSpentValue) {
      return false;
    }

    if (maxSpentValue !== null && customer.totalSpent > maxSpentValue) {
      return false;
    }

    if (tagsList.length) {
      const hasTag = (tag: string) => customer.tags.includes(tag);
      const matches =
        tagsMode === "all"
          ? tagsList.every(hasTag)
          : tagsList.some(hasTag);
      if (!matches) return false;
    }

    if (createdStartDate || createdEndDate) {
      if (!customer.createdAt) return false;
      const createdAt = new Date(customer.createdAt);
      if (createdStartDate && createdAt < createdStartDate) return false;
      if (createdEndDate && createdAt > createdEndDate) return false;
    }

    if (firstOrderStartDate || firstOrderEndDate) {
      if (!customer.firstOrderDate) return false;
      const firstOrderDate = new Date(customer.firstOrderDate);
      if (firstOrderStartDate && firstOrderDate < firstOrderStartDate) {
        return false;
      }
      if (firstOrderEndDate && firstOrderDate > firstOrderEndDate) {
        return false;
      }
    }

    return true;
  });
  const sorted = sortCustomers(filtered, sort);
  const totalCustomers = sorted.length;
  const isAll = perPageParam === "all";
  const perPage =
    perPageParam && perPageParam !== "all"
      ? parseNumber(perPageParam, DEFAULT_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE;
  const safePerPage = isAll
    ? Math.max(totalCustomers, 1)
    : PAGE_SIZE_OPTIONS.includes(perPage)
      ? perPage
      : DEFAULT_PAGE_SIZE;

  const totalPages = Math.max(1, Math.ceil(totalCustomers / safePerPage));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const startIndex = (currentPage - 1) * safePerPage;
  const endIndex = startIndex + safePerPage;

  const presets = await prisma.reportPreset.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
  });

  const presetsData: ReportPreset[] = presets.map((preset) => {
    let params = "";
    try {
      params = configToParams(JSON.parse(preset.config || "{}"));
    } catch {
      params = "";
    }

    return {
      id: preset.id,
      name: preset.name,
      params,
    };
  });

  const ltvBuckets = buildBuckets(
    sorted.map((customer) => customer.totalSpent),
    [0, 50, 100, 250, 500, 1000, 2000, 5000, 10000],
  );

  const orderBuckets = buildBuckets(
    sorted.map((customer) => customer.ordersCount),
    [0, 1, 2, 3, 5, 10, 20, 50],
  );

  if (exportCsv) {
    const rows = [
      [
        "Customer",
        "Email",
        "Orders",
        "TotalSpent",
        "CustomerCreatedAt",
        "FirstOrderDate",
        "Tags",
      ],
      ...sorted.map((customer) => [
        customer.name,
        customer.email,
        customer.ordersCount,
        customer.totalSpent,
        customer.createdAt || "",
        customer.firstOrderDate || "",
        customer.tags.join(", "),
      ]),
    ];

    const csv = rows.map((row) => row.map(escapeCsv).join(",")).join("\n");
    const filename = `customer-report-${new Date()
      .toISOString()
      .slice(0, 10)}.csv`;

    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  }

  const data: LoaderData = {
    sort,
    page: currentPage,
    perPage: safePerPage,
    perPageSelection: isAll ? "all" : String(safePerPage),
    query,
    tags,
    tagsMode,
    minOrders,
    maxOrders,
    minSpent,
    maxSpent,
    createdStart,
    createdEnd,
    firstOrderStart,
    firstOrderEnd,
    presets: presetsData,
    charts: {
      ltvBuckets,
      orderBuckets,
    },
    totalCustomers,
    currencyCode,
    customers: sorted.slice(startIndex, endIndex),
  };

  return data;
};

export default function Report() {
  const data = useLoaderData<typeof loader>();
  const totalPages = Math.max(1, Math.ceil(data.totalCustomers / data.perPage));
  const startRow = data.totalCustomers === 0 ? 0 : (data.page - 1) * data.perPage + 1;
  const endRow = Math.min(data.page * data.perPage, data.totalCustomers);

  const baseParams = new URLSearchParams();
  baseParams.set("sort", data.sort);
  baseParams.set("per_page", data.perPageSelection);
  if (data.query) {
    baseParams.set("q", data.query);
  }
  if (data.tags) {
    baseParams.set("tags", data.tags);
  }
  if (data.tagsMode) {
    baseParams.set("tags_mode", data.tagsMode);
  }
  if (data.minOrders) {
    baseParams.set("min_orders", data.minOrders);
  }
  if (data.maxOrders) {
    baseParams.set("max_orders", data.maxOrders);
  }
  if (data.minSpent) {
    baseParams.set("min_spent", data.minSpent);
  }
  if (data.maxSpent) {
    baseParams.set("max_spent", data.maxSpent);
  }
  if (data.createdStart) {
    baseParams.set("created_start", data.createdStart);
  }
  if (data.createdEnd) {
    baseParams.set("created_end", data.createdEnd);
  }
  if (data.firstOrderStart) {
    baseParams.set("first_order_start", data.firstOrderStart);
  }
  if (data.firstOrderEnd) {
    baseParams.set("first_order_end", data.firstOrderEnd);
  }

  const prevParams = new URLSearchParams(baseParams);
  prevParams.set("page", String(Math.max(1, data.page - 1)));

  const nextParams = new URLSearchParams(baseParams);
  nextParams.set("page", String(Math.min(totalPages, data.page + 1)));

  const exportParams = new URLSearchParams(baseParams);
  exportParams.set("export", "csv");

  return (
    <s-page heading="Customer report">
      <s-section heading="Sort & display">
        <Form method="get">
          <s-stack direction="inline" gap="base" align="center">
            <label>
              <s-text>Search customer</s-text>
              <input
                type="text"
                name="q"
                placeholder="Name or email"
                defaultValue={data.query}
              />
            </label>
            <label>
              <s-text>Tags (comma-separated)</s-text>
              <input
                type="text"
                name="tags"
                placeholder="vip, wholesale"
                defaultValue={data.tags}
              />
            </label>
            <label>
              <s-text>Tag match</s-text>
              <select name="tags_mode" defaultValue={data.tagsMode}>
                <option value="any">Any tag</option>
                <option value="all">All tags</option>
              </select>
            </label>
            <label>
              <s-text>Sort by</s-text>
              <select name="sort" defaultValue={data.sort}>
                <option value="ltv_desc">LTV high → low</option>
                <option value="ltv_asc">LTV low → high</option>
                <option value="orders_desc">Orders high → low</option>
                <option value="orders_asc">Orders low → high</option>
              </select>
            </label>
            <label>
              <s-text>Rows per page</s-text>
              <select
                name="per_page"
                defaultValue={data.perPageSelection}
              >
                {PAGE_SIZE_OPTIONS.map((size) => (
                  <option key={size} value={String(size)}>
                    {size}
                  </option>
                ))}
                <option value="all">All</option>
              </select>
            </label>
            <s-button type="submit">Run report</s-button>
          </s-stack>
        </Form>
        <s-paragraph>
          Showing {startRow}-{endRow} of {data.totalCustomers} customers.
        </s-paragraph>
        <s-stack direction="inline" gap="base" align="center">
          <s-link href={`?${exportParams.toString()}`}>Export CSV</s-link>
        </s-stack>
      </s-section>

      <s-section heading="Saved reports">
        <Form method="post">
          <input type="hidden" name="intent" value="save" />
          {CONFIG_KEYS.map((key) => (
            <input
              key={key}
              type="hidden"
              name={key}
              value={baseParams.get(key) || ""}
            />
          ))}
          <s-stack direction="inline" gap="base" align="center">
            <label>
              <s-text>Report name</s-text>
              <input type="text" name="report_name" placeholder="My VIP report" />
            </label>
            <s-button type="submit">Save report</s-button>
          </s-stack>
        </Form>
        {data.presets.length === 0 ? (
          <s-paragraph>No saved reports yet.</s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            {data.presets.map((preset) => (
              <s-box
                key={preset.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-stack direction="inline" gap="base" align="center">
                  <s-heading>{preset.name}</s-heading>
                  <s-link href={`?${preset.params}`}>Open</s-link>
                  <Form method="post">
                    <input type="hidden" name="intent" value="delete" />
                    <input type="hidden" name="preset_id" value={preset.id} />
                    <s-button type="submit" variant="tertiary">
                      Delete
                    </s-button>
                  </Form>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        )}
      </s-section>

      <s-section heading="Advanced filters">
        <Form method="get">
          <s-stack direction="inline" gap="base" align="center">
            <input type="hidden" name="q" value={data.query} />
            <input type="hidden" name="sort" value={data.sort} />
            <input type="hidden" name="per_page" value={data.perPageSelection} />
            <input type="hidden" name="tags" value={data.tags} />
            <input type="hidden" name="tags_mode" value={data.tagsMode} />
            <label>
              <s-text>Min orders</s-text>
              <input
                type="number"
                name="min_orders"
                min={0}
                placeholder="0"
                defaultValue={data.minOrders}
              />
            </label>
            <label>
              <s-text>Max orders</s-text>
              <input
                type="number"
                name="max_orders"
                min={0}
                placeholder="100"
                defaultValue={data.maxOrders}
              />
            </label>
            <label>
              <s-text>Min spent</s-text>
              <input
                type="number"
                name="min_spent"
                min={0}
                step="0.01"
                placeholder="0"
                defaultValue={data.minSpent}
              />
            </label>
            <label>
              <s-text>Max spent</s-text>
              <input
                type="number"
                name="max_spent"
                min={0}
                step="0.01"
                placeholder="5000"
                defaultValue={data.maxSpent}
              />
            </label>
            <label>
              <s-text>Customer created start</s-text>
              <input
                type="date"
                name="created_start"
                defaultValue={data.createdStart}
              />
            </label>
            <label>
              <s-text>Customer created end</s-text>
              <input
                type="date"
                name="created_end"
                defaultValue={data.createdEnd}
              />
            </label>
            <label>
              <s-text>First order start</s-text>
              <input
                type="date"
                name="first_order_start"
                defaultValue={data.firstOrderStart}
              />
            </label>
            <label>
              <s-text>First order end</s-text>
              <input
                type="date"
                name="first_order_end"
                defaultValue={data.firstOrderEnd}
              />
            </label>
            <s-button type="submit">Apply filters</s-button>
          </s-stack>
        </Form>
      </s-section>

      <s-section heading="Distribution charts">
        <s-stack direction="inline" gap="base" align="start">
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-heading>LTV distribution</s-heading>
            <div style={{ display: "grid", gap: "6px", minWidth: "240px" }}>
              {data.charts.ltvBuckets.map((bucket) => (
                <div key={bucket.label} style={{ display: "flex", gap: "8px" }}>
                  <s-text style={{ minWidth: "90px" }}>{bucket.label}</s-text>
                  <div
                    style={{
                      flex: 1,
                      background: "#e6e6e6",
                      borderRadius: "999px",
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        height: "8px",
                        width: `${Math.min(
                          100,
                          data.totalCustomers
                            ? (bucket.count / data.totalCustomers) * 100
                            : 0,
                        )}%`,
                        background: "#2d6cdf",
                      }}
                    />
                  </div>
                  <s-text>{bucket.count}</s-text>
                </div>
              ))}
            </div>
          </s-box>

          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-heading>Order count distribution</s-heading>
            <div style={{ display: "grid", gap: "6px", minWidth: "240px" }}>
              {data.charts.orderBuckets.map((bucket) => (
                <div key={bucket.label} style={{ display: "flex", gap: "8px" }}>
                  <s-text style={{ minWidth: "90px" }}>{bucket.label}</s-text>
                  <div
                    style={{
                      flex: 1,
                      background: "#e6e6e6",
                      borderRadius: "999px",
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        height: "8px",
                        width: `${Math.min(
                          100,
                          data.totalCustomers
                            ? (bucket.count / data.totalCustomers) * 100
                            : 0,
                        )}%`,
                        background: "#16a085",
                      }}
                    />
                  </div>
                  <s-text>{bucket.count}</s-text>
                </div>
              ))}
            </div>
          </s-box>
        </s-stack>
      </s-section>

      <s-section heading="Results">
        {data.totalCustomers === 0 ? (
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
                {data.customers.map((customer) => (
                  <tr key={customer.id}>
                    <td>{customer.name}</td>
                    <td>{customer.email}</td>
                    <td align="right">{customer.ordersCount}</td>
                    <td align="right">
                      {formatCurrency(customer.totalSpent, data.currencyCode)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </s-box>
        )}
      </s-section>

      <s-section heading="Pages">
        <s-stack direction="inline" gap="base" align="center">
          <s-link href={`?${prevParams.toString()}`}>
            Prev
          </s-link>
          <s-text>
            Page {data.page} of {totalPages}
          </s-text>
          <s-link href={`?${nextParams.toString()}`}>
            Next
          </s-link>
        </s-stack>
      </s-section>

      <s-section heading="Notes">
        <s-paragraph>
          This report sorts customers by total spent or order count. Because
          Shopify no longer supports sorting customers by total spent or order
          count in the API, the report fetches customers and sorts them inside
          the app. Large stores may take longer to load.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
