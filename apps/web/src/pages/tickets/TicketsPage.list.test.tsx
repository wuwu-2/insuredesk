import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { auth, callsTo, renderApp, userWith } from "@/test/renderApp";
import { TEST_ROLES } from "@/test/roles";

type ListItem = {
  id: string;
  workOrderNumber: string;
  createdAt: string;
  source: string;
  createdBy: string | null;
  channel: string;
  category: string;
  complaintLevel: string;
  slaPolicyId: string;
  slaPolicyName: string;
  customerName: string;
  policyNumbers: string[];
  noPolicyNumber?: boolean;
  status: string;
  displayStatus: string;
  assigneeName: string | null;
  dueAt: string | null;
};

function listItem(overrides: Partial<ListItem> = {}): ListItem {
  return {
    id: "t1",
    workOrderNumber: "WO100001",
    createdAt: "2026-07-09T02:00:00.000Z",
    source: "manual",
    createdBy: "建单人甲",
    channel: "保司",
    category: "投诉-保费收取问题",
    complaintLevel: "一般投诉",
    slaPolicyId: "pol-normal",
    slaPolicyName: "一般投诉",
    customerName: "王小明",
    policyNumbers: ["P2026070900123"],
    status: "processing",
    displayStatus: "processing",
    assigneeName: "李客服",
    dueAt: "2026-07-11T02:00:00.000Z",
    ...overrides,
  };
}

/** sla.options 的筛选 feed：仅启用策略（目录序）。 */
const SLA_OPTIONS = [
  { id: "pol-normal", name: "一般投诉", description: "常规投诉：48 小时处理时限。" },
  { id: "pol-high", name: "高级投诉", description: "重要投诉：48 小时处理时限。" },
  { id: "pol-urgent", name: "特急投诉", description: "特急投诉：不设处理时限。" },
];

const canned = { items: [] as ListItem[], total: 0 };

function renderAt(path: string) {
  return renderApp({
    path,
    trpc: {
      "ticketKind.filterOptions": [
        { id: "kind-complaint", name: "投诉", active: true },
        { id: "kind-refund", name: "退费异常", active: true },
      ],
      "channel.filterOptions": [
        { id: "ch-baosi", name: "保司", active: true },
        { id: "ch-pay", name: "支付", active: true },
        { id: "ch-legacy", name: "旧渠道", active: false },
      ],
      "ticketCategory.filterOptions": [
        { id: "cat-claims", name: "理赔咨询", active: true },
        { id: "cat-legacy", name: "旧类别", active: false },
      ],
      "completionStatus.filterOptions": [
        { id: "cs-normal", name: "正常完结", active: true },
        { id: "cs-legacy", name: "旧完结状态", active: false },
      ],
      "sla.options": SLA_OPTIONS,
      "ticket.list": (input: unknown) => {
        const page =
          ((input as Record<string, unknown> | undefined)?.page as number | undefined) ?? 1;
        return { items: canned.items, total: canned.total, page, pageSize: 20 };
      },
    },
  });
}

function listInputs(): Array<Record<string, unknown>> {
  return callsTo("ticket.list").map((call) => call.input as Record<string, unknown>);
}

beforeEach(() => {
  auth.user = userWith(TEST_ROLES.CS_MANAGER);
  canned.items = [];
  canned.total = 0;
});

describe("list rendering", () => {
  it("renders one row per ticket with the computed display status", async () => {
    canned.items = [
      listItem(),
      listItem({
        id: "t2",
        workOrderNumber: "WO100002",
        customerName: "赵一超",
        status: "assigned",
        displayStatus: "overdue",
        assigneeName: null,
      }),
    ];
    canned.total = 2;

    renderAt("/tickets");

    expect(await screen.findByText("WO100001")).toBeInTheDocument();
    expect(screen.getByText("WO100002")).toBeInTheDocument();
    expect(screen.getByText("王小明")).toBeInTheDocument();
    expect(screen.getByText("已超时")).toBeInTheDocument();
    expect(screen.queryByText("已分配")).not.toBeInTheDocument();
  });

  it.each([
    { source: "manual", createdBy: "建单人甲", expected: "建单人甲" },
    { source: "feishu_form", createdBy: "飞书", expected: "飞书" },
    { source: "manual", createdBy: null, expected: "—" },
  ])("创建人列显示 $expected（来源 $source）", async ({ source, createdBy, expected }) => {
    canned.items = [listItem({ source, createdBy })];
    canned.total = 1;
    renderAt("/tickets");

    const row = await screen.findByRole("row", { name: /WO100001/ });
    const columnIndex = screen
      .getAllByRole("columnheader")
      .findIndex((header) => header.textContent === "创建人");
    expect(columnIndex).toBeGreaterThan(-1);
    expect(within(row).getAllByRole("cell")[columnIndex]).toHaveTextContent(expected);
  });

  it("shows an empty state when nothing matches", async () => {
    renderAt("/tickets");
    expect(await screen.findByText("暂无匹配的工单")).toBeInTheDocument();
  });

  it("时效策略列：列头与单元格都走策略名（引用口径，不读旧等级文本）", async () => {
    canned.items = [listItem({ slaPolicyName: "VIP 通道", complaintLevel: "特急投诉" })];
    canned.total = 1;
    renderAt("/tickets");

    const row = (await screen.findByText("WO100001")).closest("tr") as HTMLTableRowElement;
    expect(within(row).getByText("VIP 通道")).toBeInTheDocument();
    expect(within(row).queryByText("特急投诉")).not.toBeInTheDocument();
  });
});

