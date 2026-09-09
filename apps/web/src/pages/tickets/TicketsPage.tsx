import type { AppRouter } from "@insuredesk/api";
import {
  BATCH_ASSIGN_LIMIT,
  DEFAULT_TICKET_SOURCE_FILTER,
  isTicketInFlight,
  POLICY_NUMBER_STATE_FILTERS,
  type PolicyNumberStateFilter,
  TICKET_DISPLAY_STATUSES,
  TICKET_FIELDS,
  TICKET_SOURCE_LABELS,
  TICKET_SOURCES,
  TICKET_STATUS_LABELS,
  type TicketListQuery,
} from "@insuredesk/shared";
import { keepPreviousData } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import { Plus, Ticket, Upload, UserPlus, Zap } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/contexts/AuthContext";
import { formatDateTime } from "@/lib/datetime";
import { trpc } from "@/lib/trpc";
import { CreatedRangeFilter } from "@/pages/ticket-surface/CreatedRangeFilter";
import { MultiSelectFilter } from "@/pages/ticket-surface/MultiSelectFilter";
import { PolicyNumbersCell } from "@/pages/ticket-surface/PolicyNumbersCell";
import { StatusBadge } from "@/pages/ticket-surface/StatusBadge";
import { TicketExportButton } from "@/pages/ticket-surface/TicketExportButton";
import { TicketListSearch } from "@/pages/ticket-surface/TicketListSearch";
import {
  type SurfaceColumn,
  type SurfaceSelection,
  TicketSurface,
} from "@/pages/ticket-surface/TicketSurface";
import { downloadTicketExport } from "@/pages/ticket-surface/ticket-export";
import { Unknown } from "@/pages/ticket-surface/Unknown";
import { type AssignTarget, AssignTicketDialog } from "./AssignTicketDialog";
import { AutoAssignDialog } from "./AutoAssignDialog";
import { type ResolveTarget, ResolveTicketDialog } from "./ResolveTicketDialog";
import { TicketCreateDialog } from "./TicketCreateDialog";
import { TicketDetailPane } from "./TicketDetailPane";
import { TicketImportDialog } from "./TicketImportDialog";
import { parseTicketListQuery, serializeSelection } from "./ticket-list-query";

type ListItem = inferRouterOutputs<AppRouter>["ticket"]["list"]["items"][number];

function useTicketList(query: TicketListQuery) {
  const listQuery = trpc.ticket.list.useQuery(query, { placeholderData: keepPreviousData });
  return {
    items: listQuery.data?.items ?? [],
    total: listQuery.data?.total ?? 0,
    isLoading: listQuery.isLoading,
    isPlaceholderData: listQuery.isPlaceholderData,
    error: listQuery.error,
  };
}

function toTarget(ticket: ListItem): AssignTarget {
  return {
    id: ticket.id,
    workOrderNumber: ticket.workOrderNumber,
    assigneeId: ticket.assigneeId,
    assigneeName: ticket.assigneeName,
    dueAt: ticket.dueAt,
  };
}

const STATUS_FILTER_OPTIONS = TICKET_DISPLAY_STATUSES.map((status) => ({
  value: status,
  label: TICKET_STATUS_LABELS[status],
}));
const POLICY_NUMBER_STATE_LABELS: Record<PolicyNumberStateFilter, string> = {
  none: "无保单号",
};
const POLICY_NUMBER_STATE_OPTIONS = POLICY_NUMBER_STATE_FILTERS.map((state) => ({
  value: state,
  label: POLICY_NUMBER_STATE_LABELS[state],
}));
const SOURCE_FILTER_OPTIONS = TICKET_SOURCES.map((source) => ({
  value: source,
  label: TICKET_SOURCE_LABELS[source],
}));

