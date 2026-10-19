import { ArrowDown, ArrowUp, ChevronDown, ChevronUp } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";

interface RegionRankingProps {
  regionNames: ReadonlyMap<string, string>;
  regionCounts: ReadonlyMap<string, number>;
  regionType: string;
  onRegionClick?: (code: string) => void;
}

type SortOrder = "desc" | "asc";

export function RegionRanking({
  regionNames,
  regionCounts,
  regionType,
  onRegionClick,
}: RegionRankingProps) {
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");
  const [isCollapsed, setIsCollapsed] = useState(false);

  const rankedRegions = useMemo(() => {
    const regions = Array.from(regionCounts.entries())
      .map(([code, count]) => ({
        code,
        name: regionNames.get(code) ?? code,
        count,
      }))
      .filter((region) => region.count > 0);

    regions.sort((a, b) => {
      if (sortOrder === "desc") {
        return b.count - a.count;
      }
      return a.count - b.count;
    });

    return regions;
  }, [regionCounts, regionNames, sortOrder]);

  const toggleSort = () => {
    setSortOrder((prev) => (prev === "desc" ? "asc" : "desc"));
  };

  const total = useMemo(() => rankedRegions.reduce((sum, r) => sum + r.count, 0), [rankedRegions]);

  return (
    <Card className="absolute left-4 top-4 z-10 w-80 shadow-lg">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">{regionType}排名</CardTitle>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={toggleSort}
              className="h-8 px-2"
              aria-label={sortOrder === "desc" ? "切换为升序" : "切换为降序"}
            >
              {sortOrder === "desc" ? (
                <>
                  <ArrowDown className="h-4 w-4" />
                  降序
                </>
              ) : (
                <>
                  <ArrowUp className="h-4 w-4" />
                  升序
                </>
              )}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setIsCollapsed(!isCollapsed)}
              className="h-8 px-2"
              aria-label={isCollapsed ? "展开" : "收起"}
            >
              {isCollapsed ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronUp className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>
        {!isCollapsed && (
          <CardDescription>
            共 {rankedRegions.length} 个{regionType}，{total} 例工单
          </CardDescription>
        )}
      </CardHeader>
      {!isCollapsed && (
        <CardContent className="pb-3">
          <ScrollArea className="h-[400px] pr-4">
            <div className="space-y-2">
              {rankedRegions.map((region, index) => {
                const rank = index + 1;
                const percentage = total > 0 ? ((region.count / total) * 100).toFixed(1) : "0";
                return (
                  <button
                    type="button"
                    key={region.code}
                    className={
                      onRegionClick
                        ? "flex w-full cursor-pointer items-center justify-between rounded-md border p-2 text-left transition-colors hover:bg-accent"
                        : "flex w-full items-center justify-between rounded-md border p-2 text-left"
                    }
                    onClick={() => onRegionClick?.(region.code)}
                    disabled={!onRegionClick}
                  >
                    <div className="flex items-center gap-3">
                      <div
                        className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${
                          rank === 1
                            ? "bg-yellow-500 text-yellow-950"
                            : rank === 2
                              ? "bg-gray-400 text-gray-950"
                              : rank === 3
                                ? "bg-orange-600 text-orange-50"
                                : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {rank}
                      </div>
                      <span className="font-medium">{region.name}</span>
                    </div>
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm text-muted-foreground">{percentage}%</span>
                      <span className="tabular-nums font-semibold">{region.count}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </ScrollArea>
        </CardContent>
      )}
    </Card>
  );
}
