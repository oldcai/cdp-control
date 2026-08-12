#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRootDir = resolve(scriptDir, '..');
const LONG_FLAG_PATTERN = /--[a-z][a-z0-9]*(?:-[a-z0-9*]+)*/g;

function flagTokens(source) {
  return [...source.matchAll(LONG_FLAG_PATTERN)]
    .map(match => ({ flag: match[0], index: match.index ?? 0 }))
    .filter(token => !token.flag.includes('*'));
}

function optionTakesValue(option) {
  return option.required === true || option.optional === true;
}

/** Read Commander's registered model directly; no command/flag allow-list lives here. */
export function commanderContract(rootCommand) {
  const commands = [];

  function visit(command, parentNames) {
    for (const child of command.commands) {
      const names = [...parentNames, child.name()];
      commands.push({
        aliases: child.aliases().map(alias => [...parentNames, alias].join(' ')),
        flags: child.options
          .filter(option => typeof option.long === 'string')
          .map(option => ({ name: option.long, takesValue: optionTakesValue(option) })),
        name: names.join(' '),
      });
      visit(child, names);
    }
  }

  visit(rootCommand, []);
  return { commands };
}

function isolatedContractEnvironment(baseEnvironment, workspace) {
  const home = join(workspace, 'home');
  const cdpHome = join(workspace, 'cdp-home');
  return {
    ...baseEnvironment,
    CDP_FOLD_FILE: join(cdpHome, 'rules', 'fold.csv'),
    CDP_HOME: cdpHome,
    CDP_HOST: '127.0.0.1',
    CDP_IGNORE_LINKS_FILE: join(cdpHome, 'rules', 'ignore-links.csv'),
    CDP_LOGS_PORT: String(52000 + (process.pid % 10000)),
    CDP_NO_AUTOSTART: '1',
    CDP_PORT: String(40000 + (process.pid % 10000)),
    CDP_RULES_DEFAULT_DIR: join(workspace, 'default-rules'),
    CDP_RULES_DIR: join(cdpHome, 'rules'),
    HOME: home,
    USERPROFILE: home,
  };
}

