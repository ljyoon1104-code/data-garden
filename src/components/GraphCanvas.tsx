import { useEffect, useRef } from "react";
import { ChartDownload } from './ChartDownload';
import type {
  ClusteringResult,
  ClusterDetail,
} from "../domain/clustering-types";
import type { EvaluationRow } from "../domain/regression-types";
import { init, use } from "echarts/core";
import {
  BarChart,
  LineChart,
  ScatterChart,
  PieChart,
  BoxplotChart,
  HeatmapChart,
} from "echarts/charts";
import {
  GridComponent,
  LegendComponent,
  TooltipComponent,
  AriaComponent,
  VisualMapComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { EChartsOption } from "echarts";
import type { DeepReadonly, GraphConfig, TableData } from "../domain/types";
import type { GraphMark, GraphResult } from "../domain/graph-types";
import { aggregateLabels, categoryLabel, graphLabels } from "../domain/graphs";
use([
  BarChart,
  LineChart,
  ScatterChart,
  PieChart,
  BoxplotChart,
  HeatmapChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  AriaComponent,
  VisualMapComponent,
  CanvasRenderer,
]);

const colors = [
  "#207b6c",
  "#bd7632",
  "#636daf",
  "#a85980",
  "#487fa6",
  "#74833b",
  "#8a5f45",
  "#42767e",
];
export function graphOption(
  g: GraphConfig,
  r: GraphResult,
  table: DeepReadonly<TableData>,
  group?: string,
): EChartsOption {
  const s = g.visual!,
    marks = r.marks.filter((m) => !group || m.group === group),
    groups = group ? [group] : r.groups;
  const name = (id: string) =>
    table.columns.find((c) => c.id === id)?.name || "";
  const cats = [
    ...new Set(
      marks
        .filter((m) => !m.outlier)
        .map((m) =>
          g.kind === "histogram" ? String(m.x) : categoryLabel(m.x),
        ),
    ),
  ];
  const base: EChartsOption = {
    animation: false,
    color: colors,
    useUTC: true,
    aria: {
      enabled: true,
      decal: { show: true },
      description: `${s.name}, ${graphLabels[g.kind]}. 전체 ${r.total}행 중 ${r.used}행 사용. 정확한 값과 선택 기능은 아래 집계표에서 확인하세요.`,
    },
    tooltip: { show: false },
    textStyle: { fontFamily: "system-ui, sans-serif" },
    legend: { type: "scroll", top: 0, left: 0, right: 0 },
    grid: { left: 65, right: 30, top: 55, bottom: 85, containLabel: false },
    xAxis: {
      type: "category",
      data: cats,
      name: s.xTitle || name(s.x),
      nameLocation: "middle",
      nameGap: 55,
      axisLabel: {
        width: 75,
        overflow: "truncate",
        rotate: cats.length > 7 ? 30 : 0,
      },
    },
    yAxis: {
      type: "value",
      name:
        s.yTitle ||
        (g.kind === "histogram"
          ? s.ratio
            ? "비율 (0~1)"
            : "빈도"
          : g.kind === "box"
            ? name(s.x)
            : aggregateLabels[s.aggregate]) + (s.unit ? " · " + s.unit : ""),
      min: r.yRange[0],
      max: r.yRange[1],
      axisLabel: {
        formatter: (v: number) => Number(v.toPrecision(6)).toString(),
      },
    },
    series: [],
  };
  const datum = <T,>(m: GraphMark, value: T) => ({
    value,
    markId: m.id,
    name: m.label,
  });
  if (g.kind === "scatter") {
    base.xAxis = {
      type: "value",
      name: s.xTitle || name(s.x),
      nameLocation: "middle",
      nameGap: 40,
      min: r.xRange[0],
      max: r.xRange[1],
    };
    base.yAxis = {
      type: "value",
      name: s.yTitle || name(s.y),
      min: r.yRange[0],
      max: r.yRange[1],
      axisLabel: {
        formatter: (v: number) => Number(v.toPrecision(6)).toString(),
      },
    };
    base.series = groups.map((gr, i) => ({
      type: "scatter",
      name: gr,
      symbol: ["circle", "rect", "triangle", "diamond"][i % 4],
      symbolSize: 10,
      itemStyle: { color: colors[r.groups.indexOf(gr) % colors.length] },
      data: marks
        .filter((m) => m.group === gr)
        .map((m) => datum(m, [Number(m.x), m.y!])),
    }));
  } else if (g.kind === "pie") {
    delete base.xAxis;
    delete base.yAxis;
    delete base.grid;
    base.series = [
      {
        type: "pie",
        radius: ["25%", "62%"],
        center: ["50%", "58%"],
        label: {
          show: true,
          overflow: "truncate",
          width: 80,
          formatter: "{b}",
        },
        data: marks
          .filter((m) => m.y !== null)
          .map((m) => ({ value: m.y!, name: m.label, markId: m.id })),
      },
    ];
  } else if (g.kind === "heatmap") {
    const xs = [...new Set(marks.map((m) => categoryLabel(m.x)))],
      ys = [...new Set(marks.map((m) => m.group))];
    const vals = marks.map((m) => m.y).filter((v): v is number => v !== null),
      max = Math.max(1, ...vals),
      min = Math.min(0, ...vals);
    base.grid = { left: 95, right: 25, top: 30, bottom: 110 };
    base.xAxis = {
      type: "category",
      data: xs,
      axisLabel: { width: 70, overflow: "truncate", rotate: 30 },
    };
    base.yAxis = {
      type: "category",
      data: ys,
      axisLabel: { width: 80, overflow: "truncate" },
    };
    base.visualMap = {
      min: s.heatmap === "correlation" ? -1 : min,
      max: s.heatmap === "correlation" ? 1 : max,
      calculable: false,
      text: [
        String(s.heatmap === "correlation" ? 1 : Number(max.toPrecision(5))),
        String(s.heatmap === "correlation" ? -1 : Number(min.toPrecision(5))),
      ],
      orient: "horizontal",
      left: "center",
      bottom: 0,
      inRange: {
        color:
          s.heatmap === "correlation"
            ? ["#325eae", "#f4f1e8", "#b64743"]
            : ["#eef4df", "#18796b"],
      },
    };
    base.series = [
      {
        type: "heatmap",
        data: marks
          .filter((m) => m.y !== null)
          .map((m) =>
            datum(m, [
              xs.indexOf(categoryLabel(m.x)),
              ys.indexOf(m.group),
              m.y!,
            ]),
          ),
        label: {
          show: xs.length <= 6 && ys.length <= 10,
          formatter: (p) => String((p.value as number[])[2].toFixed(2)),
        },
      },
    ];
  } else if (g.kind === "box") {
    const boxes = marks.filter((m) => m.box);
    base.xAxis = {
      type: "category",
      data: boxes.map((m) => m.group),
      axisLabel: { width: 80, overflow: "truncate" },
    };
    base.series = [
      {
        type: "boxplot",
        name: "분포",
        data: boxes.map((m) => ({
          ...datum(m, m.box!),
          itemStyle: {
            color: colors[r.groups.indexOf(m.group) % colors.length],
          },
        })),
      },
      {
        type: "scatter",
        name: "이상값 (보존)",
        symbol: "diamond",
        data: marks
          .filter((m) => m.outlier)
          .map((m) =>
            datum(m, [boxes.findIndex((b) => b.group === m.group), m.y]),
          ),
      },
    ];
  } else {
    const xcol = table.columns.find((c) => c.id === s.x),
      continuous =
        ["line", "area"].includes(g.kind) &&
        (xcol?.semanticType === "date" || xcol?.semanticType === "numeric");
    if (continuous)
      base.xAxis = {
        type: xcol?.semanticType === "date" ? "time" : "value",
        name: s.xTitle || name(s.x),
        nameLocation: "middle",
        nameGap: 50,
        axisLabel: {
          hideOverlap: true,
          formatter:
            xcol?.semanticType === "date" &&
            marks.every((m) => String(m.x).length === 10)
              ? "{yyyy}-{MM}-{dd}"
              : undefined,
        },
        minInterval:
          xcol?.semanticType === "date" &&
          marks.every((m) => String(m.x).length === 10)
            ? 86400000
            : undefined,
        ...(s.xRange ? { min: s.xRange[0], max: s.xRange[1] } : {}),
      };
    base.series = groups.map((gr, i) => ({
      type: ["line", "area"].includes(g.kind) ? "line" : "bar",
      name: gr,
      stack: g.kind === "area" || s.stacked ? "total" : undefined,
      areaStyle: g.kind === "area" ? {} : undefined,
      connectNulls: false,
      itemStyle: { color: colors[r.groups.indexOf(gr) % colors.length] },
      lineStyle: {
        color: colors[r.groups.indexOf(gr) % colors.length],
        type: (["solid", "dashed", "dotted"] as const)[i % 3],
      },
      symbol: ["circle", "rect", "triangle", "diamond"][i % 4],
      data: marks
        .filter((m) => m.group === gr)
        .map((m) =>
          datum(
            m,
            continuous
              ? [
                  xcol?.semanticType === "date"
                    ? String(m.x).includes("T")
                      ? String(m.x) + "Z"
                      : String(m.x) + "T00:00:00Z"
                    : Number(m.x),
                  m.y,
                ]
              : m.y,
          ),
        ),
    })) as EChartsOption["series"];
  }
  // ECharts' broad option union does not describe custom markId metadata.
  return base;
}
export function GraphCanvas({
  graph,
  result,
  table,
  select,
  group,
}: {
  graph: GraphConfig;
  result: GraphResult;
  table: DeepReadonly<TableData>;
  select: (mark: GraphMark) => void;
  group?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current!;
    const chart = init(node, undefined, { renderer: "canvas" });
    chart.setOption(graphOption(graph, result, table, group));
    chart.on("click", (params) => {
      const data = params.data as { markId?: string } | undefined;
      const mark = result.marks.find((m) => m.id === data?.markId);
      if (mark) select(mark);
    });
    const resize = new ResizeObserver(() => chart.resize());
    resize.observe(node);
    return () => {
      resize.disconnect();
      chart.dispose();
    };
  }, [graph, result, table, group, select]);
  return (
    <><div
      ref={ref}
      className="graph-canvas"
      role="img"
      aria-label={`${graph.visual?.name} ${group || ""} · ${graphLabels[graph.kind]} · 아래 집계표로 모든 표시값과 원자료에 접근할 수 있습니다.`}
    /><ChartDownload node={ref} title={graph.visual?.name??'그래프'} context={[`자료 ${graph.source.datasetId} · 버전 ${graph.source.versionId}`,`범위 ${graph.visual?.scope.kind} · 전체 ${result.total}행 중 ${result.used}행 사용 · 집계 ${graph.visual?.aggregate}`,`표시 ${result.displayed} · 표본 ${result.sampled?'사용':'아님'} · 단위 ${graph.visual?.unit||'별도 지정 없음'}`,group?`현재 집단 패널: ${group} (전체 집단 아님)`:`현재 그림 · ${result.groups.length}개 집단`,...result.warnings]}/></>
  );
}