describe("保单号列: 首个 + N 徽标", () => {
  it("单保单号原样展示，无徽标", async () => {
    canned.items = [listItem({ policyNumbers: ["P-ONLY-001"] })];
    canned.total = 1;
    renderAt("/tickets");

    expect(await screen.findByText("P-ONLY-001")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /还有.*个保单号/ })).not.toBeInTheDocument();
  });

  it("空数组沿用未填写占位，不展示徽标", async () => {
    canned.items = [listItem({ policyNumbers: [] })];
    canned.total = 1;
    renderAt("/tickets");

    await screen.findByText("WO100001");
    const row = screen.getByText("WO100001").closest("tr") as HTMLTableRowElement;
    expect(within(row).getByText("—")).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: /还有.*个保单号/ })).not.toBeInTheDocument();
  });

  it("「无保单号」工单显示 muted 的无，与未填写占位区分", async () => {
    canned.items = [listItem({ policyNumbers: [], noPolicyNumber: true })];
    canned.total = 1;
    renderAt("/tickets");

    await screen.findByText("WO100001");
    const row = screen.getByText("WO100001").closest("tr") as HTMLTableRowElement;
    expect(within(row).getByText("无")).toBeInTheDocument();
    expect(within(row).queryByText("—")).not.toBeInTheDocument();
  });

  it("多保单号只显首个 + N 徽标，点徽标弹出全部", async () => {
    canned.items = [listItem({ policyNumbers: ["P-FIRST-001", "P-SECOND-002", "P-THIRD-003"] })];
    canned.total = 1;
    renderAt("/tickets");

    expect(await screen.findByText("P-FIRST-001")).toBeInTheDocument();
    expect(screen.queryByText("P-SECOND-002")).not.toBeInTheDocument();

    const badge = screen.getByRole("button", { name: "还有 2 个保单号" });
    expect(badge).toHaveTextContent("+2");

    fireEvent.click(badge);
    const popover = await screen.findByRole("dialog");
    expect(within(popover).getByText("P-FIRST-001")).toBeInTheDocument();
    expect(within(popover).getByText("P-SECOND-002")).toBeInTheDocument();
    expect(within(popover).getByText("P-THIRD-003")).toBeInTheDocument();
  });

  it("点徽标展开保单号不连带打开行详情", async () => {
    canned.items = [listItem({ policyNumbers: ["P-A-1", "P-B-2"] })];
    canned.total = 1;
    renderAt("/tickets");

    fireEvent.click(await screen.findByRole("button", { name: "还有 1 个保单号" }));
    await screen.findByRole("dialog");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });
});