/** Bundle the current source, externalising Commander so an inspector can observe its shared program singleton. */
export function extractCommanderContract({ rootDir = defaultRootDir } = {}) {
  const tmpRoot = join(rootDir, 'tmp');
  mkdirSync(tmpRoot, { recursive: true });
  const workspace = mkdtempSync(join(tmpRoot, 'docs-check-'));
  const bundlePath = join(workspace, 'cdp-contract.cjs');
  const contractPath = join(workspace, 'contract.json');

  try {
    const manifest = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
    if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
      throw new Error('package.json 缺少 version');
    }
    buildSync({
      absWorkingDir: rootDir,
      bundle: true,
      define: { __CDP_VERSION__: JSON.stringify(manifest.version) },
      entryPoints: [join(rootDir, 'src', 'cdp.ts')],
      external: ['commander'],
      format: 'cjs',
      logLevel: 'silent',
      outfile: bundlePath,
      platform: 'node',
      target: 'node22',
    });

    const inspector = [
      "const { writeFileSync } = require('node:fs');",
      "const { program } = require('commander');",
      'require(process.argv[1]);',
      'const commands = [];',
      'function visit(command, parents) {',
      '  for (const child of command.commands) {',
      '    const names = parents.concat(child.name());',
      '    commands.push({',
      "      aliases: child.aliases().map(alias => parents.concat(alias).join(' ')),",
      "      flags: child.options.filter(option => typeof option.long === 'string').map(option => ({",
      '        name: option.long,',
      '        takesValue: option.required === true || option.optional === true,',
      '      })),',
      "      name: names.join(' '),",
      '    });',
      '    visit(child, names);',
      '  }',
      '}',
      'visit(program, []);',
      'writeFileSync(process.argv[2], JSON.stringify({ commands }));',
    ].join('\n');
    const inspected = spawnSync(process.execPath, ['-e', inspector, bundlePath, contractPath], {
      cwd: rootDir,
      encoding: 'utf8',
      env: isolatedContractEnvironment(process.env, workspace),
      shell: false,
    });
    if (inspected.status !== 0) {
      throw new Error(
        `无法提取 Commander 注册项 (exit ${inspected.status ?? 'null'})\nstdout:\n${inspected.stdout}\nstderr:\n${inspected.stderr}`,
      );
    }
    const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
    if (!Array.isArray(contract.commands) || contract.commands.length === 0) {
      throw new Error('Commander 合同未提取到任何子命令');
    }
    return contract;
  } finally {
    rmSync(workspace, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
}

function splitTableRow(line) {
  if (!line.trimStart().startsWith('|')) return [];
  return line
    .trim()
    .slice(1, line.trim().endsWith('|') ? -1 : undefined)
    .split('|')
    .map(cell => cell.trim());
}

function inlineCode(source) {
  return [...source.matchAll(/`([^`\n]+)`/g)].map(match => match[1]);
}

function valueShapeAfterFlag(signature, token, positionalNames = new Set()) {
  const rest = signature.slice(token.index + token.flag.length).trimStart();
  const before = signature.slice(0, token.index);
  const optionGroupStart = before.lastIndexOf('[');
  if (optionGroupStart >= 0 && before.lastIndexOf(']') < optionGroupStart) {
    const optionGroupEnd = rest.indexOf(']');
    if (optionGroupEnd >= 0) return rest.slice(0, optionGroupEnd).trim().length > 0;
  }
  if (rest.startsWith('=')) return true;
  const requiredPlaceholder = rest.match(/^<([^>]+)>/);
  if (requiredPlaceholder) {
    // `click --dom <target>` puts a boolean before the command's documented positional;
    // do not mistake that positional placeholder for the option's own value.
    if (positionalNames.has(requiredPlaceholder[1])) return null;
    return true;
  }
  if (/^\[[a-zA-Z\u4e00-\u9fff]/.test(rest)) return true;
  if (rest === '' || /^[\]/),.;:，。]/.test(rest) || rest.startsWith('--') || rest.startsWith('...')) return false;
  // A literal after an ungrouped option may instead be the command's positional argument
  // (for example `click --dom 44`), so existence is checkable but value shape is ambiguous.
  return null;
}

function signatureClaims(signature, line, source = signature, positionalNames = new Set()) {
  const normalized = signature.trim().replace(/^\$\s*/, '');
  const withoutBinary = normalized.replace(/^(?:cdp-control|cdp)\s+/, '');
  const commandMatch = withoutBinary.match(/^([a-z][a-z0-9-]*)(?=$|\s)/);
  if (!commandMatch) return [];
  const command = commandMatch[1];
  const claims = [{ command, kind: 'command', line, source }];
  for (const token of flagTokens(withoutBinary)) {
    claims.push({
      command,
      flag: token.flag,
      kind: 'flag',
      line,
      source,
      takesValue: valueShapeAfterFlag(withoutBinary, token, positionalNames),
    });
  }
  return claims;
}

function declaredPositionals(signature) {
  const normalized = signature
    .trim()
    .replace(/^\$\s*/, '')
    .replace(/^(?:cdp-control|cdp)\s+/, '');
  const beforeFirstFlag = normalized.split(/\s+--/, 1)[0];
  return new Set([...beforeFirstFlag.matchAll(/<([^>]+)>/g)].map(match => match[1]));
}

function collectQuickReferencePositionals(lines) {
  const positionals = new Map();
  let inQuickReference = false;
  let fence = null;
  for (const line of lines) {
    const fenceMatch = line.match(/^\s*(```+|~~~+)\s*([^\s]*)/);
    if (fenceMatch) {
      fence = fence ? null : { marker: fenceMatch[1] };
      continue;
    }
    if (fence) continue;
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading && heading[1].length <= 2) inQuickReference = heading[2] === 'Quick Reference';
    if (!inQuickReference) continue;
    const cells = splitTableRow(line);
    if (cells.length === 0 || cells[0] === '子命令' || /^[-:]+$/.test(cells[0])) continue;
    for (const code of inlineCode(cells[0])) {
      const command = code.trim().match(/^([a-z][a-z0-9-]*)(?=$|\s)/)?.[1];
      if (!command) continue;
      const known = positionals.get(command) ?? new Set();
      for (const positional of declaredPositionals(code)) known.add(positional);
      if (known.size > 0) positionals.set(command, known);
    }
  }
  return positionals;
}