export function TicketsPage({ createOpen = false }: { createOpen?: boolean }) {
  const { hasPermission } = useAuth();
  const navigate = useNavigate();
  const canCreate = hasPermission("ticket.create");
  const canAssign = hasPermission("ticket.assign");
  const canBatchAssign = hasPermission("ticket.batch_assign");
  const canProcess = hasPermission("ticket.process");
  const canExport = hasPermission("ticket.export");
  const canImport = hasPermission("ticket.import");
  const canRowActions = canAssign || canProcess;

  const [singleTarget, setSingleTarget] = useState<AssignTarget | null>(null);
  const [resolveTarget, setResolveTarget] = useState<ResolveTarget | null>(null);
  const [batchOpen, setBatchOpen] = useState(false);
  const [autoTargets, setAutoTargets] = useState<AssignTarget[] | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [highlightId, setHighlightId] = useState<string | null>(null);

  // 目录筛选全列目录项（停用项标注），选停用项仍能查到其存量工单
  const kindOptions = trpc.ticketKind.filterOptions.useQuery().data ?? [];
  const channelOptions = trpc.channel.filterOptions.useQuery().data ?? [];
  const categoryOptions = trpc.ticketCategory.filterOptions.useQuery().data ?? [];
  const completionStatusOptions = trpc.completionStatus.filterOptions.useQuery().data ?? [];
  // 策略筛选只列启用项（sla.options 口径），与目录 filterOptions 的停用标注口径不同
  const slaOptions = trpc.sla.options.useQuery().data ?? [];
  // 责任人筛选与分配对话框同一候选来源（assigneeOptions）
  const assigneeOptions = trpc.ticket.assigneeOptions.useQuery().data ?? [];

  const kinds = useMemo(
    () =>
      kindOptions.map((kind) => ({
        value: kind.id,
        label: kind.active ? kind.name : `${kind.name}（已停用）`,
      })),
    [kindOptions],
  );
  const channels = useMemo(
    () =>
      channelOptions.map((channel) => ({
        value: channel.id,
        label: channel.active ? channel.name : `${channel.name}（已停用）`,
      })),
    [channelOptions],
  );
  const categories = useMemo(
    () =>
      categoryOptions.map((category) => ({
        value: category.id,
        label: category.active ? category.name : `${category.name}（已停用）`,
      })),
    [categoryOptions],
  );
  const completionStatuses = useMemo(
    () =>
      completionStatusOptions.map((status) => ({
        value: status.id,
        label: status.active ? status.name : `${status.name}（已停用）`,
      })),
    [completionStatusOptions],
  );
  const slaPolicies = useMemo(
    () => slaOptions.map((policy) => ({ value: policy.id, label: policy.name })),
    [slaOptions],
  );
  const assignees = useMemo(
    () => assigneeOptions.map((user) => ({ value: user.id, label: user.name })),
    [assigneeOptions],
  );

  const columns: ReadonlyArray<SurfaceColumn<ListItem, TicketListQuery>> = useMemo(
    () => [
      {
        key: "workOrderNumber",
        header: "工单号",
        render: (ticket, ctx) => (
          <Link
            to={ctx.ticketPath(ticket.id)}
            className="font-medium hover:underline"
            onClick={(event) => event.stopPropagation()}
          >
            {ticket.workOrderNumber}
          </Link>
        ),
      },
      {
        key: "status",
        header: "状态",
        render: (ticket) => <StatusBadge status={ticket.displayStatus} />,
      },
      {
        key: "customerName",
        header: TICKET_FIELDS.customerName.label,
        render: (ticket) => ticket.customerName ?? <Unknown />,
      },
      {
        key: "policyNumbers",
        header: TICKET_FIELDS.policyNumbers.label,
        render: (ticket) => (
          <PolicyNumbersCell
            policyNumbers={ticket.policyNumbers}
            noPolicyNumber={ticket.noPolicyNumber}
          />
        ),
      },
      {
        key: "channel",
        header: TICKET_FIELDS.channelId.overrides.listLabel,
        render: (ticket) => ticket.channel ?? <Unknown />,
      },
      {
        key: "slaPolicy",
        header: TICKET_FIELDS.slaPolicyId.label,
        render: (ticket) => ticket.slaPolicyName ?? <Unknown />,
      },
      {
        key: "source",
        header: "来源",
        render: (ticket) => TICKET_SOURCE_LABELS[ticket.source],
      },
      {
        key: "createdBy",
        header: "创建人",
        render: (ticket) => ticket.createdBy ?? <Unknown />,
      },
      {
        key: "assignee",
        header: "责任人",
        render: (ticket) =>
          ticket.assigneeName ?? <span className="text-muted-foreground">未分配</span>,
      },
      {
        key: "createdAt",
        header: "创建时间",
        sort: { field: "createdAt", initialOrder: "desc" },
        render: (ticket) => formatDateTime(ticket.createdAt),
      },
      {
        key: "dueAt",
        header: "处理时限",
        // 处理时限 defaults to soonest-first — that's the queue-working order
        sort: { field: "dueAt", initialOrder: "asc" },
        render: (ticket) =>
          // dueAt null = 策略不设时限（如出厂特急行）when a policy exists, 未指定策略 otherwise
          ticket.dueAt ? (
            formatDateTime(ticket.dueAt)
          ) : ticket.slaPolicyId ? (
            <span className="text-muted-foreground">不设时限</span>
          ) : (
            <Unknown />
          ),
      },
      ...(canRowActions
        ? [
            {
              key: "actions",
              header: "操作",
              headClassName: "w-40",
              render: (ticket: ListItem) => (
                /* stopPropagation everywhere: a quick action must
                 never double as the row's open-detail click */
                <div className="flex items-center whitespace-nowrap opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                  {canAssign && ticket.status !== "completed" && (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(event) => {
                          event.stopPropagation();
                          setSingleTarget(toTarget(ticket));
                        }}
                      >
                        {ticket.assigneeId ? "改派" : "分配"}
                      </Button>
                      {ticket.assigneeId === null && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(event) => {
                            event.stopPropagation();
                            setAutoTargets([toTarget(ticket)]);
                          }}
                        >
                          自动分配
                        </Button>
                      )}
                    </>
                  )}
                  {canProcess && isTicketInFlight(ticket.status) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(event) => {
                        event.stopPropagation();
                        setResolveTarget({
                          id: ticket.id,
                          workOrderNumber: ticket.workOrderNumber,
                        });
                      }}
                    >
                      完结
                    </Button>
                  )}
                </div>
              ),
            } satisfies SurfaceColumn<ListItem, TicketListQuery>,
          ]
        : []),
    ],
    [canAssign, canProcess, canRowActions],
  );

  const isRowHighlighted = useCallback(
    (ticket: ListItem) => ticket.id === highlightId,
    [highlightId],
  );

  const selection: SurfaceSelection<ListItem, TicketListQuery> | undefined = useMemo(
    () =>
      canBatchAssign
        ? {
            // completed is terminal — never selectable for assignment
            selectable: (ticket) => ticket.status !== "completed",
            rowLabel: (ticket) => `选择工单 ${ticket.workOrderNumber}`,
            pageLabel: "选择本页全部工单",
            bar: (selected, { clearSelection }) => {
              const targets = [...selected.values()];
              const selectedHasAssigned = targets.some((ticket) => ticket.assigneeId !== null);
              return (
                <>
                  <span>已选 {selected.size} 个工单</span>
                  <Button
                    size="sm"
                    disabled={selected.size > BATCH_ASSIGN_LIMIT}
                    onClick={() => setBatchOpen(true)}
                  >
                    <UserPlus data-icon="inline-start" />
                    批量分配
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={selectedHasAssigned || selected.size > BATCH_ASSIGN_LIMIT}
                    onClick={() => setAutoTargets(targets.map(toTarget))}
                  >
                    <Zap data-icon="inline-start" />
                    按排班自动分配
                  </Button>
                  <Button size="sm" variant="ghost" onClick={clearSelection}>
                    清除选择
                  </Button>
                  {selected.size > BATCH_ASSIGN_LIMIT && (
                    <span className="text-destructive">
                      一次最多分配 {BATCH_ASSIGN_LIMIT} 个，请减少选择
                    </span>
                  )}
                  {selectedHasAssigned && (
                    <span className="text-muted-foreground">自动分配仅适用于未分配工单</span>
                  )}
                </>
              );
            },
          }
        : undefined,
    [canBatchAssign],
  );

  return (
    <TicketSurface
      basePath="/tickets"
      parseQuery={parseTicketListQuery}
      useList={useTicketList}
      title="工单管理"
      subtitle="客诉工单的创建、分配与跟进。"
      headerActions={({ query }) => (
        <>
          {canExport && (
            <TicketExportButton onExport={(format) => downloadTicketExport(query, format)} />
          )}
          {canImport && (
            <Button variant="outline" onClick={() => setImportOpen(true)}>
              <Upload data-icon="inline-start" />
              导入
            </Button>
          )}
          {canCreate && (
            <Button asChild>
              <Link to="/tickets/new">
                <Plus data-icon="inline-start" />
                新建工单
              </Link>
            </Button>
          )}
        </>
      )}
      filters={({
        query,
        searchDraft,
        setSearchDraft,
        submitSearch,
        clearSearch,
        setParam,
        setParams,
      }) => (
        <>
          <MultiSelectFilter
            label="状态"
            values={query.status ?? []}
            options={STATUS_FILTER_OPTIONS}
            onChange={(values) => setParam("status", serializeSelection(values, []))}
          />
          <MultiSelectFilter
            label="种类"
            values={query.kindId ?? []}
            options={kinds}
            onChange={(values) => setParam("kind", serializeSelection(values, []))}
          />
          <MultiSelectFilter
            label={TICKET_FIELDS.channelId.overrides.listLabel}
            values={query.channelId ?? []}
            options={channels}
            onChange={(values) => setParam("channel", serializeSelection(values, []))}
          />
          <MultiSelectFilter
            label={TICKET_FIELDS.categoryId.overrides.listLabel}
            values={query.categoryId ?? []}
            options={categories}
            onChange={(values) => setParam("category", serializeSelection(values, []))}
          />
          <MultiSelectFilter
            label={TICKET_FIELDS.completionStatusId.label}
            values={query.completionStatusId ?? []}
            options={completionStatuses}
            onChange={(values) => setParam("completionStatus", serializeSelection(values, []))}
          />
          <MultiSelectFilter
            label={TICKET_FIELDS.slaPolicyId.label}
            values={query.slaPolicyId ?? []}
            options={slaPolicies}
            onChange={(values) =>
              // 回写规范参数名并清掉遗留别名 policyId（旧下钻链接只读兼容）
              setParams({ slaPolicyId: serializeSelection(values, []), policyId: null })
            }
          />
          <MultiSelectFilter
            label="责任人"
            values={query.assigneeId ?? []}
            options={assignees}
            onChange={(values) => setParam("assigneeId", serializeSelection(values, []))}
          />
          <Select
            value={query.firstResponse ?? "all"}
            onValueChange={(value) => setParam("firstResponse", value === "all" ? null : value)}
          >
            <SelectTrigger size="sm" aria-label="首响">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部首响状态</SelectItem>
              <SelectItem value="pending">待首响</SelectItem>
            </SelectContent>
          </Select>
          <MultiSelectFilter
            label={TICKET_FIELDS.policyNumbers.label}
            values={query.policyNumberState ?? []}
            options={POLICY_NUMBER_STATE_OPTIONS}
            onChange={(values) => setParam("policyNumber", serializeSelection(values, []))}
          />
          {/* 来源有缺省（排除归档单）：全选四个来源 ≠ 缺省，仍写入 URL */}
          <MultiSelectFilter
            label="来源"
            values={query.source}
            options={SOURCE_FILTER_OPTIONS}
            onChange={(values) =>
              setParam("source", serializeSelection(values, DEFAULT_TICKET_SOURCE_FILTER))
            }
          />
          <CreatedRangeFilter
            range={{ createdFrom: query.createdFrom, createdTo: query.createdTo }}
            onChange={(range) =>
              setParams({
                createdFrom: range.createdFrom ?? null,
                createdTo: range.createdTo ?? null,
              })
            }
          />
          <TicketListSearch
            draft={searchDraft}
            onDraftChange={setSearchDraft}
            onSubmit={submitSearch}
            onClear={clearSearch}
            placeholder="工单号 / 客户姓名 / 保单号 / 电话"
          />
        </>
      )}
      activeFilterCount={(query) =>
        [
          query.status?.length,
          query.kindId?.length,
          query.channelId?.length,
          query.categoryId?.length,
          query.completionStatusId?.length,
          query.slaPolicyId?.length,
          query.assigneeId?.length,
          query.firstResponse ? 1 : 0,
          query.policyNumberState?.length,
          query.search ? 1 : 0,
          query.createdFrom || query.createdTo ? 1 : 0,
        ].filter((count) => (count ?? 0) > 0).length
      }
      columns={columns}
      emptyState={{
        icon: <Ticket />,
        title: "暂无匹配的工单",
        description: () => "调整筛选条件，或新建一条工单。",
      }}
      narrowItem={(ticket) => ({
        id: ticket.id,
        customerName: ticket.customerName,
        status: ticket.displayStatus,
        time: ticket.dueAt,
        overdue: ticket.displayStatus === "overdue",
      })}
      renderDetail={(props) => <TicketDetailPane {...props} />}
      selection={selection}
      isRowHighlighted={isRowHighlighted}
      dialogs={({ selected, clearSelection, removeSelected }) => (
        <>
          {canCreate && (
            <TicketCreateDialog
              open={createOpen}
              onOpenChange={(open) => {
                if (!open) navigate("/tickets");
              }}
              onCreated={(ticket) => setHighlightId(ticket.id)}
            />
          )}

          {canImport && <TicketImportDialog open={importOpen} onOpenChange={setImportOpen} />}

          {canAssign && singleTarget && (
            <AssignTicketDialog
              mode="single"
              open
              onOpenChange={(open) => {
                if (!open) setSingleTarget(null);
              }}
              targets={[singleTarget]}
            />
          )}

          {canProcess && resolveTarget && (
            <ResolveTicketDialog
              open
              onOpenChange={(open) => {
                if (!open) setResolveTarget(null);
              }}
              ticket={resolveTarget}
            />
          )}

          {canBatchAssign && (
            <AssignTicketDialog
              mode="batch"
              open={batchOpen}
              onOpenChange={setBatchOpen}
              targets={[...selected.values()].map(toTarget)}
              onAssigned={clearSelection}
            />
          )}

          {(canAssign || canBatchAssign) && autoTargets && (
            <AutoAssignDialog
              open
              onOpenChange={(open) => {
                if (!open) setAutoTargets(null);
              }}
              targets={autoTargets}
              onAssigned={removeSelected}
            />
          )}
        </>
      )}
    />
  );
}