describe("URL-driven filters (deep-linkable)", () => {
  it("passes status/channel from the query string into ticket.list", async () => {
    renderAt("/tickets?status=overdue&channel=ch-pay");

    await waitFor(() => expect(listInputs().length).toBeGreaterThan(0));
    expect(listInputs()[0]).toMatchObject({ status: ["overdue"], channelId: ["ch-pay"] });
  });

  it("逗号分隔的多值参数解析为数组", async () => {
    renderAt("/tickets?status=overdue,completed&policyId=pol-normal,pol-high");

    await waitFor(() => expect(listInputs().length).toBeGreaterThan(0));
    expect(listInputs()[0]).toMatchObject({
      status: ["overdue", "completed"],
      slaPolicyId: ["pol-normal", "pol-high"],
    });
  });

  it("时效策略筛选：?policyId= 入参落到 slaPolicyId，触发器挂计数徽标", async () => {
    renderAt("/tickets?policyId=pol-urgent");

    await waitFor(() => expect(listInputs().length).toBeGreaterThan(0));
    expect(listInputs()[0]).toMatchObject({ slaPolicyId: ["pol-urgent"] });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "时效策略" })).toHaveTextContent("1"),
    );
  });

  it("种类筛选：?kind= 入参落到 kindId，触发器挂计数徽标", async () => {
    renderAt("/tickets?kind=kind-refund");

    await waitFor(() => expect(listInputs().length).toBeGreaterThan(0));
    expect(listInputs()[0]).toMatchObject({ kindId: ["kind-refund"] });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "种类" })).toHaveTextContent("1"),
    );
  });

  it("勾选种类写 URL 并回第 1 页", async () => {
    renderAt("/tickets?page=3");
    await waitFor(() => expect(listInputs().length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole("button", { name: "种类" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "退费异常" }));

    await waitFor(() =>
      expect(listInputs().at(-1)).toMatchObject({ kindId: ["kind-refund"], page: 1 }),
    );
  });

  it("种类筛选与其他筛选共存（AND 语义由服务端保证）", async () => {
    renderAt("/tickets?kind=kind-refund&status=processing");

    await waitFor(() => expect(listInputs().length).toBeGreaterThan(0));
    expect(listInputs()[0]).toMatchObject({ kindId: ["kind-refund"], status: ["processing"] });
  });

  it("旧 ?level= 参数静默忽略：不按等级筛选，也不报错", async () => {
    renderAt("/tickets?level=%E4%B8%80%E8%88%AC%E6%8A%95%E8%AF%89");

    await waitFor(() => expect(listInputs().length).toBeGreaterThan(0));
    expect(listInputs()[0]?.complaintLevel).toBeUndefined();
    expect(listInputs()[0]?.slaPolicyId).toBeUndefined();
    expect(await screen.findByText("暂无匹配的工单")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "时效策略" })).not.toHaveTextContent(/\d/);
  });

  it("类别筛选：查询串带 category id，入参落到 categoryId，触发器挂计数徽标", async () => {
    renderAt("/tickets?category=cat-claims");

    await waitFor(() => expect(listInputs().length).toBeGreaterThan(0));
    expect(listInputs()[0]).toMatchObject({ categoryId: ["cat-claims"] });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "类别" })).toHaveTextContent("1"),
    );
  });

  // 停用项为何仍在筛选 feed 里、按停用 id 为何还能筛到存量工单, 是服务端规则。
  it.each([
    {
      param: "channel",
      id: "ch-legacy",
      inputKey: "channelId",
      label: "渠道",
      name: "旧渠道（已停用）",
    },
    {
      param: "category",
      id: "cat-legacy",
      inputKey: "categoryId",
      label: "类别",
      name: "旧类别（已停用）",
    },
    {
      param: "completionStatus",
      id: "cs-legacy",
      inputKey: "completionStatusId",
      label: "完结状态",
      name: "旧完结状态（已停用）",
    },
  ])("按停用$label筛选：查询带其 id，弹层选项带（已停用）标注且已勾选", async (row) => {
    renderAt(`/tickets?${row.param}=${row.id}`);

    await waitFor(() => expect(listInputs().length).toBeGreaterThan(0));
    expect(listInputs()[0]).toMatchObject({ [row.inputKey]: [row.id] });

    fireEvent.click(screen.getByRole("button", { name: row.label }));
    const option = await screen.findByRole("checkbox", { name: row.name });
    expect(option).toBeChecked();
  });

  it("ignores an invalid query string and lists with defaults", async () => {
    renderAt("/tickets?status=nonsense&page=x");

    await waitFor(() => expect(listInputs().length).toBeGreaterThan(0));
    expect(listInputs()[0]?.status).toBeUndefined();
    expect(listInputs()[0]).toMatchObject({ page: 1 });
  });

  it("keeps valid filters when a neighbouring param is malformed", async () => {
    renderAt("/tickets?status=overdue&page=x");

    await waitFor(() => expect(listInputs().length).toBeGreaterThan(0));
    expect(listInputs()[0]).toMatchObject({ status: ["overdue"], page: 1 });
  });
});

describe("归档工单默认隐藏（来源缺省）", () => {
  it("无 source 参数时 ticket.list 入参缺省排除 file_import", async () => {
    renderAt("/tickets");

    await waitFor(() => expect(listInputs().length).toBeGreaterThan(0));
    expect(listInputs()[0]?.source).toEqual([
      "feishu_form",
      "manual",
      "community",
      "external_channel",
      "jb-insurance",
    ]);
    expect(screen.getByRole("button", { name: "来源" })).toHaveTextContent("5");
  });

  it("清空来源 → 空值参数下传，服务端按不过滤处理", async () => {
    renderAt("/tickets");

    fireEvent.click(screen.getByRole("button", { name: "来源" }));
    fireEvent.click(await screen.findByRole("button", { name: "清空" }));

    await waitFor(() => expect(listInputs().at(-1)?.source).toEqual([]));
  });

  it("勾选文件导入后归档单进入筛选集", async () => {
    renderAt("/tickets");

    fireEvent.click(screen.getByRole("button", { name: "来源" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "文件导入" }));

    await waitFor(() =>
      expect(listInputs().at(-1)?.source).toEqual([
        "feishu_form",
        "manual",
        "community",
        "external_channel",
        "jb-insurance",
        "file_import",
      ]),
    );
  });
});

