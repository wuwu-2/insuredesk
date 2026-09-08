import type { Permission } from "@insuredesk/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { httpBatchLink } from "@trpc/client";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "@/contexts/AuthContext";
import { trpc } from "@/lib/trpc";
import { TEST_ROLES } from "@/test/roles";
import { AppRoutes } from "../../AppRoutes";
import { ThemeProvider } from "../../components/ThemeProvider";
import type { DashboardActionStats, DashboardAnalysisStats } from "./dashboard-types";

const auth = vi.hoisted(() => ({
  user: null as AuthUser | null,
  isLoading: false,
}));

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    user: auth.user,
    isLoading: auth.isLoading,
    hasPermission: (permission: Permission) => auth.user?.permissions.includes(permission) ?? false,
    login: vi.fn(),
    logout: vi.fn(),
  }),
}));

function userWith(role: { name: string; permissions: readonly Permission[] }): AuthUser {
  return {
    id: "u1",
    username: "tester",
    name: "测试用户",
    email: null,
    team: null,
    roleId: "r1",
    roleName: role.name,
    permissions: [...role.permissions],
    requiredTicketFields: [],
    isExternal: false,
  };
}

const HOUR_MS = 60 * 60 * 1000;

function actionPayload(overrides: Partial<DashboardActionStats> = {}): DashboardActionStats {
  return {
    scope: "all",
    metrics: {
      overdue: 2,
      dueSoon: 3,
      awaitingFirstResponse: 4,
      firstResponseOverLine: 1,
      unassigned: 5,
      unassignedOldestWaitMs: 26 * HOUR_MS,
    },
    policies: [
      {
        policyId: "pol-1",
        name: "特急投诉",
        kindName: "投诉",
        timeoutMs: 48 * HOUR_MS,
        inFlight: 9,
        dueSoon: 2,
        overdue: 1,
      },
      {
        policyId: null,
        name: "未指定策略",
        kindName: null,
        timeoutMs: null,
        inFlight: 3,
        dueSoon: 0,
        overdue: 0,
      },
    ],
    ...overrides,
  };
}

function analysisPayload(overrides: Partial<DashboardAnalysisStats> = {}): DashboardAnalysisStats {
  return {
    scope: "all",
    trend: {
      granularity: "day",
      points: [
        { bucketStart: "2026-08-06T00:00:00.000Z", created: 3, previous: 1 },
        { bucketStart: "2026-08-07T00:00:00.000Z", created: 5, previous: 2 },
      ],
    },
    kinds: [
      { kindId: "k-1", name: "投诉", count: 10 },
      { kindId: "k-2", name: "咨询", count: 6 },
    ],
    categories: [
      { categoryId: "c-1", name: "理赔纠纷", count: 8 },
      { categoryId: null, name: "未填写", count: 2 },
    ],
    sources: [
      { source: "manual", count: 12 },
      { source: "feishu_form", count: 4 },
    ],
    matrix: {
      columns: [
        { id: "ufc-1", name: "来电" },
        { id: "ufc-2", name: "线上" },
        { id: null, name: "未填写" },
      ],
      rows: [
        {
          channelId: "ch-1",
          name: "保司",
          cells: { "ufc-1": 5, "ufc-2": 3, unfilled: 1 },
          entities: [{ name: "平安人寿", cells: { "ufc-1": 4, "ufc-2": 1, unfilled: 0 } }],
        },
        {
          channelId: "ch-2",
          name: "监管",
          cells: { "ufc-1": 2, "ufc-2": 0, unfilled: 0 },
          entities: [],
        },
        {
          channelId: null,
          name: "未填写",
          cells: { "ufc-1": 0, "ufc-2": 1, unfilled: 0 },
          entities: [],
        },
      ],
    },
    agents: [
      {
        assigneeId: "cs-1",
        name: "张客服",
        inFlight: 7,
        overdue: 2,
        dueSoon: 1,
        awaitingFirstResponse: 1,
        followUpCheckpoints: 1,
        followUpRolling: 2,
        completed: 15,
        avgCompletionMs: 30.5 * HOUR_MS,
        overdueCount: 5,
        overdueRate: 0.25,
      },
      {
        assigneeId: "cs-2",
        name: "李客服",
        inFlight: 0,
        overdue: 0,
        dueSoon: 0,
        awaitingFirstResponse: 0,
        followUpCheckpoints: 0,
        followUpRolling: 0,
        completed: 0,
        avgCompletionMs: null,
        overdueCount: 0,
        overdueRate: 0,
      },
    ],
    ...overrides,
  };
}

const canned = {
  action: actionPayload() as DashboardActionStats | null,
  analysis: analysisPayload() as DashboardAnalysisStats | null,
};