function addClaim(claims, seen, claim) {
  const key = [claim.kind, claim.command ?? '', claim.flag ?? '', String(claim.takesValue), claim.line].join('|');
  if (seen.has(key)) return;
  seen.add(key);
  claims.push(claim);
}

function headingCommand(heading) {
  return heading.match(/\(([a-z][a-z0-9-]*)\)\s*$/)?.[1] ?? null;
}

function headingCommandGroup(heading) {
  const parenthetical = heading.match(/\(([^()]*)\)/)?.[1];
  if (!parenthetical?.includes('/')) return [];
  return parenthetical
    .split('/')
    .map(part => part.trim().match(/^([a-z][a-z0-9-]*)/)?.[1] ?? null)
    .filter(command => command !== null);
}

function sharedFlagTableClaims(cells, line, source) {
  if (cells.length < 2 || cells[0] === '共用参数' || /^[-:]+$/.test(cells[0])) return [];
  const flagSignatures = inlineCode(cells[0]).filter(code => code.trim().startsWith('--'));
  if (flagSignatures.length === 0) return [];
  const commands = inlineCode(cells[1]).filter(code => /^[a-z][a-z0-9-]*$/.test(code.trim()));
  const claims = [];
  for (const command of commands) {
    for (const flagSignature of flagSignatures) {
      claims.push(...signatureClaims(`${command.trim()} ${flagSignature.trim()}`, line, source));
    }
  }
  return claims;
}

/**
 * Structured scope: Quick Reference command/shared-option cells, command parameter tables,
 * shared-option headings, shell fences, command-shaped inline code, and every exact long-flag
 * mention outside non-shell fences.
 */