/** Regression uses the existing chart registry; no synthetic dataset/version is persisted. */
export function RegressionCanvas({
  rows,
  seed,
  select,
  context=[],
}: {
  rows: EvaluationRow[];
  seed: number;
  context?: string[];
  select: (id: string) => void;
}) {
  const actual = useRef<HTMLDivElement>(null),
    residual = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const sample: EvaluationRow[] = [];
    let random = seed >>> 0;
    rows.forEach((r, i) => {
      if (i < 1000) sample.push(r);
      else {
        random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
        const j = Math.floor((random / 4294967296) * (i + 1));
        if (j < 1000) sample[j] = r;
      }
    });
    const charts = [actual.current!, residual.current!].map((node, index) => {
      const chart = init(node, undefined, { renderer: "canvas" });
      const lo = Math.min(
          ...sample.map((r) => Math.min(r.actual, r.predicted)),
        ),
        hi = Math.max(...sample.map((r) => Math.max(r.actual, r.predicted)));
      chart.setOption({
        animation: false,
        color: colors,
        aria: {
          enabled: true,
          description: `${index ? "예측값과 잔차" : "실제값과 예측값"}. ${rows.length}개 평가 행 중 ${sample.length}개 점. 아래 표에서 모든 행과 정확한 값을 확인할 수 있습니다.`,
        },
        tooltip: { show: false },
        grid: { left: 70, right: 25, top: 45, bottom: 60 },
        textStyle: { fontFamily: "system-ui,sans-serif" },
        xAxis: {
          type: "value",
          name: index ? "예측값" : "실제값",
          nameLocation: "middle",
          nameGap: 35,
          scale: true,
        },
        yAxis: {
          type: "value",
          name: index ? "잔차 (실제 − 예측)" : "예측값",
          scale: true,
        },
        series: [
          {
            type: "scatter",
            symbolSize: 9,
            data: sample.map((r) => ({
              value: index
                ? [r.predicted, r.residual]
                : [r.actual, r.predicted],
              rowId: r.rowId,
            })),
          },
          {
            type: "line",
            symbol: "none",
            silent: true,
            lineStyle: { type: "dashed", color: "#a66d31" },
            data: index
              ? [
                  [lo, 0],
                  [hi, 0],
                ]
              : [
                  [lo, lo],
                  [hi, hi],
                ],
          },
        ],
      } satisfies EChartsOption);
      chart.on("click", (p) => {
        const id = (p.data as { rowId?: string })?.rowId;
        if (id) select(id);
      });
      return chart;
    });
    const observer = new ResizeObserver(() =>
      charts.forEach((c) => c.resize()),
    );
    observer.observe(actual.current!);
    observer.observe(residual.current!);
    return () => {
      observer.disconnect();
      charts.forEach((c) => c.dispose());
    };
  }, [rows, seed, select]);
  return (
    <div className="regression-plots">
      <figure>
        <figcaption>실제값과 예측값 · 점선은 실제값 = 예측값</figcaption>
        <div
          className="graph-canvas"
          role="img"
          aria-label="실제값과 예측값 산점도. 아래 평가 표에서 행 선택 가능"
          ref={actual}
        />
        <ChartDownload node={actual} title="회귀 실제값과 예측값" context={[...context,`전체 평가 ${rows.length}행 · 표시 ${Math.min(1000,rows.length)}점 · ${rows.length>1000?'표시 표본':'전체 평가점'}`,`고정 표시 seed ${seed} · 현재 선택 모델의 저장된 평가 결과`]}/>
      </figure>
      <figure>
        <figcaption>예측값과 잔차 · 점선은 잔차 0</figcaption>
        <div
          className="graph-canvas"
          role="img"
          aria-label="예측값과 잔차 그래프. 아래 평가 표에서 행 선택 가능"
          ref={residual}
        />
        <ChartDownload node={residual} title="회귀 예측값과 잔차" context={[`전체 평가 ${rows.length}행 · 표시 ${Math.min(1000,rows.length)}점 · ${rows.length>1000?'표시 표본':'전체 평가점'}`,`고정 표시 seed ${seed} · 잔차=실제−예측`]}/>
      </figure>
    </div>
  );
}

