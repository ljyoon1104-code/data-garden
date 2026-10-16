import {
  prepareTransactions,
  runAssociation,
  associationDetail,
} from "../domain/association";
import { runClustering, clusterDetail } from "../domain/clustering";
import { runRegression, predictRegression } from "../domain/regression";
import { calculateGraph, graphRows } from "../domain/graphs";
/// <reference lib="webworker" />
import type { WorkerRequest, WorkerResponse, DataTaskResult } from "./protocol";
import { previewWrangling, commitWrangling } from "../domain/wrangling";

import { editVersion, inspectTable } from "../domain/table";
import {
  readBackup,
  RESTORE_BYTES,
  validateWorkspace,
} from "../persistence/format";

import {
  previewPreprocessing,
  commitPreprocessing,
} from "../domain/preprocessing";

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  const send = (message: WorkerResponse<DataTaskResult>) =>
    self.postMessage(message);
  const identity = { jobId: request.jobId, scopeId: request.scopeId };
  if (request.type === "cancel") {
    send({ ...identity, type: "cancelled" });
    return;
  }
  if (request.type !== "run-task") return;
  const progress = (message: string) =>
    send({ ...identity, type: "progress", completed: 0, total: null, message });
  try {
    let result: DataTaskResult;
    const task = request.task;
    switch (task.kind) {
      case 'report-prepare': {const {prepareReport}=await import('../domain/report');result={kind:task.kind,report:prepareReport(task.input,progress)};break;}
      case 'report-html': {progress('그림과 표를 단일 HTML로 구성 중…');const {reportHtml}=await import('../domain/report');result={kind:task.kind,html:reportHtml(task.report)};break;}
      case 'output-preview': {
        const {prepareOutput}=await import('../domain/export');
        result={kind:task.kind,book:prepareOutput(task.input,progress)};break;
      }
      case 'output-file': {
        progress('고정한 표를 파일로 직렬화 중…');
        const {serializeOutput}=await import('../domain/export');
        result={kind:task.kind,files:await serializeOutput(task.book,task.format,task.tableIndex,task.safe)};break;
      }
      case "association-preview":
        result = {
          kind: task.kind,
          result: prepareTransactions(task.input, task.settings, progress),
        };
        break;
      case "association-run":
        result = {
          kind: task.kind,
          result: runAssociation(task.input, task.settings, progress),
        };
        break;
      case "association-detail":
        progress("당시 거래·규칙·분자·분모 조회 중…");
        result = {
          kind: task.kind,
          result: associationDetail(task.table, task.result, task.query),
        };
        break;
      case "clustering-run":
        result = {
          kind: task.kind,
          result: runClustering(task.plan, task.settings, progress),
        };
        break;
      case "clustering-detail":
        progress("고정 중심·당시 행으로 과정·통계·거리 근거 조회 중…");
        result = {
          kind: task.kind,
          result: clusterDetail(task.table, task.result, task.query),
        };
        break;
      case "regression-run":
        result = {
          kind: task.kind,
          result: runRegression(task.plan, task.settings, progress),
        };
        break;
      case "regression-predict":
        progress("고정 학습 기준·모델로 예측 근거를 계산하는 중…");
        result = {
          kind: task.kind,
          result: predictRegression(
            task.plan,
            task.result,
            task.values,
            task.rowId,
          ),
        };
        break;
      case "graph-calculate":
        progress("그래프 범위·집계·공통 축·표시점을 계산하는 중…");
        result = {
          kind: task.kind,
          result: calculateGraph(task.table, task.graph),
        };
        break;
      case "graph-rows":
        progress("선택한 표시값의 당시 입력 행을 찾는 중…");
        result = {
          kind: task.kind,
          result: graphRows(task.table, task.graph, task.query, task.page),
        };
        break;
      case "validate-workspace":
        progress("저장된 자료·가공 기준·출처를 검증하는 중…");
        result = {
          kind: "restore",
          workspace: validateWorkspace(task.workspace),
        };
        break;
      case "wrangle-preview":
        progress(
          "전체 입력의 계산 기준·예상 크기·출처를 확인하고 미리보기를 계산하는 중…",
        );
        result = {
          kind: task.kind,
          preview: previewWrangling(task.inputs, task.settings, task.remaining),
        };
        break;
      case "wrangle-commit":
        progress("확인한 기준과 입력 버전으로 결과·보존본을 만드는 중…");
        result = {
          kind: task.kind,
          ...commitWrangling(
            task.inputs,
            task.fitted,
            task.remaining,
            task.acknowledgedMany,
          ),
        };
        break;
      case "preprocess-preview":
        progress("전체 자료에서 처리 기준과 전후 통계를 계산하는 중…");
        result = {
          kind: task.kind,
          preview: previewPreprocessing(task.table, task.source, task.settings),
        };
        break;
      case "preprocess-commit":
        progress("확인한 기준을 적용하여 새 자료 버전을 준비하는 중…");
        result = {
          kind: task.kind,
          version: commitPreprocessing(
            task.table,
            task.source,
            task.fitted,
            task.lineage,
          ),
        };
        break;
      case "restore":
        if (task.file.size > RESTORE_BYTES)
          throw new Error(
            "프로젝트 복원 파일은 80 MiB 이하로 나누세요. 버전·JSON 복사에 필요한 메모리 한도입니다.",
          );
        progress("백업 파일의 형식·버전·참조를 검증하는 중…");
        result = {
          kind: "restore",
          workspace: readBackup(await task.file.text(), true),
        };
        break;
      case "parse": {
        const {parseBytes,limits}=await import("../data/import");
        if (task.file.size > limits.bytes)
          throw new Error("파일이 20MB를 넘습니다. 나누어 불러오세요.");
        progress("기기에서 파일을 읽는 중…");
        const bytes = await task.file.arrayBuffer();
        progress("자료와 셀 형식을 해석하는 중…");
        result = {
          kind: "parse",
          parsed: parseBytes(bytes, task.file.name, task.options),
        };
        break;
      }
      case "register": {
        const {registerImport}=await import("../data/import");
        progress("전체 행의 자료형을 검증하고 원본·버전을 준비하는 중…");
        result = {
          kind: "register",
          dataset: registerImport(task.parsed, task.columns, task.acknowledged),
        };
        break;
      }
      case "edit":
        progress("변경 값을 검증하고 새 버전을 준비하는 중…");
        result = {
          kind: "edit",
          version: editVersion(task.dataset, task.versionId, task.edit),
        };
        break;
      case "inspect":
        progress("필터·정렬·중복 행·기술통계를 계산하는 중…");
        result = {
          kind: "inspect",
          inspection: inspectTable(task.table, task.view),
        };
        break;
    }
    send({ ...identity, type: "complete", result });
  } catch (error) {
    send({
      ...identity,
      type: "error",
      error: {
        code: "DATA_TASK_FAILED",
        message: "작업을 완료하지 못했습니다.",
        cause: error instanceof Error ? error.message : String(error),
        remedy:
          request.task.kind === "restore"
            ? "데이터뜰 JSON 백업인지, 파일·보존 셀 한도와 앱 버전을 확인하세요. 파일을 만든 앱 버전 또는 올바른 백업으로 다시 시도하세요. 현재 프로젝트는 바뀌지 않았습니다."
            : "표시된 행·열과 입력 조건을 확인한 뒤 수정하여 다시 실행하세요. 취소하면 기존 자료는 그대로 유지됩니다.",
      },
    });
  }
};
