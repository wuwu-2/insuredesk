import type { CreatedRangeQuery, TicketMapLocation } from "@insuredesk/shared";
import { endOfDay, startOfDay, subDays } from "date-fns";
import { AlertCircle, ArrowLeft, RotateCcw, Tags } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Toggle } from "@/components/ui/toggle";
import { useAuth } from "@/contexts/AuthContext";
import {
  type ChinaProvincesGeoJson,
  cityCodeOf,
  loadMapRegionData,
  loadProvinceCityMap,
  type MapRegionData,
} from "@/lib/region";
import { trpc } from "@/lib/trpc";
import { CreatedRangeFilter } from "@/pages/ticket-surface/CreatedRangeFilter";
import { MultiSelectFilter } from "@/pages/ticket-surface/MultiSelectFilter";
import { buildLocationTicketListUrl, layoutMapPoints } from "./map-points";
import { RegionRanking } from "./RegionRanking";
import type { MapArea } from "./TicketMapChart";

const TicketMapChart = lazy(() =>
  import("./TicketMapChart").then((m) => ({ default: m.TicketMapChart })),
);

const DEFAULT_RANGE_DAYS = 90;

/** 直辖市与港澳的下一级是区县，没有市。 */
const DISTRICT_CHILD_PROVINCES = new Set([
  "110000",
  "120000",
  "310000",
  "500000",
  "810000",
  "820000",
]);

function areaLabelNoun(provinceCode: string | null): string {
  if (provinceCode === null) return "省名";
  return DISTRICT_CHILD_PROVINCES.has(provinceCode) ? "区名" : "市名";
}

function defaultRange(now: Date = new Date()): CreatedRangeQuery {
  return {
    createdFrom: startOfDay(subDays(now, DEFAULT_RANGE_DAYS - 1)).toISOString(),
    createdTo: endOfDay(now).toISOString(),
  };
}

function mockLocations(total: number, data: MapRegionData): TicketMapLocation[] {
  const codes = [...data.centers.keys()].filter((code) => !code.endsWith("0000"));
  const locations: TicketMapLocation[] = [];
  let remaining = total;
  for (let i = 0; remaining > 0 && codes.length > 0; i += 1) {
    const code = codes[(i * 7919) % codes.length] as string;
    const count = Math.min(remaining, 1 + ((i * 31) % 40));
    remaining -= count;
    locations.push({
      code,
      provinceCode: `${code.slice(0, 2)}0000`,
      provinceName: `模拟 ${code.slice(0, 2)}`,
      cityName: null,
      districtName: code,
      count,
    });
  }
  return locations;
}

function useMapRegionData() {
  const [data, setData] = useState<MapRegionData | null>(null);
  useEffect(() => {
    let live = true;
    void loadMapRegionData().then((loaded) => {
      if (live) setData(loaded);
    });
    return () => {
      live = false;
    };
  }, []);
  return data;
}