export function ClusteringCanvas(
  props:
    | { mode: "metrics"; result: ClusteringResult }
    | { mode: "scatter"; detail: ClusterDetail; select: (id: string) => void; context?:string[] }
    | {
        mode: "experiment";
        points: { id: string; x: number; y: number }[];
        select: (id: string) => void;
      },
) {
  const node = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const chart = init(node.current!, undefined, { renderer: "canvas" });
    const symbols = [
      "circle",
      "rect",
      "triangle",
      "diamond",
      "pin",
      "roundRect",
    ];
    let option: EChartsOption;
    const base: EChartsOption = {
      animation: false,
      color: colors,
      tooltip: { show: false },
      textStyle: { fontFamily: "system-ui,sans-serif" },
      aria: {
        enabled: true,
        decal: { show: true },
        description:
          "군집 탐구 그래프. 아래 표에서 모든 값과 행을 키보드로 선택할 수 있습니다.",
      },
      legend: { type: "scroll", top: 0 },
      grid: { left: 65, right: 65, top: 55, bottom: 65, containLabel: true },
    };
    if (props.mode === "metrics") {
      option = {
        ...base,
        xAxis: {
          type: "category",
          name: "군집 수 k",
          data: props.result.candidates.map((a) => a.k),
          nameLocation: "middle",
          nameGap: 30,
        },
        yAxis: [
          { type: "value", name: "SSE" },
          { type: "value", name: "실루엣", min: -1, max: 1 },
        ],
        series: [
          {
            type: "line",
            name: "SSE",
            symbol: "circle",
            connectNulls: false,
            data: props.result.candidates.map((a) => a.sse),
          },
          {
            type: "line",
            name: "실루엣",
            symbol: "triangle",
            yAxisIndex: 1,
            connectNulls: false,
            data: props.result.candidates.map(
              (a) => a.silhouette?.mean ?? null,
            ),
          },
        ],
      };
    } else {
      const points =
        props.mode === "experiment"
          ? props.points.map((p) => ({
              rowId: p.id,
              x: p.x,
              y: p.y,
              cluster: 0,
            }))
          : props.detail.marks;
      const groups = [...new Set(points.map((p) => p.cluster))].sort(
        (a, b) => a - b,
      );
      option = {
        ...base,
        xAxis: {
          type: "value",
          scale: true,
          name: "X 표시 축",
          nameLocation: "middle",
          nameGap: 32,
        },
        yAxis: { type: "value", scale: true, name: "Y 표시 축" },
        series: [
          ...groups.map((c) => ({
            type: "scatter" as const,
            name: props.mode === "experiment" ? "실험 점" : `군집 ${c + 1}`,
            symbol: symbols[c % symbols.length],
            symbolSize: 10,
            data: points
              .filter((p) => p.cluster === c)
              .map((p) => ({ value: [p.x, p.y], rowId: p.rowId })),
            itemStyle: { opacity: 0.7 },
          })),
          ...(props.mode === "scatter"
            ? [
                {
                  type: "scatter" as const,
                  name: "중심 / 평균",
                  symbol: "path://M-6,-4L-4,-6L0,-2L4,-6L6,-4L2,0L6,4L4,6L0,2L-4,6L-6,4L-2,0Z",
                  symbolSize: 22,
                  itemStyle: { color: "#172c29" },
                  data: props.detail.centers.map((p) => [p.x, p.y]),
                },
              ]
            : []),
        ],
      };
    }
    chart.setOption(option);
    chart.on("click", (p) => {
      const id = (p.data as { rowId?: string })?.rowId;
      if (id && props.mode !== "metrics") props.select(id);
    });
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(node.current!);
    return () => {
      observer.disconnect();
      chart.dispose();
    };
  }, [props]);
  return (
    <figure className="cluster-plot">
      <figcaption>
        {props.mode === "metrics"
          ? "군집 수별 SSE와 실루엣 · 축의 단위가 다릅니다"
          : props.mode === "experiment"
            ? "직접 입력한 2차원 좌표"
            : "군집 분포 · 색과 기호로 구분, ×는 중심 또는 평균"}
      </figcaption>
      <div
        ref={node}
        className="graph-canvas"
        role="img"
        aria-label="군집 그래프. 아래 표에서 정확한 값 확인 및 점 선택 가능"
      />
      <ChartDownload node={node} title={props.mode==='metrics'?'군집 수 비교':props.mode==='scatter'?'군집 분포':'직접 점 실험'} context={props.mode==='metrics'?[`자료 ${props.result.source.datasetId} · 버전 ${props.result.source.versionId}`,`전체 분석 ${props.result.rowIds.length}행`,...props.result.candidates.map(c=>`k=${c.k} 실루엣 ${c.silhouette?.mode??'계산 불가'}`)]:props.mode==='scatter'?[...(props.context??[]),`전체 ${props.detail.total}행 · 표시 ${props.detail.displayed}점 · ${props.detail.displayed<props.detail.total?'표시 표본':'전체 표시'}`,'현재 표시 축·선택한 계산 단계의 고정 결과']:['직접 입력한 임시 실험 점']}/>
    </figure>
  );
}
