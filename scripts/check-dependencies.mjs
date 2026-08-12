#!/usr/bin/env node

import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRootDir = resolve(scriptDir, '..');

export const DEFAULT_NODE_LAYERS = Object.freeze([
  { name: 'paths', files: ['src/paths.ts'] },
  {
    name: 'primitives',
    files: [
      'src/transport.ts',
      'src/browser-port.ts',
      'src/url-scope.ts',
      'src/keys.ts',
      'src/target-arg.ts',
      'src/tab-diff.ts',
      'src/click-events.ts',
      'src/run-script.ts',
    ],
  },
  {
    name: 'loaders/config/storage',
    files: ['src/inject-loader.ts', 'src/browser-discover.ts', 'src/browser-config.ts', 'src/rules-store.ts'],
  },
  {
    name: 'services',
    files: ['src/monitor.ts', 'src/browser.ts', 'src/folds.ts', 'src/ignore-links.ts', 'src/recipe-runner.ts'],
  },
  { name: 'api', files: ['src/api.ts'] },
  { name: 'cli', files: ['src/cdp.ts'] },
]);

function normalizeRelativePath(value) {
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

function isWithin(parent, child) {
  const pathFromParent = relative(parent, child);
  return (
    pathFromParent === '' ||
    (!isAbsolute(pathFromParent) && pathFromParent !== '..' && !pathFromParent.startsWith(`..${sep}`))
  );
}

function formatDiagnostic(diagnostic) {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
}

function readProject(rootDir, tsconfigPath) {
  const config = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (config.error) throw new Error(`无法读取 ${tsconfigPath}: ${formatDiagnostic(config.error)}`);

  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(tsconfigPath), undefined, tsconfigPath);
  if (parsed.errors.length > 0) {
    throw new Error(`无法解析 ${tsconfigPath}:\n${parsed.errors.map(formatDiagnostic).join('\n')}`);
  }

  const sourceRoot = resolve(rootDir, 'src');
  const files = parsed.fileNames
    .map(fileName => resolve(fileName))
    .filter(fileName => isWithin(sourceRoot, fileName))
    .sort((left, right) => left.localeCompare(right));
  return { compilerOptions: parsed.options, files, sourceRoot };
}

function moduleReference(sourceFile, node, specifier, kind) {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return {
    column: position.character + 1,
    kind,
    line: position.line + 1,
    node,
    specifier,
  };
}

