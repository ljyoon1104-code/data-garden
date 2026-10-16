import { describe, it, expect } from "vitest";
import {
  calculateGraph,
  graphRows,
  graphScope,
  newGraph,
  normalizedGraph,
  validateGraph,
  categoryLabel,
} from "./graphs";
import type { Attribute, Cell, GraphConfig, TableData } from "./types";
import type { GraphKind } from "./graph-types";
import { defaultTableView, editVersion } from "./table";
import {
  createWorkspace,
  workspaceReducer,
  getSelection,
} from "../state/workspace";
import {
  makeBackup,
  readBackup,
  validateWorkspace,
} from "../persistence/format";
import { JobGate } from "../workers/protocol";
import { graphOption } from "../components/GraphCanvas";

describe("추가 경계와 재현 검증", () => {
  it("쌍별 n=1·상수는 null, 음의 완전 상관은 -1", () => {
    const t = table([
        [1, 6],
        [2, 4],
        [3, 2],
        [null, 10],
      ]),
      g = graph(t, "heatmap");
    Object.assign(g.visual!, {
      heatmap: "correlation",
      correlationIds: ["x", "y"],
    });
    expect(
      calculateGraph(t, g).marks.find((m) => m.x === "x" && m.group === "y")!.y,
    ).toBeCloseTo(-1, 12);
    expect(
      calculateGraph(
        table([
          [1, 2],
          [null, 3],
        ]),
        g,
      ).marks.find((m) => m.x === "x" && m.group === "y")!.y,
    ).toBeNull();
  });
  it("중복 필터 전체 범위와 선택ID 독립", () => {
    const t = table([
        [1, 2, "A"],
        [1, 2, "A"],
        [3, 4, "B"],
      ]),
      g = graph(t),
      view = defaultTableView();
    view.duplicatesOnly = true;
    g.visual!.scope = graphScope(view, "filtered");
    expect(calculateGraph(t, g).scoped).toBe(2);
    expect(graphRows(t, g, {}, 0).rows.map((r) => r.id)).toEqual(["r0", "r1"]);
  });
  it("전부 결측의 합계는 null, 유효 수는 0", () => {
    const t = table([
        [1, null, "A"],
        [2, null, "A"],
      ]),
      g = graph(t, "bar");
    Object.assign(g.visual!, { x: "g", value: "y", aggregate: "sum" });
    expect(calculateGraph(t, g).marks[0].y).toBeNull();
    g.visual!.aggregate = "valid";
    expect(calculateGraph(t, g).marks[0].y).toBe(0);
  });
  it("누적 영역 합계는 Worker 결과에 포함하고 공백을 0으로 취급하지 않음", () => {
    const t = table([
        [1, 2, "A"],
        [1, 4, "B"],
        [2, 6, "A"],
      ]),
      g = graph(t, "area");
    Object.assign(g.visual!, { group: "g", value: "y", aggregate: "sum" });
    expect(calculateGraph(t, g).totals).toEqual([
      { x: 1, value: 6 },
      { x: 2, value: null },
    ]);
  });
  it("정밀도 중복 경계 통합과 임의 경계 복원 거부", () => {
    const t = table([[1e16], [1e16 + 2]]),
      g = graph(t, "histogram");
    g.visual!.binCount = 10;
    expect(calculateGraph(t, g).boundaries).toEqual([1e16, 1e16 + 2]);
    g.visual!.boundaries = [1e16, 1e16 + 10];
    expect(() => calculateGraph(t, g)).toThrow("경계");
  });
  it("극단값 합계 overflow는 0으로 저장하지 않고 오류", () => {
    const t = table([
        [1, 1e308, "A"],
        [2, 1e308, "A"],
      ]),
      g = graph(t, "bar");
    Object.assign(g.visual!, { x: "g", value: "y", aggregate: "sum" });
    expect(() => calculateGraph(t, g)).toThrow("유한한");
  });
});

const column = (
  id: string,
  type: Attribute["semanticType"] = "numeric",
  storage: Attribute["storageType"] = type === "numeric" ? "number" : "string",
): Attribute => ({
  id,
  name: id,
  storageType: storage,
  semanticType: type,
  description: "",
  useInAnalysis: true,
});
const table = (
  values: Cell[][],
  columns = [
    column("x"),
    column("y"),
    column("g", "categorical"),
    column("date", "date"),
  ],
): TableData => ({
  columns,
  rows: values.map((a, i) => ({
    id: "r" + i,
    values: Object.fromEntries(columns.map((c, j) => [c.id, a[j] ?? null])),
  })),
});
const basic = () =>
  table([
    [0, 2, "A", "2024-03-01"],
    [2, 4, "A", "2024-02-29"],
    [4, null, "B", "2024-03-01"],
    [6, 8, "B", "2024-03-02"],
    [8, 10, "B", "2024-03-03"],
    [10, 12, "A", "2024-03-03"],
  ]);