/** tRPC batched queries arrive as GET; answer each path in the batch. */
function fakeFetch(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(String(input));
  const paths = (url.pathname.split("/api/trpc/")[1] ?? "").split(",");
  const body = paths.map((path) => {
    // The AppLayout bell polls notification.list in the same batch.
    if (path === "notification.list") {
      return { result: { data: { items: [], unreadCount: 0, todo: { items: [], count: 0 } } } };
    }
    if (path === "dashboard.actionStats") {
      if (canned.action === null) {
        return { error: { message: "boom", code: -32603, data: { httpStatus: 500 } } };
      }
      return { result: { data: canned.action } };
    }
    if (path === "dashboard.analysisStats") {
      if (canned.analysis === null) {
        return { error: { message: "boom", code: -32603, data: { httpStatus: 500 } } };
      }
      return { result: { data: canned.analysis } };
    }
    return { error: { message: `unknown path ${path}`, code: -32603, data: { httpStatus: 500 } } };
  });
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

function renderDashboard(initialEntry = "/dashboard") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const trpcClient = trpc.createClient({
    links: [httpBatchLink({ url: "http://localhost/api/trpc", fetch: fakeFetch })],
  });

  return render(
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <MemoryRouter initialEntries={[initialEntry]}>
            <AppRoutes />
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>
    </trpc.Provider>,
  );
}

beforeEach(() => {
  auth.user = userWith(TEST_ROLES.CS_MANAGER);
  auth.isLoading = false;
  canned.action = actionPayload();
  canned.analysis = analysisPayload();
});

describe("区块渲染", () => {
  it("renders all six sections and no page-level h1", async () => {
    const { container } = renderDashboard();

    expect(await screen.findByText("需要行动")).toBeInTheDocument();
    for (const title of [
      "时效策略",
      "渠道 × 用户反馈渠道交叉分析",
      "单量趋势",
      "类型分布",
      "坐席负载与考核",
    ]) {
      expect(screen.getByText(title)).toBeInTheDocument();
    }
    expect(container.querySelector("h1")).toBeNull();
  });

  it("shows the period capsule with the default 近 30 天 preset when URL has no range", async () => {
    renderDashboard();

    expect(await screen.findByText("需要行动")).toBeInTheDocument();
    expect(screen.getAllByText("统计周期").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("button", { name: /创建时间筛选：近 30 天/ })).toBeInTheDocument();
  });
});

describe("行动卡", () => {
  it("renders the four cards with values and drill-down links", async () => {
    const { container } = renderDashboard();

    // 已超时/即将超时/待首响 同时也是考核表列名，只断言至少出现一次
    expect((await screen.findAllByText("已超时")).length).toBeGreaterThanOrEqual(1);
    for (const label of ["即将超时", "待首响", "未分配"]) {
      expect(screen.getAllByText(label).length).toBeGreaterThanOrEqual(1);
    }
    expect(container.querySelector('a[href="/tickets?status=overdue"]')).not.toBeNull();
    expect(container.querySelector('a[href="/tickets?status=pending_timeout"]')).not.toBeNull();
    expect(container.querySelector('a[href="/tickets?firstResponse=pending"]')).not.toBeNull();
    expect(container.querySelector('a[href="/tickets?status=unassigned"]')).not.toBeNull();
  });

  it("shows the over-line sub count on 待首响 and the oldest wait on 未分配", async () => {
    renderDashboard();

    expect(await screen.findByText("1 单已过首响线")).toBeInTheDocument();
    expect(screen.getByText("最老已等待 1天2小时")).toBeInTheDocument();
  });

  it("omits the oldest-wait sub when nobody is waiting", async () => {
    canned.action = actionPayload({
      metrics: { ...actionPayload().metrics, unassigned: 0, unassignedOldestWaitMs: null },
    });
    renderDashboard();

    expect(await screen.findByText("需要行动")).toBeInTheDocument();
    expect(screen.queryByText(/最老已等待/)).not.toBeInTheDocument();
  });

  it("explains the overlap in the footnote", async () => {
    renderDashboard();

    expect(
      await screen.findByText(/已超时\/即将超时含未分配单.*卡间有交集，勿加总。/),
    ).toBeInTheDocument();
  });
});

