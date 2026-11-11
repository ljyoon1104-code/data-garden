import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import * as XLSX from 'xlsx';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = resolve(projectRoot, 'tmp');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (args) => execFileSync('git', ['--no-optional-locks', ...args], {
  cwd: projectRoot, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
});

function sourceSnapshot() {
  const inputs = new Set([
    'index.html', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts',
    'scripts/security-fixtures.mjs', 'scripts/serve-production.mjs', 'scripts/check-build.mjs',
  ]);
  const paths = [...new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    .split('\0').filter((name) => inputs.has(name) || name.startsWith('public/') ||
      name.startsWith('src/') && !/\.test\.[cm]?[jt]sx?$/.test(name)))].sort();
  const files = paths.map((name) => {
    const path = resolve(projectRoot, name);
    if (!existsSync(path)) return { path: name, missing: true };
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Source is not an ordinary file: ${name}`);
    const data = readFileSync(path);
    return { path: name, bytes: data.length, sha256: sha256(data) };
  });
  const hash = createHash('sha256');
  for (const file of files)
    hash.update(`${file.path}\0${file.bytes ?? 'missing'}\0${file.sha256 ?? ''}\0`);
  return {
    algorithm: 'SHA-256 over sorted application/build/generator file path, byte count and SHA-256, separated by NUL',
    scope: { application: 'src/ except *.test.*; public/', inputs: [...inputs], verificationFiles: 'README, docs, tests and browser harness are outside this source digest' },
    sha256: hash.digest('hex'), files,
  };
}

function assertAuditPath(path) {
  if (!path.startsWith(tempRoot + sep)) throw new Error('Audit directory must be inside this project tmp directory');
  for (let current = path; current !== projectRoot; current = dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink())
      throw new Error(`Audit path contains a symbolic link or junction: ${current}`);
  }
  if (lstatSync(projectRoot).isSymbolicLink()) throw new Error('Project root is a link');
  const ignored = relative(projectRoot, path).replaceAll('\\', '/');
  git(['check-ignore', '--', ignored]);
}

function loadApp() {
  const entry = `
    export { csvText, serializeOutput } from './src/domain/export';
    export { parseBytes, parseCsvFile, parseXlsxBytes, readXlsxSheetNames, registerImport, defaultImportOptions, limits } from './src/data/import';
    export { csvReadLimits } from './src/data/csv-input';
    export { createWorkspace, getSelection, workspaceReducer } from './src/state/workspace';
    export { makeBackup, readBackup, readBackupBytes } from './src/persistence/format';
    export { backupJsonLimits } from './src/persistence/backup-limits';
    export { newGraph, calculateGraph } from './src/domain/graphs';
  `;
  const built = buildSync({
    stdin: { contents: entry, resolveDir: projectRoot, sourcefile: 'security-fixture-entry.ts', loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
  });
  const module = { exports: {} };
  const require = createRequire(import.meta.url);
  new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, module, module.exports);
  return module.exports;
}

function corruptSheetCrc(input, sheetIndex) {
  const bytes = Buffer.from(input);
  let end = bytes.length - 22;
  while (end >= 0 && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error('Generated workbook lacks its ZIP directory');
  let cursor = bytes.readUInt32LE(end + 16);
  for (let index = 0; index < bytes.readUInt16LE(end + 10); index++) {
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    if (name === `xl/worksheets/sheet${sheetIndex}.xml`) {
      const local = bytes.readUInt32LE(cursor + 42);
      if (bytes.readUInt16LE(local + 6) & 8) throw new Error('Unexpected descriptor in generated workbook');
      const wrong = (bytes.readUInt32LE(cursor + 16) ^ 0xffffffff) >>> 0;
      bytes.writeUInt32LE(wrong, cursor + 16);
      bytes.writeUInt32LE(wrong, local + 14);
      return bytes;
    }
    cursor += 46 + nameLength + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
  }
  throw new Error('Generated worksheet not found for intentional CRC error');
}

function importWorkbook() {
  const book = XLSX.utils.book_new();
  const normal = XLSX.utils.aoa_to_sheet([
    ['학생코드', '조사일', '점수', '동의', '메모'],
    [123, 45292, -5, true, '한글, "검증"\n다음 줄'],
    [456, 45293, 0, false, null],
    ['00999', 45294, 5, true, '일반 문자열'],
  ]);
  for (const row of [2, 3]) normal[`A${row}`].z = '00000';
  for (const row of [2, 3, 4]) normal[`B${row}`].z = 'yyyy-mm-dd';
  XLSX.utils.book_append_sheet(book, normal, '정상');
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['가상'], [7]]), '손상');
  const largeRange = XLSX.utils.aoa_to_sheet([['가상'], [1]]);
  XLSX.utils.book_append_sheet(book, largeRange, '큰 범위');
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([]), '빈 시트');
  const ordinary = Buffer.from(XLSX.write(book, { type: 'array', bookType: 'xlsx', compression: true }));
  return ordinary;
}

function withOverrangeSheet(input, sheetIndex) {
  const zip = XLSX.CFB.read(input, { type: 'buffer' });
  const name = `xl/worksheets/sheet${sheetIndex}.xml`;
  const entry = XLSX.CFB.find(zip, '/' + name);
  if (!entry) throw new Error('Generated sheet missing');
  const xml = Buffer.from(entry.content).toString('utf8')
    .replace(/<dimension ref="[^"]*"\/>/, '<dimension ref="A1:XFD1048576"/>');
  if (!xml.includes('A1:XFD1048576')) throw new Error('Generated worksheet dimension not found');
  // CFB.write adds its own synthetic marker entry. Rebuild only the tiny generated
  // workbook's actual file entries so ZIP-path checks observe a normal OOXML ZIP.
  const files = zip.FullPaths.flatMap((path, index) => {
    const relative = path.replace(/^Root Entry\//, '');
    if (!relative || relative.endsWith('/') || relative.startsWith('\u0001')) return [];
    return [{ name: relative, data: relative === name ? Buffer.from(xml) : Buffer.from(zip.FileIndex[index].content) }];
  });
  return storedZip(files);
}

function storedZip(files) {
  const local = [], central = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name), data = file.data;
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30), directory = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8);
    directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
    local.push(header, name, data); central.push(directory, name); offset += header.length + name.length + data.length;
  }
  const index = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, index, end]);
}

function arrayBuffer(data) {
  return Uint8Array.from(data).buffer;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function generate() {
  const source = sourceSnapshot();
  const app = loadApp();
  const generatedAt = new Date().toISOString();
  const suffix = generatedAt.replace(/[-:.]/g, '') + '-' + randomUUID().slice(0, 8);
  const directory = resolve(tempRoot, 'security-audit-' + suffix);
  assertAuditPath(directory);
  if (existsSync(directory)) throw new Error('Audit directory already exists');
  mkdirSync(tempRoot, { recursive: true });
  mkdirSync(directory);
  const files = [];
  const checks = [];
  function write(name, data, purpose, expectation) {
    if (basename(name) !== name || !/^[a-z0-9][a-z0-9._-]*$/i.test(name)) throw new Error('Unsafe generated filename');
    const bytes = Buffer.from(data);
    writeFileSync(resolve(directory, name), bytes, { flag: 'wx' });
    files.push({ name, bytes: bytes.length, sha256: sha256(bytes), purpose, expectation });
    return bytes;
  }
  async function checked(label, expected, action, pattern) {
    try {
      const value = await action();
      if (expected === 'reject') throw new Error('Expected rejection but the app accepted the fixture');
      checks.push({ label, expected, actual: 'accepted', summary: value });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (expected !== 'reject' || !pattern?.test(message)) throw error;
      checks.push({ label, expected, actual: 'rejected', message });
    }
  }
  const csvFile = (name, bytes) => new File([bytes], name, { type: 'text/csv' });
  const summarizeImport = (parsed) => ({ rows: parsed.original.rows.length, columns: parsed.original.columns.length, issues: parsed.issues.length, empty: parsed.empty });

  const candidates = [
    ['korean-comma-quotes', '한글, "검증 자료"'], ['normal-lf', '첫 줄\n둘째 줄'],
    ['normal-cr', '첫 줄\r둘째 줄'], ['normal-crlf', '첫 줄\r\n둘째 줄'],
    ['number-negative', -5], ['number-zero', 0], ['number-positive', 5],
    ['string-negative', '-5'], ['string-zero', '0'], ['string-positive', '5'],
    ['ascii-equals', '=1+1'], ['ascii-plus', '+1+1'], ['ascii-minus', '-1+1'], ['ascii-at', '@SUM(1,1)'],
    ['fullwidth-equals', '＝１＋１'], ['fullwidth-plus', '＋１＋１'],
    ['fullwidth-minus', '－１＋１'], ['fullwidth-at', '＠SUM(1,1)'],
    ['bom-prefix', '\uFEFF=1+1'], ['zero-width-prefix', '\u200B=1+1'],
    ['word-joiner-prefix', '\u2060=1+1'], ['space-prefix', '  =1+1'],
    ['plain-tab', '앞\t일반 글자'], ['boolean-true', true], ['boolean-false', false], ['empty-string', ''], ['null', null],
    ['leading-tab-formula', '\t=1+1'],
  ];
  const separators = [['semicolon', ';'], ['tab', '\t'], ['pipe', '|'], ['lf', '\n'], ['cr', '\r'], ['crlf', '\r\n']];
  const prefixes = [['none', ''], ['bom', '\uFEFF'], ['zero-width', '\u200B'], ['word-joiner', '\u2060']];
  for (const [separatorName, separator] of separators)
    for (const [prefixName, prefix] of prefixes)
      candidates.push([`alternate-${separatorName}-${prefixName}`, `앞${separator}${prefix}=1+1`]);
  candidates.push(['alternate-fullwidth', '앞；＝１＋１']);
  const cases = candidates.map(([id, value]) => {
    try {
      const result = app.csvText({ name: 'single-case', columns: ['값'], rows: [[value]] }, true);
      return { id, value, inputType: value === null ? 'null' : typeof value, csv: 'accepted', changed: result.changed };
    } catch (error) {
      return { id, value, inputType: value === null ? 'null' : typeof value, csv: 'rejected', message: error.message };
    }
  });
  assert(cases.some((item) => item.csv === 'rejected'), 'Blocked CSV matrix unexpectedly empty');
  const safeRows = cases.filter((item) => item.csv === 'accepted').map((item) => [item.id, item.value]);
  const book = (name, rows) => ({ title: name, generatedAt, metadata: { source: 'synthetic security verification', network: 'no URLs or external formula actions' }, tables: [{ name: 'cases', columns: ['사례', '값'], rows }] });
  const csvOutput = await app.serializeOutput(book('security-safe', safeRows), 'csv', 0, true);
  write('export-safe.csv', csvOutput[0].data, 'Actual app safe CSV serializer output, including harmless multiline text and protected formula-like strings', 'accepted; inspect typed source cases and actual prefix counts');
  write('safe-output.txt', csvOutput[0].data, 'Identical safe CSV bytes with .txt extension for the explicit Excel legacy text-import wizard', 'same SHA-256 as export-safe.csv; choose comma delimiter and text-preserving options');
  write('export-safe-info.json', csvOutput[1].data, 'Actual app CSV metadata and protection count', 'metadata');
  const flatRows = safeRows.filter(([, value]) => typeof value !== 'string' || !/[\r\n]/.test(value));
  const flatOutput = await app.serializeOutput(book('security-safe-flat', flatRows), 'csv', 0, true);
  const flatCsv = write('export-safe-flat.csv', flatOutput[0].data, 'Actual app safe CSV serializer output excluding only fields with CR or LF, for independent Excel formula/string/number controls', '24 data rows; all accepted prefix, fullwidth and numeric cases retained; no multiline field');
  await checked('flat safe CSV', 'accept', async () => {
    const parsed = await app.parseCsvFile(csvFile('export-safe-flat.csv', flatCsv), app.defaultImportOptions);
    assert(parsed.original.rows.length === flatRows.length, 'Flat safe CSV row count mismatch');
    return { ...summarizeImport(parsed), excludedIds: cases.filter((item) => item.csv === 'accepted' && typeof item.value === 'string' && /[\r\n]/.test(item.value)).map((item) => item.id) };
  });
  const typed = await app.serializeOutput(book('security-typed', cases.map((item) => [item.id, item.value])), 'xlsx', 0, true);
  const typedBytes = write('export-typed-full.xlsx', typed[0].data, 'Actual app XLSX serializer output for every accepted/rejected CSV case; numeric -5/0/5 are numbers', 'all user strings are string cells and no formula cells');
  const typedBook = XLSX.read(typedBytes, { type: 'buffer', cellDates: false });
  const typedSheet = typedBook.Sheets[typedBook.SheetNames[0]];
  const xlsxObservedCells = [];
  for (const [index, item] of cases.entries()) {
    const cell = typedSheet[`B${index + 2}`];
    assert(!cell?.f, `Unexpected XLSX formula in ${item.id}`);
    if (item.value === null) {
      xlsxObservedCells.push({ id: item.id, sourceValue: null, cellType: cell?.t ?? 'absent', value: cell?.v ?? null, formula: false });
      continue;
    }
    const type = typeof item.value === 'number' ? 'n' : typeof item.value === 'boolean' ? 'b' : 's';
    const exact = cell?.v === item.value;
    const crlfNormalized = typeof item.value === 'string' && item.value.includes('\r\n') && cell?.v === item.value.replaceAll('\r\n', '\n');
    assert(cell?.t === type && (exact || crlfNormalized), `XLSX value or type mismatch in ${item.id}`);
    xlsxObservedCells.push({ id: item.id, sourceValue: item.value, cellType: cell.t, value: cell.v, formula: false, exact, normalization: crlfNormalized ? 'SheetJS round-trip normalizes CRLF to LF' : null });
  }
  write('export-cases.json', JSON.stringify({ cases, accepted: cases.filter((item) => item.csv === 'accepted').length, rejected: cases.filter((item) => item.csv === 'rejected').length, xlsxStringsAreTyped: true, xlsxObservedCells }, null, 2), 'Actual app decisions for the CSV matrix and observed typed XLSX cells, including any exact CRLF-to-LF normalization', 'rejected cases record app errors and are included as typed strings in XLSX');
  write('blocked-input.csv', app.csvText({ name: 'intentional-source', columns: ['사례', '문자'], rows: cases.filter((item) => item.csv === 'rejected').map((item) => [item.id, item.value]) }, false).text,
    'Synthetic raw CSV input for local browser safe-export rejection tests; use the typed XLSX for opening in a spreadsheet program', 'import succeeds; safe CSV export rejects, then typed XLSX fallback preserves strings');

  const normalCsv = write('normal-input.csv', app.csvText({ name: 'normal', columns: ['코드', '메모', '점수'], rows: [['00123', '한글, "자료"\n두 줄', -5], ['00456', 'CR\r다음', 0], ['00999', 'CRLF\r\n다음', 5]] }, true).text, 'Quoted Korean CSV with BOM, comma, quotes, multiline cells and numeric -5/0/5', 'accepted, 3 rows and 3 columns');
  await checked('normal CSV', 'accept', async () => summarizeImport(await app.parseCsvFile(csvFile('normal-input.csv', normalCsv), app.defaultImportOptions)));
  const euckr = write('euckr-input.csv', Buffer.from([0xc0, 0xcc, 0xb8, 0xa7, 0x2c, 0xc1, 0xa1, 0xbc, 0xf6, 0x0a, 0xb0, 0xa1, 0x2c, 0x31, 0x0a, 0xb3, 0xaa, 0x2c, 0x32]),
    'Fixed EUC-KR bytes for 이름,점수 followed by 가,1 and 나,2', 'accept with explicit EUC-KR encoding');
  await checked('EUC-KR CSV', 'accept', async () => summarizeImport(await app.parseCsvFile(csvFile('euckr-input.csv', euckr), { ...app.defaultImportOptions, encoding: 'euc-kr' })));
  const boundaryPrefix = Buffer.from('\uFEFF메모,점수\r\n"');
  const boundary = write('boundary-input.csv', Buffer.concat([boundaryPrefix, Buffer.alloc(65535 - boundaryPrefix.length, 0x61), Buffer.from('가""검증\r\n끝",5\r\n')]), 'A Korean UTF-8 character begins at byte offset 65535, crossing the app 64KiB reader boundary inside a quoted field', 'accepted; one row, embedded quote and CRLF preserved');
  await checked('64KiB CSV boundary', 'accept', async () => summarizeImport(await app.parseCsvFile(csvFile('boundary-input.csv', boundary), app.defaultImportOptions)));
  const overRows = write('csv-overrows.csv', '점수\r\n' + '1\r\n'.repeat(app.limits.rows + 1), 'Intentional 50,001-row input', 'reject row limit');
  await checked('over-row CSV', 'reject', () => app.parseCsvFile(csvFile('csv-overrows.csv', overRows), app.defaultImportOptions), /50,000행/);
  const longField = write('csv-long-field.csv', '설명\r\n"' + 'x'.repeat(app.csvReadLimits.fieldUnits + 1) + '"', 'Intentional field with 65,537 UTF-16 units', 'reject field limit');
  await checked('long-field CSV', 'reject', () => app.parseCsvFile(csvFile('csv-long-field.csv', longField), app.defaultImportOptions), /65,536/);
  const cancelRows = 49999;
  const cancelCsv = write('cancel-input.csv', ['식별자,' + Array.from({ length: 9 }, (_, i) => `값${i + 1}`).join(','), ...Array.from({ length: cancelRows }, (_, i) => [String(i).padStart(6, '0'), ...Array.from({ length: 9 }, (_, j) => i + j)].join(','))].join('\r\n'), '499,990 data cells plus 10 header cells; valid input for observing real Worker cancellation', 'accepted; cancellation timing and existing project preservation require browser verification');
  await checked('valid cancellation CSV', 'accept', async () => summarizeImport(await app.parseCsvFile(csvFile('cancel-input.csv', cancelCsv), app.defaultImportOptions)));

  const ordinaryXlsx = write('normal-workbook.xlsx', importWorkbook(), 'Ordinary generated workbook with dates, display codes, booleans, Korean text and an empty sheet', 'list all sheets; choose 정상 or 빈 시트');
  const selectedXlsx = withOverrangeSheet(ordinaryXlsx, 3);
  write('xlsx-overrange.xlsx', selectedXlsx, 'Valid generated workbook with a deliberately oversized third-sheet dimension', 'metadata accepted; choose 큰 범위 to receive a range-limit error');
  const corruptXlsx = write('selective.xlsx', corruptSheetCrc(selectedXlsx, 2), 'Normal first sheet, deliberately wrong CRC in second, deliberately overrange dimension in third', 'metadata and 정상 accepted; 손상 and 큰 범위 rejected individually');
  await checked('selective XLSX metadata', 'accept', () => app.readXlsxSheetNames(arrayBuffer(corruptXlsx)));
  await checked('normal selected XLSX with corrupt unselected part', 'accept', async () => {
    const parsed = await app.parseXlsxBytes(arrayBuffer(corruptXlsx), 'selective.xlsx', { ...app.defaultImportOptions, sheet: '정상' });
    const ids = parsed.original.columns.map((column) => column.id);
    assert(parsed.original.rows[0].values[ids[0]] === 123 && parsed.proposed.rows[0].values[ids[0]] === '00123', 'XLSX display code mismatch');
    assert(parsed.original.rows[0].values[ids[1]] === 45292 && parsed.proposed.rows[0].values[ids[1]] === '2024-01-01', 'XLSX date mismatch');
    return summarizeImport(parsed);
  });
  await checked('empty selected XLSX', 'accept', async () => {
    const parsed = await app.parseXlsxBytes(arrayBuffer(corruptXlsx), 'selective.xlsx', { ...app.defaultImportOptions, sheet: '빈 시트' });
    assert(parsed.empty, 'Empty sheet was not marked empty');
    return summarizeImport(parsed);
  });
  await checked('selected corrupt XLSX CRC', 'reject', () => app.parseXlsxBytes(arrayBuffer(corruptXlsx), 'selective.xlsx', { ...app.defaultImportOptions, sheet: '손상' }), /ZIP 구조/);
  await checked('selected overrange XLSX', 'reject', () => app.parseXlsxBytes(arrayBuffer(corruptXlsx), 'selective.xlsx', { ...app.defaultImportOptions, sheet: '큰 범위' }), /한도/);

  const state = app.createWorkspace();
  state.project.name = '[가상 보안 검증] 정상 백업';
  const normalBackup = app.makeBackup(state);
  const normalJson = write('normal-backup.json', JSON.stringify(normalBackup), 'Normal backup produced by the actual current helper', 'restore as a separate project');
  await checked('normal backup', 'accept', () => ({ schema: app.readBackup(normalJson.toString()).project.schemaVersion }));
  const legacy = structuredClone(normalBackup);
  legacy.workspace.project.schemaVersion = 1;
  delete legacy.workspace.project.activeVersions;
  delete legacy.workspace.project.history;
  const legacyJson = write('legacy-backup.json', JSON.stringify(legacy), 'Synthetic schema-1 workspace with absent activeVersions and undo history', 'migrates to current schema without changing source data');
  await checked('schema-1 backup', 'accept', () => ({ schema: app.readBackup(legacyJson.toString()).project.schemaVersion }));

  const parsed = app.parseBytes(new TextEncoder().encode('측정값\n' + Array.from({ length: 4000 }, (_, i) => `${i}.5`).join('\n')).buffer, 'histogram-source.csv', app.defaultImportOptions);
  const dataset = app.registerImport(parsed, parsed.proposed.columns, true);
  const histogramState = app.workspaceReducer(app.createWorkspace(false), { type: 'import', dataset });
  histogramState.project.name = '[가상 보안 검증] 반복 히스토그램';
  const { version } = app.getSelection(histogramState);
  const graph = app.newGraph(version, histogramState.project.selection);
  graph.kind = 'histogram';
  graph.visual.x = version.columns[0].id;
  graph.visual.binCount = 100;
  graph.visual.boundaries = app.calculateGraph(version, graph).boundaries;
  for (const count of [30, 48]) {
    const copy = structuredClone(histogramState);
    copy.project.graphs = Array.from({ length: count }, (_, index) => ({ ...structuredClone(graph), id: `histogram-${index}` }));
    const data = write(`graphs-${count}.json`, JSON.stringify(app.makeBackup(copy)), `4,000 rows and ${count} repeated 100-bin histograms`, count === 30 ? 'accepted within cumulative restore work budget' : 'reject cumulative histogram restore work before all graphs are replayed');
    await checked(`${count} repeated histogram backup`, count === 30 ? 'accept' : 'reject', () => ({ graphs: app.readBackup(data.toString(), true).project.graphs.length }), /누적 복원 검증.*히스토그램/);
  }
  const depth = app.backupJsonLimits.depth + 1;
  const deep = write('deep-backup.json', '{"extra":' + '['.repeat(depth) + '0' + ']'.repeat(depth) + '}', 'Intentional deeply nested JSON, outside the supported workspace envelope', 'reject depth before JSON.parse');
  await checked('deep JSON', 'reject', () => app.readBackup(deep.toString()), /중첩 깊이/);
  const invalidUtf8 = Buffer.from(normalJson);
  invalidUtf8[0] = 0xff;
  write('bad-utf8.json', invalidUtf8, 'Intentional invalid UTF-8 byte in an otherwise generated normal backup', 'reject decoding before parse or restore');
  await checked('invalid UTF-8 backup', 'reject', () => app.readBackupBytes(arrayBuffer(invalidUtf8)), /UTF-8/);

  const finalSource = sourceSnapshot();
  assert(finalSource.sha256 === source.sha256, 'Source changed during generation; keep this directory as incomplete evidence and generate again after code freeze');
  const manifest = {
    format: 'data-garden-security-fixtures', version: 1, generatedAt,
    sourceCommit: git(['rev-parse', 'HEAD']).trim(), sourceHash: source.sha256, sourceTree: source,
    syntheticOnly: true, generationCommand: 'node scripts/security-fixtures.mjs --generate',
    codeLoading: 'Actual current app helpers bundled in memory with esbuild write:false',
    selfHashExcluded: 'manifest.json is excluded from its own per-file hashes to avoid a circular digest',
    files, checks,
  };
  writeFileSync(resolve(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ directory, generatedAt, sourceTreeSha256: source.sha256, files: files.length, checks: checks.length, acceptedCsvCases: cases.filter((item) => item.csv === 'accepted').length, rejectedCsvCases: cases.filter((item) => item.csv === 'rejected').length, manifest: resolve(directory, 'manifest.json') }, null, 2));
}

function check(directoryArg) {
  const directory = isAbsolute(directoryArg) ? resolve(directoryArg) : resolve(projectRoot, directoryArg);
  assertAuditPath(directory);
  const manifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8'));
  assert(manifest.format === 'data-garden-security-fixtures' && manifest.version === 1, 'Unknown audit manifest');
  for (const file of manifest.files) {
    assert(basename(file.name) === file.name, 'Invalid manifest filename');
    const path = resolve(directory, file.name);
    assert(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), `Payload is not an ordinary file: ${file.name}`);
    const data = readFileSync(path);
    assert(data.length === file.bytes && sha256(data) === file.sha256, `Payload hash differs: ${file.name}`);
  }
  assert(sourceSnapshot().sha256 === manifest.sourceTree.sha256, 'Current working source differs from the generation snapshot');
  console.log(JSON.stringify({ directory, matchingPayloads: manifest.files.length, sourceTreeMatches: true, generatedAt: manifest.generatedAt }, null, 2));
}

const args = process.argv.slice(2);
try {
  if (args.length === 1 && args[0] === '--generate') await generate();
  else if (args.length === 2 && args[0] === '--check') check(args[1]);
  else if (!args.length || args.length === 1 && ['--help', '-h'].includes(args[0]))
    console.log('Usage:\n  node scripts/security-fixtures.mjs --generate\n  node scripts/security-fixtures.mjs --check <tmp/security-audit-directory>\n\nGenerate only after code freeze. Every run uses a new ignored tmp directory and records actual app decisions and source/payload hashes.');
  else throw new Error('Use --help, --generate, or --check <audit-directory>');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