function graph(t: TableData, kind: GraphKind = "scatter") {
  const g = newGraph(t, { datasetId: "d", versionId: "v" });
  g.kind = kind;
  return g;
}
describe("정확한 그래프 계산과 표시 연결", () => {
  it("산점도 겹침·영역의 모든 행, 표본 여부와 관계없이 정확 조회", () => {
    const t = table([
        [1, 2, "A"],
        [1, 2, "A"],
        [2, 4, "B"],
        [null, 2, "A"],
      ]),
      g = graph(t);
    g.visual!.group = "g";
    const r = calculateGraph(t, g);
    expect(r.used).toBe(3);
    expect(r.excluded).toBe(1);
    expect(r.marks[0].count).toBe(2);
    expect(graphRows(t, g, r.marks[0].query, 0).rows.map((r) => r.id)).toEqual([
      "r0",
      "r1",
    ]);
    expect(
      graphRows(
        t,
        g,
        { region: { x: "x", y: "y", xMin: 1, xMax: 2, yMin: 2, yMax: 4 } },
        0,
      ).total,
    ).toBe(3);
    expect(t.rows.length).toBe(4);
  });
  it("필터는 모든 페이지, 선택 0행은 0행, 범위 독립 사본", () => {
    const t = basic(),
      g = graph(t),
      view = defaultTableView();
    view.page = 3;
    view.filter = { attributeId: "x", operator: "gt", value: "2" };
    g.visual!.scope = graphScope(view, "filtered");
    view.filter.value = "100";
    expect(calculateGraph(t, g).scoped).toBe(4);
    g.visual!.scope = graphScope(view, "selected");
    expect(calculateGraph(t, g).scoped).toBe(0);
    view.selectedRowIds = ["r0", "r2"];
    g.visual!.scope = graphScope(view, "selected");
    expect(calculateGraph(t, g).scoped).toBe(2);
  });
  it("공통 히스토그램 경계 [0,5),[5,10], 최대 포함, 집단별 비율", () => {
    const t = basic(),
      g = graph(t, "histogram");
    Object.assign(g.visual!, { binCount: 2, group: "g" });
    let r = calculateGraph(t, g);
    expect(r.boundaries).toEqual([0, 5, 10]);
    expect(r.marks.map((m) => m.count)).toEqual([2, 1, 1, 2]);
    expect(
      graphRows(t, g, r.marks[1].query, 0).rows.map((r) => r.values.x),
    ).toEqual([10]);
    g.visual!.ratio = true;
    r = calculateGraph(t, g);
    expect(r.marks[0].y).toBeCloseTo(2 / 3, 12);
    expect(r.marks[0].denominator).toBe(3);
    g.visual!.binMode = "width";
    g.visual!.binWidth = 4;
    expect(calculateGraph(t, g).boundaries).toEqual([0, 4, 8, 10]);
  });
  it("상수 히스토그램 한 구간, 전부 결측은 표시 없음", () => {
    const t = table([[7], [7], [null]]),
      g = graph(t, "histogram");
    const r = calculateGraph(t, g);
    expect(r.boundaries).toEqual([7, 7]);
    expect(r.marks[0].count).toBe(2);
    expect(r.warnings.join()).toContain("상수");
    expect(calculateGraph(table([[null]]), g).marks).toEqual([]);
  });
  it("상자그림 독립 정답 Q1=2 Q3=4, 수염1~4, 이상값100 보존", () => {
    const t = table([[1], [2], [3], [4], [100], [null]]),
      g = graph(t, "box"),
      r = calculateGraph(t, g);
    expect(r.marks[0].box).toEqual([1, 2, 3, 4, 4]);
    expect(r.marks[1].y).toBe(100);
    expect(r.marks[1].outlier).toBe(true);
    expect(graphRows(t, g, r.marks[1].query, 0).rows[0].values.x).toBe(100);
    expect(t.rows.length).toBe(6);
  });
  it.each(["rows", "valid", "sum", "mean", "median"] as const)(
    "막대 집계 %s 독립 정답과 실제 렌더링 데이터 일치",
    (method) => {
      const t = table([
          [1, 2, "A"],
          [2, 4, "A"],
          [3, null, "A"],
        ]),
        g = graph(t, "bar");
      Object.assign(g.visual!, { x: "g", value: "y", aggregate: method });
      const r = calculateGraph(t, g),
        answer = { rows: 3, valid: 2, sum: 6, mean: 3, median: 3 }[method];
      expect(r.marks[0].y).toBe(answer);
      const opt = graphOption(g, r, t);
      expect(JSON.stringify(opt.series)).toContain(`"value":${answer}`);
      expect(graphRows(t, g, r.marks[0].query, 0).total).toBe(3);
    },
  );
  it("선 날짜 정렬·중복 X 평균·실제 결측과 없는 조합은 공백", () => {
    const t = table([
        [1, 2, "A", "2024-03-02"],
        [2, 4, "A", "2024-03-01"],
        [3, 8, "A", "2024-03-01"],
        [4, null, "A", "2024-03-03"],
        [5, 10, "B", "2024-03-01"],
      ]),
      g = graph(t, "line");
    Object.assign(g.visual!, {
      x: "date",
      value: "y",
      group: "g",
      aggregate: "mean",
    });
    const r = calculateGraph(t, g);
    expect(
      r.marks.filter((m) => m.group === categoryLabel("A")).map((m) => m.y),
    ).toEqual([6, 2, null]);
    expect(
      r.marks.filter((m) => m.group === categoryLabel("B")).map((m) => m.y),
    ).toEqual([10, null, null]);
    expect(JSON.stringify(graphOption(g, r, t).series)).toContain(
      '"connectNulls":false',
    );
    g.visual!.fillAbsent = true;
    const filled = calculateGraph(t, g);
    expect(
      filled.marks.find(
        (m) => m.x === "2024-03-03" && m.group === categoryLabel("A"),
      )!.y,
    ).toBeNull();
    expect(
      filled.marks.find(
        (m) => m.x === "2024-03-03" && m.group === categoryLabel("B"),
      )!.y,
    ).toBe(0);
  });
  it("파이 분모·비율, 음수와 합계0 차단", () => {
    const t = table([
        [1, 2, "A"],
        [2, 4, "A"],
        [3, 6, "B"],
      ]),
      g = graph(t, "pie");
    Object.assign(g.visual!, { x: "g", value: "y", aggregate: "sum" });
    const r = calculateGraph(t, g);
    expect(r.marks.map((m) => m.ratio)).toEqual([0.5, 0.5]);
    expect(r.marks[0].denominator).toBe(12);
    expect(() => calculateGraph(table([[1, -2, "A"]]), g)).toThrow("음수");
    expect(() => calculateGraph(table([[1, 0, "A"]]), g)).toThrow("0");
  });
  it("누적 영역 결측·없는 조합 구분 및 음수 차단", () => {
    const t = basic(),
      g = graph(t, "area");
    Object.assign(g.visual!, {
      x: "date",
      group: "g",
      value: "y",
      aggregate: "mean",
    });
    const r = calculateGraph(t, g);
    expect(
      r.marks.find(
        (m) => m.x === "2024-03-01" && m.group === categoryLabel("B"),
      )!.absent,
    ).toBe(false);
    expect(
      r.marks.find(
        (m) => m.x === "2024-03-02" && m.group === categoryLabel("A"),
      )!.absent,
    ).toBe(true);
    t.rows[0].values.y = -10;
    expect(() => calculateGraph(t, g)).toThrow("음수");
  });
  it("숫자 1과 문자 1, NA와 0, 교차 빈도0과 집계불가 구분", () => {
    const t = table(
      [
        [1, 2, "A"],
        ["1", 4, "B"],
        ["NA", null, "A"],
        [0, null, "B"],
      ],
      [
        column("x", "categorical", "mixed"),
        column("y"),
        column("g", "categorical"),
      ],
    );
    const g = graph(t, "heatmap");
    Object.assign(g.visual!, { x: "x", y: "g" });
    let r = calculateGraph(t, g);
    expect(r.marks.length).toBe(8);
    expect(r.used).toBe(4);
    expect(categoryLabel(1)).not.toBe(categoryLabel("1"));
    const zero = r.marks.find(
      (m) => m.x === 1 && m.group === categoryLabel("B"),
    )!;
    expect(zero.y).toBe(0);
    expect(graphRows(t, g, zero.query, 0).total).toBe(0);
    Object.assign(g.visual!, { aggregate: "mean", value: "y" });
    r = calculateGraph(t, g);
    expect(
      r.marks.find((m) => m.x === 1 && m.group === categoryLabel("B"))!.y,
    ).toBeNull();
  });
  it("Pearson 쌍별 n·결측, 상수·n<2는 null, 색 기준 고정", () => {
    const t = table(
        [
          [1, 2, 7],
          [2, 4, 7],
          [3, null, 7],
          [4, 8, null],
        ],
        [column("x"), column("y"), column("z")],
      ),
      g = graph(t, "heatmap");
    Object.assign(g.visual!, {
      heatmap: "correlation",
      correlationIds: ["x", "y", "z"],
    });
    const r = calculateGraph(t, g),
      xy = r.marks.find((m) => m.x === "x" && m.group === "y")!;
    expect(xy.y).toBeCloseTo(1, 12);
    expect(xy.count).toBe(3);
    expect(r.marks.find((m) => m.x === "x" && m.group === "z")!.y).toBeNull();
    expect(graphRows(t, g, xy.query, 0).rows.map((r) => r.id)).toEqual([
      "r0",
      "r1",
      "r3",
    ]);
    expect(graphOption(g, r, t).visualMap).toMatchObject({ min: -1, max: 1 });
  });
  it.each(
    Object.keys({
      scatter: 1,
      histogram: 1,
      box: 1,
      bar: 1,
      line: 1,
      pie: 1,
      area: 1,
      heatmap: 1,
    }) as GraphKind[],
  )("%s 실제 렌더 옵션·유한한 값", (kind) => {
    const t = basic(),
      g = graph(t, kind);
    if (["bar", "pie", "heatmap"].includes(kind)) g.visual!.x = "g";
    if (kind === "heatmap") g.visual!.y = "g";
    if (kind === "area") {
      g.visual!.group = "g";
      g.visual!.aggregate = "mean";
    }
    const r = calculateGraph(t, g);
    expect(graphOption(g, r, t).series).toBeTruthy();
    expect(r.marks.every((m) => m.y === null || Number.isFinite(m.y))).toBe(
      true,
    );
  });
  it("식별자 연속축·범주형 선 미확인·범주 다량 차단", () => {
    const t = table([[1], [2]], [column("x", "identifier", "number")]),
      g = graph(t);
    expect(() => calculateGraph(t, g)).toThrow("수치 의미");
    g.kind = "line";
    expect(() => calculateGraph(t, g)).toThrow("순서");
    g.visual!.categoricalOrderConfirmed = true;
    expect(calculateGraph(t, g).used).toBe(2);
    g.kind = "bar";
    g.visual!.categoryLimit = 1;
    expect(() => calculateGraph(t, g)).toThrow("범주");
    g.visual!.categoryRangeConfirmed = true;
    expect(calculateGraph(t, g).displayed).toBe(1);
  });
  it("50000행 정확 집계와 재현 가능한 점 표본·공통 축", () => {
    const t = table(
        Array.from({ length: 50000 }, (_, i) => [i, i * 2, i % 2 ? "A" : "B"]),
      ),
      g = graph(t);
    g.visual!.group = "g";
    g.visual!.sampling.limit = 100;
    const r = calculateGraph(t, g);
    expect(r.used).toBe(50000);
    expect(r.marks.length).toBe(100);
    expect(r.sampled).toBe(true);
    expect(r.xRange).toEqual([0, 49999]);
    expect(r.marks).toEqual(calculateGraph(t, g).marks);
    expect(
      graphRows(
        t,
        g,
        {
          region: {
            x: "x",
            y: "y",
            xMin: 0,
            xMax: 49999,
            yMin: 0,
            yMax: 99998,
          },
        },
        1,
      ).rows,
    ).toHaveLength(25);
    const a = graphOption(g, r, t, categoryLabel("A")),
      b = graphOption(g, r, t, categoryLabel("B"));
    expect(a.xAxis).toEqual(b.xAxis);
    expect(a.yAxis).toMatchObject({ min: 0, max: 99998 });
    expect(b.yAxis).toMatchObject({ min: 0, max: 99998 });
  });
});
describe("그래프 저장·복원·버전·작업 연결", () => {
  function saved() {
    let w = createWorkspace();
    const { dataset, version } = getSelection(w);
    const g = newGraph(version!, {
      datasetId: dataset!.id,
      versionId: version!.id,
    });
    w = workspaceReducer(w, { type: "graph-save", graph: g });
    return { w, g };
  }
  it("저장·복제·이름 변경·비교선택·삭제는 데이터 이력 독립", () => {
    let { w, g } = saved();
    const history = w.project.history;
    const clone = structuredClone(g);
    clone.id = "clone";
    clone.visual!.name = "비교";
    w = workspaceReducer(w, { type: "graph-save", graph: clone });
    w = workspaceReducer(w, {
      type: "graph-select",
      id: g.id,
      comparison: true,
    });
    expect(w.project.history).toBe(history);
    expect(w.project.graphs.length).toBe(2);
    expect(
      readBackup(JSON.stringify(makeBackup(w))).view.comparisonGraphId,
    ).toBe(g.id);
    w = workspaceReducer(w, { type: "graph-delete", id: g.id });
    expect(w.view.comparisonGraphId).toBeNull();
    expect(w.project.graphs).toHaveLength(1);
    validateWorkspace(w);
  });
  it("편집·undo 후 과거 그래프·원자료 유지, 원본과 버전 불변", () => {
    let { w, g } = saved();
    const { dataset, version } = getSelection(w);
    const before = JSON.stringify(dataset),
      row = version!.rows[0];
    const edited = editVersion(dataset!, version!.id, {
      kind: "cell",
      rowId: row.id,
      attributeId: "sleep",
      value: "99",
      missing: false,
    })!;
    w = workspaceReducer(w, {
      type: "commit-version",
      datasetId: dataset!.id,
      baseVersionId: version!.id,
      version: edited,
    });
    expect(w.project.graphs[0].source.versionId).toBe(version!.id);
    expect(graphRows(version!, g, {}, 0).rows[0].values.sleep).toBe(7.5);
    expect(JSON.stringify(dataset)).toBe(before);
    w = workspaceReducer(w, { type: "undo" });
    expect(w.project.graphs[0].source).toEqual(g.source);
    validateWorkspace(w);
  });
  it.each([1, 2, 3, 4])("스키마 %s 이행, 불완전 과거 그래프 보존", (schema) => {
    const { w, g } = saved(),
      old = JSON.parse(JSON.stringify(w));
    old.project.schemaVersion = schema;
    delete old.project.graphs[0].visual;
    const restored = validateWorkspace(old);
    expect(restored.project.schemaVersion).toBe(6);
    expect(restored.project.graphs[0].visual).toBeUndefined();
    expect(restored.project.graphs[0].id).toBe(g.id);
  });
  it("지원 종류·설정·참조·표본·축·선택 행 손상 거부", () => {
    const { w } = saved();
    for (const mutate of [
      (g: GraphConfig) => {
        g.kind = "unsupported" as GraphKind;
      },
      (g: GraphConfig) => {
        g.visual!.x = "missing";
      },
      (g: GraphConfig) => {
        g.visual!.sampling.seed = -1;
      },
      (g: GraphConfig) => {
        g.visual!.xRange = [5, 1];
      },
      (g: GraphConfig) => {
        g.visual!.binCount = 101;
      },
      (g: GraphConfig) => {
        g.visual!.boundaries = [0, 2, 1];
      },
      (g: GraphConfig) => {
        g.visual!.scope = {
          kind: "selected",
          rowIds: ["missing"],
          filter: null,
          duplicatesOnly: false,
        };
      },
      (g: GraphConfig) => {
        g.visual!.x = "student-id";
      },
    ]) {
      const bad = structuredClone(w);
      mutate(bad.project.graphs[0]);
      expect(() => validateWorkspace(bad)).toThrow();
    }
    const bad = structuredClone(w);
    bad.view.currentGraphId = "missing";
    expect(() => validateWorkspace(bad)).toThrow("참조");
  });
  it("저장 경계 재현·설정 독립 복사본", () => {
    const { w, g } = saved();
    g.kind = "histogram";
    g.visual!.binCount = 2;
    const v = getSelection(w).version!;
    const r = calculateGraph(v, g);
    g.visual!.boundaries = r.boundaries;
    const stored = workspaceReducer(w, {
      type: "graph-save",
      graph: normalizedGraph(g),
    });
    g.visual!.scope.rowIds.push("bad");
    expect(stored.project.graphs[0].visual!.scope.rowIds).toEqual([]);
    expect(calculateGraph(v, stored.project.graphs[0]).boundaries).toEqual(
      r.boundaries,
    );
    validateGraph(stored.project.graphs[0], v);
  });
  it("계산·원자료 조회 취소와 이전 scope 응답 차단", () => {
    const gate = new JobGate(),
      t = basic(),
      g = graph(t),
      a = gate.startTask("graph", {
        kind: "graph-calculate",
        table: t,
        graph: g,
      }),
      b = gate.startTask("graph", {
        kind: "graph-calculate",
        table: t,
        graph: g,
      });
    let hits = 0;
    expect(
      gate.receive(
        { ...a, type: "complete", result: calculateGraph(t, g) },
        () => hits++,
      ),
    ).toBe(false);
    gate.invalidate("graph");
    expect(
      gate.receive(
        { ...b, type: "complete", result: calculateGraph(t, g) },
        () => hits++,
      ),
    ).toBe(false);
    expect(hits).toBe(0);
  });
});