describe("多选交互与 URL 序列化", () => {
  async function toggleOption(filterLabel: string, optionName: string) {
    fireEvent.click(screen.getByRole("button", { name: filterLabel }));
    fireEvent.click(await screen.findByRole("checkbox", { name: optionName }));
  }

  it("勾选多个状态 → 数组入参 + 触发器计数徽标", async () => {
    renderAt("/tickets?status=overdue");
    await waitFor(() =>
      expect(listInputs().some((input) => Array.isArray(input.status))).toBe(true),
    );

    await toggleOption("状态", "已完结");
    await waitFor(() => expect(listInputs().at(-1)?.status).toEqual(["overdue", "completed"]));
    expect(screen.getByRole("button", { name: "状态" })).toHaveTextContent("2");
  });

  it("清空 = 回到全部：参数移除，入参不过滤", async () => {
    renderAt("/tickets?status=overdue,completed");
    await waitFor(() => expect(listInputs().length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole("button", { name: "状态" }));
    fireEvent.click(await screen.findByRole("button", { name: "清空" }));

    await waitFor(() => expect(listInputs().at(-1)?.status).toBeUndefined());
    expect(screen.getByRole("button", { name: "状态" })).not.toHaveTextContent(/\d/);
  });

  it("全选写入完整选项集", async () => {
    renderAt("/tickets");
    await waitFor(() => expect(listInputs().length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole("button", { name: "时效策略" }));
    fireEvent.click(await screen.findByRole("button", { name: "全选" }));

    await waitFor(() =>
      expect(listInputs().at(-1)?.slaPolicyId).toEqual(["pol-normal", "pol-high", "pol-urgent"]),
    );
  });

  it("再次点击已勾选项取消选择", async () => {
    renderAt("/tickets?policyId=pol-normal");
    await waitFor(() => expect(listInputs().length).toBeGreaterThan(0));

    await toggleOption("时效策略", "一般投诉");
    await waitFor(() => expect(listInputs().at(-1)?.slaPolicyId).toBeUndefined());
  });

  it("筛选变更后 URL 落在地址栏（深链可分享），并重置页码", async () => {
    renderAt("/tickets?status=overdue&page=2");
    await waitFor(() => expect(listInputs().length).toBeGreaterThan(0));

    await toggleOption("状态", "已完结");

    await waitFor(() => expect(listInputs().at(-1)?.status).toEqual(["overdue", "completed"]));
    expect(listInputs().at(-1)).toMatchObject({ page: 1 });
  });
});

describe("search / sort / pagination re-query", () => {
  it("submitting the search box queries with the entered text", async () => {
    renderAt("/tickets");
    await waitFor(() => expect(listInputs().length).toBeGreaterThan(0));

    const searchBox = screen.getByRole("searchbox");
    fireEvent.change(searchBox, { target: { value: "三丰" } });
    fireEvent.submit(searchBox.closest("form") as HTMLFormElement);

    await waitFor(() => expect(listInputs().at(-1)).toMatchObject({ search: "三丰" }));
  });

  it("clicking 创建时间 flips to ascending; clicking 处理时限 sorts by dueAt soonest-first", async () => {
    canned.items = [listItem()];
    canned.total = 1;
    renderAt("/tickets");
    await screen.findByText("WO100001");

    // 同名的创建时间筛选器也在页面上，排序表头按精确名字定位
    fireEvent.click(screen.getByRole("button", { name: "创建时间" }));
    await waitFor(() =>
      expect(listInputs().at(-1)).toMatchObject({ sortBy: "createdAt", sortOrder: "asc" }),
    );

    fireEvent.click(screen.getByRole("button", { name: /处理时限/ }));
    await waitFor(() =>
      expect(listInputs().at(-1)).toMatchObject({ sortBy: "dueAt", sortOrder: "asc" }),
    );
  });

  it("下一页 advances the page against the filtered total", async () => {
    canned.items = [listItem()];
    canned.total = 45;
    renderAt("/tickets");
    await screen.findByText("WO100001");
    expect(screen.getByText(/共 45 条/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => expect(listInputs().at(-1)).toMatchObject({ page: 2 }));
  });
});
