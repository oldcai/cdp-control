/**
 * browser-discover.ts — 跨平台浏览器候选发现(纯函数,零 fs)。
 * ensureBrowser 用它拿候选列表,再经 resolveExe 过滤(existsSync/command -v)、逐个尝试拉起。
 */
export type BrowserKind = 'edge' | 'chrome' | 'chromium' | 'brave' | 'arc';
export interface Candidate {
  exe: string;
  kind: BrowserKind;
}

function env() {
  return {
    pf: process.env.PROGRAMFILES || 'C:/Program Files',
    pf86: process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)',
    pw64: process.env.ProgramW6432 || process.env.PROGRAMFILES || 'C:/Program Files',
    la: process.env.LOCALAPPDATA || '',
    home: process.env.HOME || process.env.USERPROFILE || '',
  };
}

function windows(e: ReturnType<typeof env>): Candidate[] {
  const edge = [
    `${e.pf86}/Microsoft/Edge/Application/msedge.exe`,
    `${e.pf}/Microsoft/Edge/Application/msedge.exe`,
    `${e.la}/Microsoft/Edge/Application/msedge.exe`,
    `${e.pf86}/Microsoft/Edge Beta/Application/msedge.exe`,
    `${e.pf86}/Microsoft/Edge Dev/Application/msedge.exe`,
  ];
  const chrome = [
    `${e.pw64}/Google/Chrome/Application/chrome.exe`,
    `${e.pf86}/Google/Chrome/Application/chrome.exe`,
    `${e.la}/Google/Chrome/Application/chrome.exe`,
  ];
  return [
    ...edge.map(p => ({ exe: p, kind: 'edge' as const })),
    ...chrome.map(p => ({ exe: p, kind: 'chrome' as const })),
  ];
}

function macos(e: ReturnType<typeof env>): Candidate[] {
  // 精确 .app 名 + Contents/MacOS/<精确可执行名>(bin 名与 .app 名可不一致、可含空格)。
  const apps = [
    { name: 'Microsoft Edge', bin: 'Microsoft Edge', kind: 'edge' as const },
    { name: 'Google Chrome', bin: 'Google Chrome', kind: 'chrome' as const },
    { name: 'Chromium', bin: 'Chromium', kind: 'chromium' as const },
    { name: 'Brave Browser', bin: 'Brave Browser', kind: 'brave' as const },
    { name: 'Arc', bin: 'Arc', kind: 'arc' as const },
  ];
  const roots = ['/Applications', `${e.home}/Applications`];
  const out: Candidate[] = [];
  for (const root of roots) {
    for (const a of apps) out.push({ exe: `${root}/${a.name}.app/Contents/MacOS/${a.bin}`, kind: a.kind });
  }
  return out;
}

function linux(_e: ReturnType<typeof env>): Candidate[] {
  const names = [
    'google-chrome-stable',
    'google-chrome',
    'chromium',
    'chromium-browser',
    'microsoft-edge-stable',
    'microsoft-edge',
  ];
  return names.map(n => ({ exe: n, kind: (/edge/.test(n) ? 'edge' : 'chrome') as BrowserKind }));
}

/** 输出按平台、按优先级排序的候选列表(win/mac 为绝对路径,linux 为 command -v 名称)。 */
export function discoverCandidates(platform: string = process.platform): Candidate[] {
  const e = env();
  if (platform === 'win32') return windows(e);
  if (platform === 'darwin') return macos(e);
  return linux(e);
}
