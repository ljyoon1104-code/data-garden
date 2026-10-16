import { useAssociation } from "./components/useAssociation";
import { ResultsHub } from './components/ResultsHub';
import { LearningPanel } from './components/LearningPanel';
import { OutputPanel } from './components/OutputPanel';
import type { ResultTarget } from './domain/results';
import {
  AssociationPanel,
  AssociationSettingsPanel,
} from "./components/AssociationPanel";
import { useClustering } from "./components/useClustering";
import {
  ClusteringPanel,
  ClusteringSettingsPanel,
  PointExperiment,
  usePointExperiment,
} from "./components/ClusteringPanel";
import { useRegression } from "./components/useRegression";
import {
  RegressionPanel,
  RegressionSettingsPanel,
} from "./components/RegressionPanel";
import {
  useGraphs,
  GraphPanel,
  GraphSettingsPanel,
} from "./components/GraphPanel";
import { useWrangling } from "./components/useWrangling";
import {
  WranglingSettingsPanel,
  WranglingComparison,
  ProcessingHistory,
} from "./components/WranglingPanel";
import { usePreprocessing } from "./components/usePreprocessing";
import {
  PreprocessingSettingsPanel,
  PreprocessingComparison,
} from "./components/PreprocessingPanel";
import { useEffect, useState } from "react";
import { Icon } from "./components/Icon";
import type { IconName } from "./components/Icon";
import { activeDatasets, getSelection } from "./state/workspace";
import type { Menu, TableInspection, TableView } from "./domain/types";
import { defaultTableView } from "./domain/table";
import { ImportPanel } from "./components/ImportPanel";
import { DataTable } from "./components/DataTable";
import { DataInspector } from "./components/DataInspector";
import { EditPanel } from "./components/EditPanel";
import type { EditTarget } from "./components/EditPanel";
import { TaskStatus } from "./components/DataControls";
import { useTask } from "./workers/useTask";

import type { WorkspaceState, WorkspaceAction } from "./state/workspace";
import { useProjects } from "./persistence/useProjects";
import { usePwa } from "./pwa/usePwa";
import { ProjectManager } from "./components/ProjectManager";

