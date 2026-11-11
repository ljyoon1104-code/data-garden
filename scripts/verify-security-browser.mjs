import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const directory = resolve(process.argv[2]);
const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
const serverCwd = await realpath(process.cwd());
const report = {
  reportVersion: 2, startedAt: new Date().toISOString(),
  fixtureSourceHash: manifest.sourceHash,
  sourceToBuildRelation: 'Not established by this harness: fixtureSourceHash identifies the fixture generator sources, not the served build. Compare a separate build/source manifest.',
  tests: [], console: [], requests: [], failedRequests: [], nativeWorkers: [], workerEvidence: [],
};
const fixture = name => join(directory, name);
const save = () => writeFile(fixture('browser-results.json'), JSON.stringify(report, null, 2));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
async function servedBuildEvidence(address) {
  const outputRoot = await realpath(join(serverCwd, 'dist'));
  const indexBytes = await readFile(join(outputRoot, 'index.html'));
  const mainPaths = [...indexBytes.toString('utf8').matchAll(/<script\b[^>]*\bsrc="(\.\/assets\/index-[A-Za-z0-9_-]+\.js)"/g)].map(match => match[1].slice(2));
  assert.equal(mainPaths.length, 1, 'Expected exactly one Vite main script in the served index');
  const files = [];
  for (const relativePath of ['index.html', mainPaths[0], 'sw.js']) {
    const file = join(outputRoot, relativePath);
    const disk = await readFile(file);
    const metadata = await stat(file);
    const response = await fetch(new URL(relativePath, address), { redirect: 'error' });
    assert.equal(response.status, 200, `Build evidence HTTP status: ${relativePath}`);
    const servedSha256 = sha256(new Uint8Array(await response.arrayBuffer()));
    const diskSha256 = sha256(disk);
    assert.equal(servedSha256, diskSha256, `Served build changed: ${relativePath}`);
    files.push({ relativePath, bytes: disk.length, modifiedAt: metadata.mtime.toISOString(), diskSha256, servedSha256 });
  }
  return {
    observedAt: new Date().toISOString(), serverCwd, outputRoot, files,
    timestampMeaning: 'modifiedAt is each output file mtime, not a claim about when the source was built.',
  };
}
const reservation = createServer();
await new Promise((ok, bad) => { reservation.once('error', bad); reservation.listen(0, '127.0.0.1', ok); });
const port = reservation.address().port;
await new Promise(ok => reservation.close(ok));
const server = spawn(process.execPath, ['scripts/serve-production.mjs', String(port)], { cwd: serverCwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
try {
  await new Promise((ok, bad) => { server.stdout.once('data', ok); server.stderr.once('data', value => bad(new Error(String(value)))); server.once('error', bad); });
  report.address = `http://127.0.0.1:${port}/`;
  report.servedBuild = await servedBuildEvidence(report.address);
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  report.browser = browser.version();
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1365, height: 900 } });
  await context.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.__workerAudit = [];
    window.__workerRefs = [];
    window.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args);
        const record = { id: window.__workerAudit.length, url: String(args[0]), messages: [], terminated: false };
        this.auditRecord = record;
        window.__workerAudit.push(record);
        window.__workerRefs.push(this);
        this.addEventListener('message', event => {
          const data = event.data;
          record.messages.push({ type: data.type, kind: data.result?.kind, message: data.type === 'progress' ? data.message : undefined });
          if (record.fileName === 'normal-input.csv' && data.type === 'complete' && data.result?.kind === 'parse')
            window.__smallParseReply = data;
        });
      }
      postMessage(data, ...rest) {
        if (data.type === 'run-task') Object.assign(this.auditRecord, { jobId: data.jobId, scopeId: data.scopeId, kind: data.task.kind, fileName: data.task.file?.name, sheet: data.task.options?.sheet, encoding: data.task.options?.encoding, delimiter: data.task.options?.delimiter });
        if (data.type === 'cancel') this.auditRecord.cancelPosted = true;
        return super.postMessage(data, ...rest);
      }
      terminate() {
        this.auditRecord.terminated = true;
        this.auditRecord.completedBeforeTerminate = this.auditRecord.messages.some(message => message.type === 'complete');
        return super.terminate();
      }
    };
    window.__replayOldReply = id => {
      const record = window.__workerAudit[id];
      const data = structuredClone(window.__smallParseReply);
      if (!data) throw new Error('No small real Worker reply captured');
      data.jobId = record.jobId;
      data.scopeId = record.scopeId;
      data.result.parsed.proposed.columns[0].name = 'STALE_RESPONSE_SHOULD_NOT_APPEAR';
      window.__workerRefs[id].dispatchEvent(new MessageEvent('message', { data }));
    };
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('console', message => { if (message.type() === 'error') report.console.push({ message: message.text(), stage: report.stage }); });
  page.on('pageerror', error => report.console.push({ message: error.message, stage: report.stage, uncaught: true }));
  context.on('request', request => report.requests.push({ url: request.url(), method: request.method(), type: request.resourceType(), bytes: request.postDataBuffer()?.length ?? 0, stage: report.stage }));
  context.on('requestfailed', request => report.failedRequests.push({ url: request.url(), reason: request.failure()?.errorText, stage: report.stage, offline: report.offline === true }));
  context.on('response', response => { if (response.status() >= 400) report.failedRequests.push({ url: response.url(), reason: 'HTTP ' + response.status(), stage: report.stage, offline: report.offline === true }); });
  page.on('worker', worker => {
    const record = { id: report.nativeWorkers.length, url: worker.url(), createdStage: report.stage, closed: false };
    report.nativeWorkers.push(record);
    worker.on('close', () => { record.closed = true; record.closedStage = report.stage; });
  });
  const stage = async (name, test) => {
    report.stage = name;
    const start = Date.now();
    try { await test(); report.tests.push({ name, status: 'passed', milliseconds: Date.now() - start }); }
    catch (error) { report.tests.push({ name, status: 'failed', error: error.message }); await page.screenshot({ path: fixture('browser-failure.png'), fullPage: true }).catch(() => {}); await writeFile(fixture('browser-failure.txt'), await page.locator('body').innerText()).catch(() => {}); throw error; }
    finally { await save(); }
  };
  const manager = async () => {
    const toggle = page.getByRole('button', { name: '프로젝트 관리', exact: true });
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  };
  const saved = () => page.getByText(/저장 완료 ·|저장된 프로젝트를 불러왔습니다/).first().waitFor({ state: 'visible' });
  const selected = () => page.getByLabel('현재 자료', { exact: true }).inputValue();
  const preview = () => page.locator('.preview-heading strong').waitFor();
  const fingerprint = () => page.evaluate(async () => {
    const databases = await indexedDB.databases();
    const name = databases.find(database => database.name?.startsWith('data-garden:'))?.name;
    if (!name) throw new Error('Project database missing');
    const db = await new Promise((ok, bad) => { const request = indexedDB.open(name); request.onsuccess = () => ok(request.result); request.onerror = () => bad(request.error); });
    const states = await new Promise((ok, bad) => { const transaction = db.transaction('projects', 'readonly'); const request = transaction.objectStore('projects').getAll(); transaction.oncomplete = () => ok(request.result); transaction.onabort = () => bad(transaction.error); });
    db.close();
    const projects = states.map(state => state.project).sort((a, b) => a.id.localeCompare(b.id));
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(projects)));
    return { ids: projects.map(project => project.id), digest: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('') };
  });
  const refreshPreserved = async before => {
    await page.reload();
    await page.getByLabel('현재 자료', { exact: true }).waitFor();
    await saved();
    assert.deepEqual(await fingerprint(), before);
  };
  const openImport = async (name, encoding = 'utf-8') => {
    if (!await page.getByLabel('CSV 또는 XLSX 파일', { exact: true }).isVisible()) await page.getByRole('button', { name: '파일 열기', exact: true }).click();
    await page.getByLabel('CSV 또는 XLSX 파일', { exact: true }).setInputFiles(fixture(name));
    if (name.endsWith('.csv')) {
      const control = page.getByLabel('인코딩', { exact: true });
      if (await control.inputValue() !== encoding) await control.selectOption(encoding);
      const delimiter = page.getByLabel('구분자', { exact: true });
      if (await delimiter.inputValue() !== ',') await delimiter.selectOption(',');
    }
  };
  const closeImport = () => page.getByRole('button', { name: '취소 · 닫기', exact: true }).click();
  const acceptImport = async () => {
    await page.getByLabel(/열 이름·자료형·의미 유형과 보정/).check();
    await page.getByRole('button', { name: '불러오기', exact: true }).click();
    await page.getByLabel('CSV 또는 XLSX 파일', { exact: true }).waitFor({ state: 'hidden' });
    await saved();
  };
  const importError = async (name, text) => {
    const before = await fingerprint();
    await openImport(name);
    await page.locator('.import-panel').getByRole('alert').filter({ hasText: text }).waitFor();
    assert.deepEqual(await fingerprint(), before);
    await closeImport();
    await refreshPreserved(before);
  };
  const restore = async (name, error) => {
    const before = await fingerprint();
    await manager();
    await page.getByLabel('JSON 백업 파일 선택', { exact: true }).setInputFiles(fixture(name));
    if (error) {
      await page.getByRole('alert').filter({ hasText: error }).waitFor();
      assert.deepEqual(await fingerprint(), before);
      await refreshPreserved(before);
    } else {
      const confirm = page.getByRole('button', { name: '새 프로젝트로 복원 확정', exact: true });
      await confirm.click();
      await confirm.waitFor({ state: 'hidden' });
      await saved();
      const after = await fingerprint();
      assert.equal(after.ids.length, before.ids.length + 1);
      for (const id of before.ids) assert(after.ids.includes(id));
    }
  };
  const startedJob = async (kind, fileName) => {
    await page.waitForFunction(({ kind, fileName }) => window.__workerAudit.some(record => record.kind === kind && record.fileName === fileName && !record.terminated && record.messages.some(message => message.type === 'progress')), { kind, fileName });
    return page.evaluate(({ kind, fileName }) => window.__workerAudit.findLast(record => record.kind === kind && record.fileName === fileName && !record.terminated), { kind, fileName });
  };
  const terminatedJob = async (job, reason) => {
    await page.waitForFunction(id => window.__workerAudit[id]?.terminated, job.id);
    const record = await page.evaluate(id => window.__workerAudit[id], job.id);
    assert.equal(record.completedBeforeTerminate, false, 'Cancellation was too late to stop the task');
    report.workerEvidence.push({ reason, ...record });
  };
  await stage('initial-load', async () => { await page.goto(report.address); await page.getByLabel('현재 자료', { exact: true }).waitFor(); await saved(); });
  await stage('csv-normal-and-boundary', async () => {
    for (const name of ['normal-input.csv', 'boundary-input.csv']) { await openImport(name); await preview(); await acceptImport(); }
  });
  await stage('csv-euckr', async () => { await openImport('euckr-input.csv', 'euc-kr'); await preview(); await acceptImport(); });
  await stage('csv-limits-preserve-and-refresh', async () => { await importError('csv-overrows.csv', /50,000행/); await importError('csv-long-field.csv', /셀 텍스트/); });
  await stage('xlsx-selective-read', async () => {
    await openImport('selective.xlsx');
    await page.getByLabel('시트', { exact: true }).locator('option').filter({ hasText: '정상' }).waitFor({ state: 'attached' });
    await page.getByLabel('시트', { exact: true }).selectOption({ label: '정상' });
    await preview(); await acceptImport();
  });
  await stage('xlsx-invalid-selected-and-limit', async () => {
    const before = await fingerprint();
    await openImport('selective.xlsx');
    await page.getByLabel('시트', { exact: true }).selectOption({ label: '손상' });
    await page.locator('.import-panel').getByRole('alert').waitFor();
    await closeImport();
    await openImport('xlsx-overrange.xlsx');
    await page.getByLabel('시트', { exact: true }).selectOption({ label: '큰 범위' });
    await page.locator('.import-panel').getByRole('alert').filter({ hasText: /한도/ }).waitFor();
    await closeImport(); assert.deepEqual(await fingerprint(), before); await refreshPreserved(before);
  });
  await stage('backup-normal-and-legacy', async () => { await restore('normal-backup.json'); await restore('legacy-backup.json'); });
  await stage('backup-lexical-and-utf8', async () => { await restore('deep-backup.json', /중첩/); await restore('bad-utf8.json', /UTF-8/); });
  await stage('backup-shared-work', async () => { await restore('graphs-30.json'); await restore('graphs-48.json', /누적 복원/); });
  await stage('cancel-file-worker-and-refresh', async () => {
    const before = await fingerprint();
    await openImport('cancel-input.csv');
    const job = await startedJob('parse', 'cancel-input.csv');
    await page.locator('.import-panel').getByRole('button', { name: '작업 취소', exact: true }).click({ force: true });
    await page.getByText(/작업이 취소되었습니다/).waitFor();
    await terminatedJob(job, 'explicit CSV cancel');
    await closeImport(); assert.deepEqual(await fingerprint(), before); await refreshPreserved(before);
  });
  await stage('close-file-worker', async () => {
    const before = await fingerprint();
    await openImport('cancel-input.csv'); const job = await startedJob('parse', 'cancel-input.csv');
    await closeImport(); await terminatedJob(job, 'close import panel');
    assert.deepEqual(await fingerprint(), before);
  });
  await stage('condition-file-and-late-reply', async () => {
    const before = await fingerprint();
    await openImport('normal-input.csv'); await preview();
    await openImport('cancel-input.csv'); const job = await startedJob('parse', 'cancel-input.csv');
    await openImport('normal-input.csv'); await preview();
    await terminatedJob(job, 'replace file');
    await page.evaluate(id => window.__replayOldReply(id), job.id);
    await page.waitForFunction(() => !document.body.innerText.includes('STALE_RESPONSE_SHOULD_NOT_APPEAR'));
    assert.match(await page.locator('.preview-heading').innerText(), /전체 3행/);
    report.workerEvidence.push({ reason: 'synthetic late reply replayed through the cancelled real Worker event handler', rejected: true, jobId: job.jobId });
    await closeImport(); assert.deepEqual(await fingerprint(), before);
  });
  await stage('condition-encoding-and-delimiter', async () => {
    const before = await fingerprint();
    for (const control of ['인코딩', '구분자']) {
      await openImport('cancel-input.csv'); const job = await startedJob('parse', 'cancel-input.csv');
      await page.getByLabel(control, { exact: true }).selectOption(control === '인코딩' ? 'euc-kr' : ';');
      await terminatedJob(job, `change ${control}`);
      await openImport('normal-input.csv'); await preview();
      assert.match(await page.locator('.preview-heading').innerText(), /전체 3행/);
      await closeImport();
    }
    assert.deepEqual(await fingerprint(), before);
  });
  await stage('condition-sheet', async () => {
    const before = await fingerprint();
    await openImport('selective.xlsx');
    await page.getByLabel('시트', { exact: true }).selectOption({ label: '손상' });
    await page.getByLabel('시트', { exact: true }).selectOption({ label: '정상' });
    await preview(); assert.equal(await page.locator('.import-panel').getByRole('alert').count(), 0);
    await closeImport(); assert.deepEqual(await fingerprint(), before);
  });
  await stage('cancel-restore-worker-and-preserve', async () => {
    const before = await fingerprint(); await manager();
    await page.getByLabel('JSON 백업 파일 선택', { exact: true }).setInputFiles(fixture('graphs-30.json'));
    const job = await startedJob('restore', 'graphs-30.json');
    const managerPanel = page.getByLabel('프로젝트 관리', { exact: true });
    await managerPanel.getByRole('button', { name: '작업 취소', exact: true }).click({ force: true });
    await page.getByText(/작업이 취소되었습니다/).waitFor(); await terminatedJob(job, 'explicit JSON restore cancel');
    assert.equal(await page.getByRole('button', { name: '새 프로젝트로 복원 확정', exact: true }).count(), 0);
    assert.deepEqual(await fingerprint(), before); await refreshPreserved(before);
  });
  await stage('safe-csv-output-and-xlsx-fallback', async () => {
    await page.getByRole('button', { name: '데이터', exact: true }).click();
    await openImport('normal-input.csv'); await preview(); await acceptImport();
    await page.getByRole('button', { name: '자료 내보내기', exact: true }).click();
    await page.getByRole('button', { name: '출력 범위 확인', exact: true }).click();
    await page.getByRole('button', { name: '파일 만들기', exact: true }).click();
    await page.getByText('파일이 준비됐습니다.', { exact: false }).waitFor();
    const downloadReady = page.waitForEvent('download');
    await page.getByRole('button', { name: /\.csv 내려받기$/ }).click(); await (await downloadReady).saveAs(fixture('browser-safe-output.csv'));
    await openImport('blocked-input.csv'); await preview(); await acceptImport();
    await page.getByRole('button', { name: '출력 범위 확인', exact: true }).click();
    await page.getByRole('button', { name: '파일 만들기', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: /XLSX/ }).waitFor();
    await page.locator('.output-panel label').filter({ hasText: '파일 형식' }).locator('select').selectOption('xlsx');
    await page.getByRole('button', { name: '파일 만들기', exact: true }).click();
    const xlsx = page.getByRole('button', { name: /\.xlsx 내려받기$/ }); await xlsx.waitFor();
    const ready = page.waitForEvent('download'); await xlsx.click(); await (await ready).saveAs(fixture('browser-typed-output.xlsx'));
    await page.screenshot({ path: fixture('browser-output.png'), fullPage: true });
  });
  await stage('offline-new-libraries-and-restore', async () => {
    await manager(); await page.getByText(/오프라인 파일 준비 완료/).first().waitFor();
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    report.offline = true; await context.setOffline(true); await page.reload();
    await page.getByLabel('현재 자료', { exact: true }).waitFor(); await saved();
    await openImport('normal-input.csv'); await preview(); await acceptImport();
    await openImport('selective.xlsx');
    await page.getByLabel('시트', { exact: true }).selectOption({ label: '정상' }); await preview(); await acceptImport();
    await restore('normal-backup.json');
    report.cache = await page.evaluate(async () => {
      const output = [];
      for (const name of await caches.keys()) output.push({ name, urls: (await (await caches.open(name)).keys()).map(request => request.url) });
      return output;
    });
    assert(!report.cache.some(cache => cache.urls.some(url => /normal-backup|normal-input|blocked-input|selective\.xlsx/.test(url))));
    await page.screenshot({ path: fixture('browser-offline.png'), fullPage: true });
    await context.setOffline(false); report.offline = false;
  });
  await stage('final-network-and-console', async () => {
    report.externalRequests = report.requests.filter(request => /^https?:/.test(request.url) && !request.url.startsWith(report.address));
    assert.equal(report.externalRequests.length, 0);
    assert.equal(report.requests.filter(request => request.method !== 'GET' || request.bytes > 0).length, 0);
    assert.equal(report.console.filter(message => message.uncaught).length, 0);
    report.unexpectedFailures = report.failedRequests.filter(request => !(request.offline && /ERR_INTERNET_DISCONNECTED/.test(request.reason ?? '')) && !/ERR_ABORTED/.test(request.reason ?? ''));
    assert.equal(report.unexpectedFailures.length, 0);
  });
  await page.screenshot({ path: fixture('browser-completed.png'), fullPage: true });
  report.finishedAt = new Date().toISOString(); await save();
  console.log(JSON.stringify({ tests: report.tests, browser: report.browser, address: report.address, console: report.console, failures: report.failedRequests, workerEvidence: report.workerEvidence.length }));
} catch (error) {
  report.error = error.stack; await save(); console.error(error.stack); process.exitCode = 1;
} finally {
  await browser?.close();
  if (server.exitCode === null) { const exited = new Promise(ok => server.once('exit', ok)); server.kill(); await exited; }
}