describe("时效策略卡", () => {
  it("renders policy cards with timeout badge and drill-down links", async () => {
    renderDashboard();

    expect(await screen.findByText("特急投诉")).toBeInTheDocument();
    expect(screen.getByText("48h")).toBeInTheDocument();
    expect(screen.getByText("未指定策略")).toBeInTheDocument();
    expect(screen.getByText("不设时限")).toBeInTheDocument();

    const openStatusQuery = "unassigned,assigned,processing,pending_timeout,overdue";
    expect(screen.getByRole("link", { name: "特急投诉" })).toHaveAttribute(
      "href",
      `/tickets?slaPolicyId=pol-1&status=${openStatusQuery}`,
    );
    expect(screen.getByRole("link", { name: "未指定策略" })).toHaveAttribute(
      "href",
      `/tickets?slaPolicyId=none&status=${openStatusQuery}`,
    );
    expect(screen.getByRole("link", { name: "超时 1" })).toHaveAttribute(
      "href",
      "/tickets?slaPolicyId=pol-1&status=overdue",
    );
    expect(screen.getByRole("link", { name: "预警 2" })).toHaveAttribute(
      "href",
      "/tickets?slaPolicyId=pol-1&status=pending_timeout",
    );
    expect(screen.getByRole("link", { name: "超时 0" })).toHaveAttribute(
      "href",
      "/tickets?slaPolicyId=none&status=overdue",
    );
  });
});

describe("交叉矩阵", () => {
  it("renders columns, rows and the grand total row", async () => {
    renderDashboard();

    expect(await screen.findByText("来电")).toBeInTheDocument();
    expect(screen.getByText("线上")).toBeInTheDocument();
    expect(screen.getByText("保司")).toBeInTheDocument();
    expect(screen.getByText("监管")).toBeInTheDocument();
    expect(screen.getByText("合计")).toBeInTheDocument();
    expect(screen.getByText("总计")).toBeInTheDocument();
  });

  it("expands entity rows only for rows that have entities", async () => {
    const user = userEvent.setup();
    renderDashboard();

    const rowLabel = await screen.findByText("保司");
    expect(screen.queryByText("平安人寿")).not.toBeInTheDocument();
    await user.click(rowLabel.closest("tr") as HTMLElement);
    expect(await screen.findByText("平安人寿")).toBeInTheDocument();

    // 监管行无实体：整行不可点，也没有展开箭头
    const regulatorRow = screen.getByText("监管").closest("tr") as HTMLElement;
    expect(regulatorRow).not.toHaveClass("cursor-pointer");
  });
});

describe("坐席负载与考核", () => {
  it("renders the grouped two-row header and one row per agent", async () => {
    renderDashboard();

    const agentTable = (await screen.findByText("张客服")).closest("table") as HTMLElement;
    const liveHeader = screen.getByText("实时").closest("th");
    expect(liveHeader).toHaveAttribute("colspan", "5");
    const periodHeader = screen
      .getAllByText("统计周期")
      .map((element) => element.closest("th"))
      .find((cell) => cell !== null);
    expect(periodHeader).toHaveAttribute("colspan", "3");

    for (const column of [
      "跟进人",
      "在途",
      "已超时",
      "即将超时",
      "待首响",
      "欠跟进",
      "完单",
      "平均完结时长",
      "超时率",
    ]) {
      expect(within(agentTable).getByText(column)).toBeInTheDocument();
    }
    expect(screen.getByText("15")).toBeInTheDocument();
    expect(screen.getByText("1天6.5小时")).toBeInTheDocument();
    expect(screen.getByText("25.0%")).toBeInTheDocument();
    expect(screen.getByText("李客服")).toBeInTheDocument();
  });

  it("欠跟进 cell merges checkpoint and rolling counts with a breakdown tooltip", async () => {
    renderDashboard();

    const debtCell = (await screen.findByText("张客服")).closest("tr")?.querySelector("td[title]");
    expect(debtCell).toHaveAttribute("title", "节点提醒 1 · 滚动提醒 2");
    expect(debtCell).toHaveTextContent("3");
  });

  it("shows an empty state when nobody is assignee-eligible", async () => {
    canned.analysis = analysisPayload({ agents: [] });
    renderDashboard();

    expect(await screen.findByText("暂无考核数据")).toBeInTheDocument();
  });
});

describe("数据范围提示", () => {
  it("shows the own-scope badge only when the server scoped the numbers", async () => {
    canned.action = actionPayload({ scope: "own" });
    canned.analysis = analysisPayload({ scope: "own" });
    renderDashboard();

    expect(await screen.findByText("仅统计我名下的工单")).toBeInTheDocument();
  });

  it("hides the badge for view_all scopes", async () => {
    renderDashboard();

    expect(await screen.findByText("需要行动")).toBeInTheDocument();
    expect(screen.queryByText("仅统计我名下的工单")).not.toBeInTheDocument();
  });
});

describe("加载失败", () => {
  it("surfaces the action query error", async () => {
    canned.action = null;
    renderDashboard();

    expect(await screen.findByText("看板数据加载失败")).toBeInTheDocument();
  });

  it("surfaces the analysis query error", async () => {
    canned.analysis = null;
    renderDashboard();

    expect(await screen.findByText("看板数据加载失败")).toBeInTheDocument();
  });
});