const menus: { id: Menu; label: string; icon: IconName; detail: string }[] = [
  {
    id: "data",
    label: "데이터",
    icon: "data",
    detail: "파일을 열고, 자료를 확인하고, 필요한 값을 편집합니다.",
  },
  {
    id: "prepare",
    label: "정리",
    icon: "prepare",
    detail: "자료를 분석에 알맞은 형태로 준비하는 공간입니다.",
  },
  {
    id: "visualize",
    label: "시각화",
    icon: "visualize",
    detail: "자료의 분포와 관계를 그래프로 탐색하는 공간입니다.",
  },
  {
    id: "analyze",
    label: "분석",
    icon: "analyze",
    detail: "자료 속 관계와 패턴을 알아보는 공간입니다.",
  },
  {
    id: "results",
    label: "결과",
    icon: "results",
    detail: "분석 결과를 비교하고 나의 해석을 남기는 공간입니다.",
  },
];
export default function App() {
  const library = useProjects(),
    pwa = usePwa();
  const [draft, setDraft] = useState(false),
    [busy, setBusy] = useState(false);
  if (!library.ready)
    return (
      <main className="startup" role="status">
        <h1>데이터뜰</h1>
        <p>저장된 프로젝트를 읽고 검증하고 있습니다…</p>
      </main>
    );
  return (
    <>
      <ProjectManager
        library={library}
        pwa={pwa}
        draft={draft}
        busy={busy}
        setBusy={setBusy}
      />
      <LearningPanel library={library} draft={draft} busy={busy} setBusy={setBusy}/>
      <fieldset className="workspace-guard" disabled={busy}>
          <Workspace
            key={library.state.project.id + ":" + library.epoch}
            state={library.state}
            dispatch={library.dispatch}
            setDraft={setDraft}
            writable={library.writable}
          />
      </fieldset>
    </>
  );
}
function Workspace({
  state,
  dispatch,
  setDraft,
  writable,
}: {
  state: WorkspaceState;
  dispatch: (action: WorkspaceAction) => void;
  setDraft: (draft: boolean) => void;
  writable: boolean;
}) {
  const { project, view } = state;
  const { dataset, version, attribute } = getSelection(state);
  const datasets = activeDatasets(project);
  const currentMenu = menus.find((m) => m.id === view.menu)!;
  const preprocessing = usePreprocessing(state, dispatch);
  const wrangling = useWrangling(state, dispatch);
  const graphs = useGraphs(state, dispatch);
  const regression = useRegression(state, dispatch, writable);
  const clustering = useClustering(state, dispatch, writable);
  const association = useAssociation(state, dispatch, writable);
  const experiment = usePointExperiment(clustering);
  const analysisFamily = view.analysisFamily ?? "regression";
  const [prepareFamily, setPrepareFamily] = useState("preprocess");
  const [resultDraft,setResultDraft]=useState(false),[outputPending,setOutputPending]=useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<{
    datasetId: string;
    versionId: string;
    target: EditTarget;
  } | null>(null);
  useEffect(() => {
    setDraft(
      association.hasDraft ||
        resultDraft || outputPending ||
        importOpen ||
        !!editTarget ||
        preprocessing.pending ||
        wrangling.pending ||
        graphs.dirty ||
        experiment.dirty,
    );
    return () => setDraft(false);
  }, [
    importOpen,
    editTarget,
    preprocessing.pending,
    wrangling.pending,
    graphs.dirty,
    experiment.dirty,
    association.hasDraft,
    resultDraft, outputPending,
    setDraft,
  ]);
  const [inspectionState, setInspectionState] = useState<{
    key: string;
    value: TableInspection;
  } | null>(null);
  const [retry, setRetry] = useState(0);
  const inspectTask = useTask("table-inspection");
  const tableView = (dataset && view.tables[dataset.id]) || defaultTableView();
  const queryKey = JSON.stringify({
    version: version?.id,
    sort: tableView.sort,
    filter: tableView.filter,
    duplicatesOnly: tableView.duplicatesOnly,
    statisticsScope: tableView.statisticsScope,
  });
  const inspection =
    inspectionState?.key === queryKey ? inspectionState.value : null;
  useEffect(() => {
    setInspectionState(null);
    if (!version) {
      inspectTask.cancel();
      return;
    }
    inspectTask.run(
      { kind: "inspect", table: version, view: tableView },
      (result) => {
        if (result.kind === "inspect")
          setInspectionState({ key: queryKey, value: result.inspection });
      },
    );
    // Query key deliberately excludes paging and selection; those do not change statistics.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey, retry, inspectTask.run, inspectTask.cancel]);
  const setTableView = (patch: Partial<TableView>) =>
    dataset && dispatch({ type: "table-view", datasetId: dataset.id, patch });
  const openEdit = (target: EditTarget) => {
    if (!writable) return;
    preprocessing.clear();
    wrangling.clear();
    if (dataset && version) {
      setEditTarget({ datasetId: dataset.id, versionId: version.id, target });
      dispatch({ type: "menu", menu: "data" });
    }
  };
  const currentEdit =
    editTarget &&
    editTarget.datasetId === dataset?.id &&
    editTarget.versionId === version?.id
      ? editTarget
      : null;
  const openResult=(target:ResultTarget)=>{
    if(resultDraft)return;
    dispatch({type:'result-detail',target});
    if(target.kind==='graph')graphs.open(target.id);
    else {
      const a=project.analyses.find(a=>a.id===target.id)!;
      dispatch({type:'analysis-family',family:a.kind});
      dispatch({type:a.kind==='regression'?'analysis-select':a.kind==='clustering'?'cluster-select':'association-select',id:a.id});
    }
  };
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        본문으로 건너뛰기
      </a>
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">
            <Icon name="leaf" size={25} />
          </span>
          <strong>데이터뜰</strong>
          <span className="brand-tag">데이터 탐구 공간</span>
        </div>
        <div className="project-name">
          <span className="project-dot" />
          {project.name}
          <span className="session-badge">기기 저장</span>
        </div>
        <div className="privacy">
          <Icon name="shield" size={16} />
          기기 안에서 처리
        </div>
      </header>
      <div className="workspace-bar">
        <label className="dataset-picker">
          <span>현재 자료</span>
          <select
            aria-label="현재 자료"
            value={dataset?.id || ""}
            disabled={!datasets.length}
            onChange={(e) => {
              preprocessing.clear();
              wrangling.clear();
              setEditTarget(null);
              dispatch({ type: "dataset", datasetId: e.target.value });
            }}
          >
            {!datasets.length && <option value="">자료 없음</option>}
            {datasets.map((item) => (
              <option key={item.id} value={item.id}>
                {item.source.kind === "sample" ? "[샘플] " : ""}
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <nav aria-label="작업 메뉴">
          {menus.map((menu) => (
            <button
              key={menu.id}
              aria-current={view.menu === menu.id ? "page" : undefined}
              className={`nav-item ${view.menu === menu.id ? "active" : ""}`}
              onClick={() => {if(resultDraft && !window.confirm("진행 중인 출력 또는 저장하지 않은 해석·질문이 있습니다. 메뉴를 이동할까요?"))return;dispatch({ type: "menu", menu: menu.id });}}
            >
              <Icon name={menu.icon} />
              {menu.label}
            </button>
          ))}
        </nav>
        <button
          className="inspector-toggle"
          aria-expanded={view.inspectorOpen}
          aria-controls="inspector"
          onClick={() => dispatch({ type: "inspector" })}
        >
          <Icon name="panel" size={18} />
          {view.inspectorOpen ? "설정 접기" : "설정 열기"}
        </button>
      </div>
      <div
        className={`workspace ${view.inspectorOpen ? "" : "inspector-closed"}`}
      >
        <main id="main" className="main-content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                나의 데이터 탐구 / {currentMenu.label}
              </div>
              <h1>
                {view.menu === "data" ? "자료 살펴보기" : currentMenu.label}
              </h1>
              <p>{currentMenu.detail}</p>
            </div>
            <span className="stage-label">탐구 · 해석 · 출력</span>
          </div>
          <div className="data-actions">
            <button
              disabled={!writable}
              className="primary-button"
              onClick={() => {
                preprocessing.clear();
                wrangling.clear();
                setImportOpen(true);
                dispatch({ type: "menu", menu: "data" });
              }}
            >
              파일 열기
            </button>
            <span>CSV · XLSX / 내 기기에서 처리</span>
          </div>
          {importOpen && (
            <ImportPanel
              onImport={(incoming) => {
                setEditTarget(null);
                dispatch({ type: "import", dataset: incoming });
              }}
              onClose={() => setImportOpen(false)}
            />
          )}
          {inspectTask.busy && <TaskStatus {...inspectTask} />}
          {view.menu === "data" && <OutputPanel state={state} onPending={setOutputPending}/>}
          {view.menu === "visualize" && <GraphPanel control={graphs} writable={writable}/>}
          {view.menu === 'results' && <ResultsHub state={state} dispatch={dispatch} writable={writable} onDraft={setResultDraft} onOpen={openResult}>
            {view.resultDetail?.kind==='graph'?<GraphPanel control={graphs} writable={writable}/>:analysisFamily==='regression'?<RegressionPanel control={regression}/>:analysisFamily==='clustering'?<ClusteringPanel control={clustering}/>:<AssociationPanel control={association}/>}
          </ResultsHub>}
          {view.menu === "analyze" && (
            <>
              <label className="prepare-picker">
                분석 영역
                <select
                  aria-label="분석 영역"
                  value={analysisFamily}
                  onChange={(e) =>
                    dispatch({
                      type: "analysis-family",
                      family: e.target.value as
                        | "regression"
                        | "clustering"
                        | "experiment"
                        | "association",
                    })
                  }
                >
                  <option value="regression">회귀 · 값 예측</option>
                  <option value="clustering">군집 · K-means</option>
                  <option value="association">연관 · 함께 나타나는 항목</option>
                  <option value="experiment" disabled={!writable}>직접 점 실험</option>
                </select>
              </label>
              {analysisFamily === "regression" ? (
                <RegressionPanel control={regression} />
              ) : analysisFamily === "association" ? (
                <AssociationPanel control={association} />
              ) : analysisFamily === "experiment" ? (
                <PointExperiment control={clustering} experiment={experiment} />
              ) : (
                <ClusteringPanel control={clustering} />
              )}
            </>
          )}
          {!dataset || !version ? (
            <section className="empty-state">
              <div className="empty-icon">
                <Icon name="data" size={38} />
              </div>
              <h2>아직 준비된 자료가 없어요</h2>
              <p>파일 열기로 내 자료를 불러오거나 샘플을 살펴보세요.</p>
              <button
                className="primary-button"
                disabled={!writable} onClick={() => dispatch({ type: "sample-add" })}
              >
                샘플 자료 살펴보기
                <Icon name="arrow" />
              </button>
            </section>
          ) : (
            <>
              {currentEdit && (
                <EditPanel
                  key={`${currentEdit.versionId}:${currentEdit.target.kind}:${currentEdit.target.attribute.id}:${currentEdit.target.kind === "cell" ? currentEdit.target.rowId : ""}`}
                  target={currentEdit.target}
                  dataset={dataset}
                  versionId={version.id}
                  onCommit={(newVersion) =>
                    dispatch({
                      type: "commit-version",
                      datasetId: dataset.id,
                      baseVersionId: version.id,
                      version: newVersion,
                    })
                  }
                  onClose={() => setEditTarget(null)}
                />
              )}
              {view.menu === "prepare" && (
                <>
                  <label className="prepare-picker">
                    정리 작업 영역
                    <select
                      aria-label="정리 작업 영역"
                      value={prepareFamily}
                      onChange={(e) => {
                        preprocessing.clear();
                        wrangling.clear();
                        setPrepareFamily(e.target.value);
                      }}
                    >
                      <option value="preprocess">
                        전처리 · 결측·중복·이상값·스케일링
                      </option>
                      <option value="wrangle">
                        가공·통합 · 계산·날짜·범주·결합·집계
                      </option>
                    </select>
                  </label>
                  <div className="scope-notice">
                    <p>
                      정리 작업은 선택한 버전 전체 자료에 적용됩니다.
                      미리보기에서 변경 내용을 확인한 뒤 적용하세요.
                    </p>
                    <button
                      onClick={() => {
                        if (!view.inspectorOpen)
                          dispatch({ type: "inspector" });
                        document
                          .getElementById(
                            prepareFamily === "preprocess"
                              ? "preprocess-settings"
                              : "wrangle-settings",
                          )
                          ?.scrollIntoView({ behavior: "smooth" });
                      }}
                    >
                      정리 설정으로 이동
                    </button>
                  </div>
                  {prepareFamily === "wrangle" && (
                    <WranglingComparison control={wrangling} />
                  )}
                  {prepareFamily === "preprocess" && preprocessing.preview && (
                    <PreprocessingComparison
                      key={JSON.stringify(
                        preprocessing.preview.fitted.settings,
                      )}
                      preview={preprocessing.preview}
                      table={version}
                    />
                  )}
                </>
              )}
              <div hidden={view.menu !== "data" && view.menu !== "prepare"}>
                {dataset.source.kind === "sample" && (
                  <div className="sample-banner">
                    <span className="sample-badge">샘플</span>
                    <p>
                      화면 확인용 가상 자료입니다. 실제 학생 정보가 아닙니다.
                    </p>
                  </div>
                )}
                <ProcessingHistory
                  project={project}
                  source={{ datasetId: dataset.id, versionId: version.id }}
                />
                <DataTable
                  readOnly={!writable}
                  key={dataset.id}
                  dataset={dataset}
                  version={version}
                  view={tableView}
                  selectedAttributeId={attribute?.id}
                  density={view.density}
                  inspection={inspection}
                  busy={inspectTask.busy}
                  message={!inspectTask.busy ? inspectTask.message : ""}
                  error={inspectTask.error}
                  cancel={inspectTask.cancel}
                  retry={() => setRetry((n) => n + 1)}
                  setView={setTableView}
                  selectAttribute={(id) =>
                    dispatch({ type: "attribute", attributeId: id })
                  }
                  edit={openEdit}
                  setDensity={(density) =>
                    dispatch({ type: "density", density })
                  }
                />
              </div>
            </>
          )}
          <div className="workspace-hint">
            <span>자유롭게 탐구하세요</span>메뉴를 이동해도
            자료·속성·정렬·필터·선택이 유지됩니다.
          </div>
        </main>
        {view.inspectorOpen && (
          <aside
            id="inspector"
            className="inspector"
            aria-label="설정 및 속성 정보"
          >
            <div className="inspector-title">
              <h2>설정 및 정보</h2>
              <span>{currentMenu.label}</span>
            </div>
            <fieldset className="settings-guard" disabled={!writable}>
            {view.menu === "analyze" ? (
              analysisFamily === "regression" ? (
                <RegressionSettingsPanel control={regression} />
              ) : analysisFamily === "association" ? (
                <AssociationSettingsPanel control={association} />
              ) : (
                <ClusteringSettingsPanel control={clustering} />
              )
            ) : view.menu === 'results' ? <p>목록에서 결과를 선택해 당시 근거·해석·출력을 확인하세요.</p> : view.menu === "visualize" ? (
              <GraphSettingsPanel control={graphs} />
            ) : view.menu === "prepare" && version ? (
              prepareFamily === "wrangle" ? (
                <WranglingSettingsPanel control={wrangling} />
              ) : (
                <PreprocessingSettingsPanel
                  table={version}
                  control={preprocessing}
                />
              )
            ) : (
              <DataInspector
                dataset={dataset}
                version={version}
                attribute={attribute}
                inspection={inspection}
                tableView={tableView}
                selectAttribute={(attributeId) =>
                  dispatch({ type: "attribute", attributeId })
                }
                editAttribute={(selected) =>
                  openEdit({ kind: "attribute", attribute: selected })
                }
                setScope={(statisticsScope) =>
                  setTableView({ statisticsScope })
                }
              />
            )}
            </fieldset>
            <div className="session-note">
              <strong>내 기기에 자동 저장</strong>
              <p>
                확정한 자료·편집·화면 설정을 이 브라우저에 저장합니다.
                <br />
                공용 PC에서는 사용 후 프로젝트 관리에서 자료를 삭제하세요.
                중요한 자료는 JSON으로 백업하세요.
              </p>
              {dataset?.source.kind === "sample" && (
                <button
                  className="text-button"
                  disabled={!writable}
                  onClick={() => {
                    setEditTarget(null);
                    dispatch({ type: "sample-remove" });
                  }}
                >
                  샘플 닫기 · 빈 화면 보기
                </button>
              )}
            </div>
          </aside>
        )}
      </div>
      <footer className="app-footer">
        <span>데이터뜰 / 질문에서 발견으로</span>
        <span>탐구·해석·출력 · v1.0</span>
      </footer>
    </div>
  );
}