export function collectModuleReferences(sourceFile) {
  const references = [];

  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      references.push(moduleReference(sourceFile, node.moduleSpecifier, node.moduleSpecifier.text, 'static'));
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      const expression = node.moduleReference.expression;
      references.push(moduleReference(sourceFile, expression, expression.text, 'import-equals'));
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      const literal = node.argument.literal;
      references.push(moduleReference(sourceFile, literal, literal.text, 'import-type'));
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      const argument = node.arguments[0];
      const kind = node.expression.kind === ts.SyntaxKind.ImportKeyword ? 'dynamic-import' : 'require';
      if (argument && ts.isStringLiteralLike(argument)) {
        references.push(moduleReference(sourceFile, argument, argument.text, kind));
      } else {
        references.push(moduleReference(sourceFile, node, null, kind));
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return references;
}

function addError(errors, code, message, file = null, line = null, column = null) {
  errors.push({ code, column, file, line, message });
}

function buildLayerMap(layers, nodeFiles, errors) {
  const layerByFile = new Map();
  const nodeFileSet = new Set(nodeFiles);

  for (const [rank, layer] of layers.entries()) {
    for (const configuredFile of layer.files) {
      const file = normalizeRelativePath(configuredFile);
      if (layerByFile.has(file)) {
        addError(errors, 'duplicate-layer-module', `${file} 同时出现在多个依赖层`);
        continue;
      }
      layerByFile.set(file, { name: layer.name, rank });
      if (!nodeFileSet.has(file)) {
        addError(errors, 'stale-layer-module', `层 ${layer.name} 声明了不存在或不属于 Node 侧的模块 ${file}`);
      }
    }
  }

  for (const file of nodeFiles) {
    if (!layerByFile.has(file)) {
      addError(errors, 'unassigned-node-module', `${file} 未声明依赖层；新增 Node 模块必须显式归层`, file, 1, 1);
    }
  }
  return layerByFile;
}

function detectCycles(adjacency, edgeLocations, errors) {
  const states = new Map();
  const stack = [];
  const reported = new Set();

  function visit(file) {
    states.set(file, 'active');
    stack.push(file);
    const targets = [...(adjacency.get(file) ?? [])].sort((left, right) => left.localeCompare(right));
    for (const target of targets) {
      const state = states.get(target);
      if (state === undefined) {
        visit(target);
      } else if (state === 'active') {
        const start = stack.lastIndexOf(target);
        const cycle = [...stack.slice(start), target];
        const key = [...new Set(cycle)].sort((left, right) => left.localeCompare(right)).join('\0');
        if (reported.has(key)) continue;
        reported.add(key);
        const location = edgeLocations.get(`${file}\0${target}`);
        addError(
          errors,
          'dependency-cycle',
          `Node 侧依赖必须无环: ${cycle.join(' -> ')}`,
          file,
          location?.line ?? 1,
          location?.column ?? 1,
        );
      }
    }
    stack.pop();
    states.set(file, 'done');
  }

  for (const file of [...adjacency.keys()].sort((left, right) => left.localeCompare(right))) {
    if (states.get(file) === undefined) visit(file);
  }
}

/**
 * 检查 src/inject 与 Node 侧依赖方向。返回结构化诊断，调用者决定展示或退出。
 *
 * @param {{ rootDir?: string, tsconfigPath?: string, layers?: readonly { name: string, files: readonly string[] }[] }} options
 */
export function checkDependencyBoundaries(options = {}) {
  const rootDir = resolve(options.rootDir ?? defaultRootDir);
  const tsconfigPath = resolve(rootDir, options.tsconfigPath ?? 'tsconfig.json');
  const layers = options.layers ?? DEFAULT_NODE_LAYERS;
  const { compilerOptions, files, sourceRoot } = readProject(rootDir, tsconfigPath);
  const injectRoot = resolve(sourceRoot, 'inject');
  const errors = [];
  const edges = [];
  const relativeByAbsolute = new Map(
    files.map(fileName => [fileName, normalizeRelativePath(relative(rootDir, fileName))]),
  );
  const nodeFiles = [...relativeByAbsolute.entries()]
    .filter(([fileName]) => !isWithin(injectRoot, fileName))
    .map(([, relativeName]) => relativeName)
    .sort((left, right) => left.localeCompare(right));
  const layerByFile = buildLayerMap(layers, nodeFiles, errors);
  const canonicalFileName = fileName =>
    ts.sys.useCaseSensitiveFileNames ? resolve(fileName) : resolve(fileName).toLocaleLowerCase('en-US');
  const moduleResolutionCache = ts.createModuleResolutionCache(rootDir, canonicalFileName, compilerOptions);
  const adjacency = new Map(nodeFiles.map(file => [file, new Set()]));
  const edgeLocations = new Map();

  for (const fileName of files) {
    const source = ts.sys.readFile(fileName);
    const sourceRelative = relativeByAbsolute.get(fileName);
    if (source === undefined || sourceRelative === undefined) continue;
    const sourceFile = ts.createSourceFile(
      fileName,
      source,
      compilerOptions.target ?? ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const injectSource = isWithin(injectRoot, fileName);

    for (const reference of collectModuleReferences(sourceFile)) {
      edges.push({
        column: reference.column,
        file: sourceRelative,
        kind: reference.kind,
        line: reference.line,
        specifier: reference.specifier,
        target: null,
      });

      if (reference.specifier === null) {
        if (injectSource) {
          addError(
            errors,
            'inject-computed-import',
            `inject 侧不允许无法静态解析的 ${reference.kind}`,
            sourceRelative,
            reference.line,
            reference.column,
          );
        }
        continue;
      }

      const specifier = reference.specifier;
      if (injectSource && !specifier.startsWith('.')) {
        addError(
          errors,
          'inject-external-import',
          `inject 侧只能导入 src/inject 内部模块，禁止 bare/Node import: ${specifier}`,
          sourceRelative,
          reference.line,
          reference.column,
        );
        continue;
      }

      const resolution = ts.resolveModuleName(
        specifier,
        fileName,
        compilerOptions,
        ts.sys,
        moduleResolutionCache,
      ).resolvedModule;
      if (!resolution) {
        if (specifier.startsWith('.')) {
          addError(
            errors,
            'unresolved-relative-import',
            `无法解析相对导入 ${specifier}`,
            sourceRelative,
            reference.line,
            reference.column,
          );
        }
        continue;
      }

      const targetFile = resolve(resolution.resolvedFileName);
      const targetRelative = normalizeRelativePath(relative(rootDir, targetFile));
      edges.at(-1).target = targetRelative;

      if (injectSource) {
        if (!isWithin(injectRoot, targetFile)) {
          addError(
            errors,
            'inject-outside-import',
            `inject 侧禁止导入 Node 侧: ${specifier} -> ${targetRelative}`,
            sourceRelative,
            reference.line,
            reference.column,
          );
        }
        continue;
      }

      if (!isWithin(sourceRoot, targetFile)) continue;
      if (isWithin(injectRoot, targetFile)) {
        addError(
          errors,
          'node-imports-inject',
          `Node 侧禁止直接导入浏览器注入源码: ${sourceRelative} -> ${targetRelative}`,
          sourceRelative,
          reference.line,
          reference.column,
        );
        continue;
      }

      adjacency.get(sourceRelative)?.add(targetRelative);
      const locationKey = `${sourceRelative}\0${targetRelative}`;
      if (!edgeLocations.has(locationKey)) {
        edgeLocations.set(locationKey, { column: reference.column, line: reference.line });
      }

      if (sourceRelative === 'src/paths.ts') {
        addError(
          errors,
          'paths-project-import',
          `src/paths.ts 是最底层，不得导入项目模块 ${targetRelative}`,
          sourceRelative,
          reference.line,
          reference.column,
        );
      }

      const sourceLayer = layerByFile.get(sourceRelative);
      const targetLayer = layerByFile.get(targetRelative);
      if (sourceLayer && targetLayer && targetLayer.rank > sourceLayer.rank) {
        addError(
          errors,
          'reverse-dependency',
          `依赖方向反转: ${sourceRelative} (${sourceLayer.name}) -> ${targetRelative} (${targetLayer.name})`,
          sourceRelative,
          reference.line,
          reference.column,
        );
      }
    }
  }

  detectCycles(adjacency, edgeLocations, errors);
  errors.sort((left, right) => {
    const fileOrder = (left.file ?? '').localeCompare(right.file ?? '');
    if (fileOrder !== 0) return fileOrder;
    const lineOrder = (left.line ?? 0) - (right.line ?? 0);
    if (lineOrder !== 0) return lineOrder;
    return (left.column ?? 0) - (right.column ?? 0);
  });
  return { edges, errors };
}

export function formatBoundaryError(error) {
  const location = error.file ? `${error.file}:${error.line ?? 1}:${error.column ?? 1}` : 'dependency-layers';
  return `${location} dependency-boundary/${error.code}: ${error.message}`;
}

function runCli() {
  try {
    const result = checkDependencyBoundaries();
    if (result.errors.length > 0) {
      for (const error of result.errors) console.error(formatBoundaryError(error));
      console.error(`依赖边界检查失败: ${result.errors.length} 个错误`);
      process.exitCode = 1;
      return;
    }
    console.log(`依赖边界检查通过: ${result.edges.length} 条 import 边`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) runCli();