export function TicketMapPage() {
  const { hasPermission } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [range, setRange] = useState<CreatedRangeQuery>(() => defaultRange());
  const [userFeedbackChannelId, setUserFeedbackChannelId] = useState<string[]>([]);
  const [resetToken, setResetToken] = useState(0);
  const [focusProvinceCode, setFocusProvinceCode] = useState<string | null>(null);
  const [showLabels, setShowLabels] = useState(false);
  const regionData = useMapRegionData();

  const filters = useMemo(
    () => ({
      ...range,
      ...(userFeedbackChannelId.length > 0 && { userFeedbackChannelId }),
    }),
    [range, userFeedbackChannelId],
  );
  const pointsQuery = trpc.ticketMap.points.useQuery(filters, {
    staleTime: 0,
    refetchOnMount: "always",
  });
  const channelOptions = trpc.userFeedbackChannel.filterOptions.useQuery().data ?? [];
  const channels = useMemo(
    () =>
      channelOptions.map((channel) => ({
        value: channel.id,
        label: channel.active ? channel.name : `${channel.name}（已停用）`,
      })),
    [channelOptions],
  );

  const mockTotal = import.meta.env.DEV ? Number(searchParams.get("mock")) || 0 : 0;
  const locations = useMemo(() => {
    if (mockTotal > 0 && regionData) return mockLocations(mockTotal, regionData);
    return pointsQuery.data ?? [];
  }, [mockTotal, regionData, pointsQuery.data]);

  const layout = useMemo(
    () => (regionData ? layoutMapPoints(locations, regionData.centers, regionData.shapes) : null),
    [locations, regionData],
  );

  const focusProvinceName = focusProvinceCode
    ? (regionData?.provinces.features.find(
        (feature) => String(feature.properties.adcode) === focusProvinceCode,
      )?.properties.name ?? null)
    : null;
  const visiblePoints = useMemo(
    () =>
      layout && focusProvinceCode
        ? layout.points.filter((point) => point.provinceCode === focusProvinceCode)
        : (layout?.points ?? []),
    [layout, focusProvinceCode],
  );
  const visibleTotal = focusProvinceCode
    ? (layout?.provinceCounts.get(focusProvinceCode) ?? 0)
    : (layout?.locatedTotal ?? 0);

  const [cityMap, setCityMap] = useState<{
    provinceCode: string;
    geoJson: ChinaProvincesGeoJson | null;
  } | null>(null);
  useEffect(() => {
    if (!focusProvinceCode) return;
    let live = true;
    void loadProvinceCityMap(focusProvinceCode).then((geoJson) => {
      if (live) setCityMap({ provinceCode: focusProvinceCode, geoJson });
    });
    return () => {
      live = false;
    };
  }, [focusProvinceCode]);

  const area = useMemo((): MapArea | null => {
    if (!regionData || !layout) return null;
    if (!focusProvinceCode) {
      return { provinceCode: null, geoJson: regionData.provinces, counts: layout.provinceCounts };
    }
    if (cityMap?.provinceCode !== focusProvinceCode) return null;
    const geoJson = cityMap.geoJson ?? {
      ...regionData.provinces,
      features: regionData.provinces.features.filter(
        (feature) => String(feature.properties.adcode) === focusProvinceCode,
      ),
    };
    const areaCodes = new Set(geoJson.features.map((feature) => String(feature.properties.adcode)));
    const counts = new Map<string, number>();
    for (const location of locations) {
      if (location.provinceCode !== focusProvinceCode || !regionData.centers.has(location.code)) {
        continue;
      }
      const key = areaCodes.has(location.code)
        ? location.code
        : areaCodes.has(cityCodeOf(location.code))
          ? cityCodeOf(location.code)
          : focusProvinceCode;
      counts.set(key, (counts.get(key) ?? 0) + location.count);
    }
    return { provinceCode: focusProvinceCode, geoJson, counts };
  }, [regionData, layout, focusProvinceCode, cityMap, locations]);

  const canDrill = hasPermission("ticket.view");
  const onPointClick = useMemo(
    () =>
      canDrill ? (code: string) => navigate(buildLocationTicketListUrl(code, filters)) : undefined,
    [canDrill, navigate, filters],
  );

  const rankingData = useMemo(() => {
    if (!regionData || !layout) return null;

    if (!focusProvinceCode) {
      const provinceNames = new Map<string, string>();
      for (const feature of regionData.provinces.features) {
        provinceNames.set(String(feature.properties.adcode), feature.properties.name);
      }
      return {
        regionNames: provinceNames,
        regionCounts: layout.provinceCounts,
        regionType: "省份",
      };
    }

    if (!area || !cityMap?.geoJson) return null;
    const areaNames = new Map<string, string>();
    for (const feature of cityMap.geoJson.features) {
      areaNames.set(String(feature.properties.adcode), feature.properties.name);
    }
    return {
      regionNames: areaNames,
      regionCounts: area.counts,
      regionType: DISTRICT_CHILD_PROVINCES.has(focusProvinceCode) ? "区县" : "城市",
    };
  }, [regionData, layout, focusProvinceCode, area, cityMap]);

  const onRankingRegionClick = useMemo(() => {
    if (!canDrill) return undefined;
    if (!focusProvinceCode) {
      return (code: string) => setFocusProvinceCode(code);
    }
    return (code: string) => navigate(buildLocationTicketListUrl(code, filters));
  }, [canDrill, focusProvinceCode, navigate, filters]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            工单地图{focusProvinceName && ` · ${focusProvinceName}`}
          </h1>
          <p className="text-sm text-muted-foreground">
            按工单地址展示分布，每个红点为一例工单；双击省份只看该省及其市界。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <CreatedRangeFilter range={range} onChange={setRange} />
          <MultiSelectFilter
            label="用户反馈渠道"
            values={userFeedbackChannelId}
            options={channels}
            onChange={setUserFeedbackChannelId}
          />
          <Badge variant="secondary" className="h-8 tabular-nums">
            已定位 {visibleTotal} 例
          </Badge>
          {focusProvinceCode && (
            <Button variant="outline" size="sm" onClick={() => setFocusProvinceCode(null)}>
              <ArrowLeft data-icon="inline-start" />
              返回全国
            </Button>
          )}
          <Toggle
            variant="outline"
            size="sm"
            pressed={showLabels}
            onPressedChange={setShowLabels}
            className="px-3"
          >
            <Tags />
            {showLabels ? "隐藏" : "显示"}
            {areaLabelNoun(focusProvinceCode)}
          </Toggle>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setResetToken((token) => token + 1)}
            aria-label="复位地图"
          >
            <RotateCcw data-icon="inline-start" />
            复位
          </Button>
        </div>
      </div>

      {pointsQuery.error && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>地图数据加载失败</AlertTitle>
          <AlertDescription>{pointsQuery.error.message}</AlertDescription>
        </Alert>
      )}

      <div className="relative min-h-[560px] flex-1 overflow-hidden rounded-lg border bg-background">
        {area ? (
          <Suspense fallback={<Skeleton className="h-full w-full" />}>
            <TicketMapChart
              points={visiblePoints}
              area={area}
              onPointClick={onPointClick}
              onAreaDoubleClick={focusProvinceCode ? undefined : setFocusProvinceCode}
              showLabels={showLabels}
              resetToken={resetToken}
            />
          </Suspense>
        ) : (
          <Skeleton className="h-full w-full" />
        )}
        {rankingData && (
          <RegionRanking
            regionNames={rankingData.regionNames}
            regionCounts={rankingData.regionCounts}
            regionType={rankingData.regionType}
            onRegionClick={onRankingRegionClick}
          />
        )}
      </div>
    </div>
  );
}