export function extractSkillClaims(markdown) {
  const lines = markdown.split(/\r?\n/);
  const claims = [];
  const seen = new Set();
  const quickCommands = new Set();
  // Pre-scan so shell/inline examples are order-independent from Quick Reference.
  const quickPositionals = collectQuickReferencePositionals(lines);
  const inlineRecords = [];
  let h2 = '';
  let nearestHeading = '';
  let fence = null;

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const fenceMatch = line.match(/^\s*(```+|~~~+)\s*([^\s]*)/);
    if (fenceMatch) {
      if (fence) fence = null;
      else fence = { language: fenceMatch[2].toLowerCase(), marker: fenceMatch[1] };
      continue;
    }
    if (fence) {
      if (['bash', 'sh', 'shell', 'console'].includes(fence.language)) {
        const explicit = line.trim().replace(/^\$\s*/, '');
        if (/^(?:cdp-control|cdp)\s+/.test(explicit)) {
          const call = explicit.replace(/^(?:cdp-control|cdp)\s+/, '');
          if (!/^[<[\[]/.test(call)) {
            const command = call.match(/^([a-z][a-z0-9-]*)(?=$|\s)/)?.[1];
            for (const claim of signatureClaims(call, lineNumber, line.trim(), quickPositionals.get(command))) {
              addClaim(claims, seen, claim);
            }
          }
        }
      }
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      nearestHeading = heading[2];
      if (heading[1].length <= 2) h2 = heading[2];
    }

    const cells = splitTableRow(line);
    for (const claim of sharedFlagTableClaims(cells, lineNumber, line.trim())) addClaim(claims, seen, claim);
    if (h2 === 'Quick Reference' && cells.length > 0 && cells[0] !== '子命令' && !/^[-:]+$/.test(cells[0])) {
      const rowCommands = new Set();
      for (const code of inlineCode(cells[0])) {
        const command = code.trim().match(/^([a-z][a-z0-9-]*)(?=$|\s)/)?.[1];
        const rowClaims = signatureClaims(
          code,
          lineNumber,
          line.trim(),
          command ? quickPositionals.get(command) : undefined,
        );
        for (const claim of rowClaims) {
          addClaim(claims, seen, claim);
          if (claim.kind === 'command') {
            quickCommands.add(claim.command);
            rowCommands.add(claim.command);
          }
        }
      }
      if (rowCommands.size === 1) {
        const [command] = rowCommands;
        for (const token of flagTokens(line)) {
          addClaim(claims, seen, {
            command,
            flag: token.flag,
            kind: 'flag',
            line: lineNumber,
            source: line.trim(),
            takesValue: null,
          });
        }
      }
    }

    const parameterCommand = headingCommand(nearestHeading);
    if (parameterCommand && cells.length > 0 && cells[0] !== '参数' && !/^[-:]+$/.test(cells[0])) {
      for (const code of inlineCode(cells[0])) {
        if (!code.trim().startsWith('--')) continue;
        for (const claim of signatureClaims(`${parameterCommand} ${code}`, lineNumber, line.trim())) {
          addClaim(claims, seen, claim);
        }
      }
      for (const token of flagTokens(line)) {
        addClaim(claims, seen, {
          command: parameterCommand,
          flag: token.flag,
          kind: 'flag',
          line: lineNumber,
          source: line.trim(),
          takesValue: null,
        });
      }
    }

    const sharedHeadingCommands = headingCommandGroup(h2);
    if (sharedHeadingCommands.length > 0 && /^\s*-\s+`--/.test(line)) {
      for (const code of inlineCode(line).filter(value => value.trim().startsWith('--'))) {
        for (const command of sharedHeadingCommands) {
          for (const claim of signatureClaims(`${command} ${code}`, lineNumber, line.trim())) {
            addClaim(claims, seen, claim);
          }
        }
      }
    }

    const codes = inlineCode(line);
    inlineRecords.push({ codes, line: lineNumber, source: line.trim() });
    const lineWithoutInlineCode = line.replace(/`[^`\n]+`/g, '');
    for (const token of flagTokens(lineWithoutInlineCode)) {
      addClaim(claims, seen, {
        command: null,
        flag: token.flag,
        kind: 'flag',
        line: lineNumber,
        source: line.trim(),
        takesValue: null,
      });
    }
  }

  for (const record of inlineRecords) {
    for (const code of record.codes) {
      const normalized = code.trim().replace(/^\$\s*/, '');
      if (/^(?:cdp-control|cdp)\s+/.test(normalized)) {
        const call = normalized.replace(/^(?:cdp-control|cdp)\s+/, '');
        if (!/^[<[\[]/.test(call)) {
          const command = call.match(/^([a-z][a-z0-9-]*)(?=$|\s)/)?.[1];
          for (const claim of signatureClaims(call, record.line, record.source, quickPositionals.get(command))) {
            addClaim(claims, seen, claim);
          }
        }
        continue;
      }
      const command = normalized.match(/^([a-z][a-z0-9-]*)(?=$|\s)/)?.[1];
      if (!command) {
        if (normalized.startsWith('--')) {
          for (const token of flagTokens(normalized)) {
            const shape = valueShapeAfterFlag(normalized, token);
            addClaim(claims, seen, {
              command: null,
              flag: token.flag,
              kind: 'flag',
              line: record.line,
              source: record.source,
              takesValue: shape === true ? true : null,
            });
          }
        }
        continue;
      }
      const rest = normalized.slice(command.length).trimStart();
      const stronglyCommandShaped = /^(?:\[?(?:<|--))/.test(rest);
      if (quickCommands.has(command) || stronglyCommandShaped) {
        for (const claim of signatureClaims(normalized, record.line, record.source, quickPositionals.get(command))) {
          addClaim(claims, seen, claim);
        }
        continue;
      }
    }
  }

  const contextualFlags = new Set(
    claims.filter(claim => claim.kind === 'flag' && claim.command !== null).map(claim => `${claim.line}|${claim.flag}`),
  );
  return claims
    .filter(
      claim => claim.kind !== 'flag' || claim.command !== null || !contextualFlags.has(`${claim.line}|${claim.flag}`),
    )
    .sort((left, right) => left.line - right.line);
}

function contractMaps(contract) {
  const commands = new Map();
  for (const command of contract.commands) {
    const flags = new Map(command.flags.map(flag => [flag.name, flag.takesValue]));
    commands.set(command.name, flags);
    for (const alias of command.aliases ?? []) commands.set(alias, flags);
  }
  return commands;
}

export function validateSkillClaims(contract, claims) {
  const commands = contractMaps(contract);
  const allFlags = new Map();
  for (const flags of commands.values()) {
    for (const [flag, takesValue] of flags) {
      if (!allFlags.has(flag)) allFlags.set(flag, new Set());
      allFlags.get(flag).add(takesValue);
    }
  }
  const errors = [];
  const seen = new Set();

  function report(error) {
    const key = [error.code, error.line, error.command ?? '', error.flag ?? ''].join('|');
    if (seen.has(key)) return;
    seen.add(key);
    errors.push(error);
  }

  for (const claim of claims) {
    if (claim.kind === 'command') {
      if (!commands.has(claim.command)) {
        report({
          code: 'unknown-command',
          command: claim.command,
          line: claim.line,
          message: `提到不存在的子命令 ${claim.command}`,
        });
      }
      continue;
    }

    let actualShapes;
    if (claim.command !== null) {
      const commandFlags = commands.get(claim.command);
      if (!commandFlags) continue;
      if (!commandFlags.has(claim.flag)) {
        report({
          code: 'unknown-command-flag',
          command: claim.command,
          flag: claim.flag,
          line: claim.line,
          message: `${claim.command} 提到不存在的 long flag ${claim.flag}`,
        });
        continue;
      }
      actualShapes = new Set([commandFlags.get(claim.flag)]);
    } else {
      actualShapes = allFlags.get(claim.flag);
      if (!actualShapes) {
        report({
          code: 'unknown-flag',
          command: null,
          flag: claim.flag,
          line: claim.line,
          message: `提到不存在的 long flag ${claim.flag}`,
        });
        continue;
      }
    }

    if (claim.takesValue !== null && !actualShapes.has(claim.takesValue)) {
      report({
        code: 'flag-value-shape',
        command: claim.command,
        flag: claim.flag,
        line: claim.line,
        message: `${claim.command ? `${claim.command} 的 ` : ''}${claim.flag} 文档表示${
          claim.takesValue ? '需要值' : '不带值'
        }，Commander 注册项相反`,
      });
    }
  }
  return errors.sort((left, right) => left.line - right.line);
}

export function formatDocsError(error, docRelativePath = 'skills/cdp-control/SKILL.md') {
  return `${docRelativePath}:${error.line} docs-check/${error.code}: ${error.message}`;
}

export function checkDocs({ rootDir = defaultRootDir } = {}) {
  const relativeDoc = 'skills/cdp-control/SKILL.md';
  const markdown = readFileSync(join(rootDir, relativeDoc), 'utf8');
  const contract = extractCommanderContract({ rootDir });
  const claims = extractSkillClaims(markdown);
  const commandClaims = claims.filter(claim => claim.kind === 'command').length;
  const flagClaims = claims.filter(claim => claim.kind === 'flag').length;
  if (commandClaims === 0 || flagClaims === 0) {
    throw new Error(`文档受检范围为空: command claims=${commandClaims}, flag claims=${flagClaims}`);
  }
  const errors = validateSkillClaims(contract, claims);
  if (errors.length > 0) {
    for (const error of errors) console.error(formatDocsError(error, relativeDoc));
    throw new Error(`docs:check 失败: ${errors.length} 处 CLI 文档漂移`);
  }
  const registeredFlags = contract.commands.reduce((total, command) => total + command.flags.length, 0);
  console.log(
    `docs:check 通过: Commander ${contract.commands.length} 个真实子命令/${registeredFlags} 个 long flag 注册项；SKILL.md 单向校验 ${commandClaims} 条命令/${flagClaims} 条 flag 声明`,
  );
  return { claims, contract };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  try {
    checkDocs();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
