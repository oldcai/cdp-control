// zhihu.js — 知乎站点 recipe(一文件一站点,内含多条规则)。
//
// 设计(见 DESIGN.md recipe 段):文件名 = 站点聚合标签;每条规则 `{ name, scope, extract }` 里,
// scope 可为 string|string[](一抽取逻辑服务多 URL 形态),规则数组元素对应不同布局(不同 extract)。
// 匹配在跨文件跨规则上做全序(最具体 scope 优先),与「加专栏怕撞文件名」从此无关。
const { clean, refstr, opHint, abridge } = require('./_lib.js');

// ──────────────────────────── 规则 1:问题 / 回答页 ────────────────────────────
// questionRead:抽取问题页结构。eval 只做 DOM 读,refOf/text 用引擎只读探针 __cdpProbe(只查已建树、
// 未命中 null、不按需注册);归一化/呈现归 Node 侧 _lib。抽成函数以便「展开首个回答后重读一次结构」复用。
function questionRead() {
  return `(function(){
    const { refOf, text } = window.__cdpProbe;
    const raw = text;

    const h1 = document.querySelector('h1');
    const vv = document.querySelector('.ViewAll a, .ViewAll');
    const head = document.querySelector('.QuestionHeader');
    const qFollow = head && head.querySelector('.FollowButton');
    const qWrite  = head && head.querySelector('.WriteAnswerButton');
    const followerEl = head && head.querySelector('.NumberBoard-item');
    const viewedBox = head && [].slice.call(head.querySelectorAll('.NumberBoard-itemInner'))
      .find(n => /被浏览/.test(n.textContent || ''));
    const viewedEl = viewedBox && viewedBox.querySelector('strong');
    const topics = (head && head.querySelector('.QuestionHeader-topics'))
      ? [].slice.call(head.querySelectorAll('.QuestionHeader-topics a'))
          .map(a => ({ ref: refOf(a), t: raw(a) })).filter(x => x.t) : [];
    const foot = head && head.querySelector('.QuestionHeader-footer');
    const footBtns = foot ? [].slice.call(foot.querySelectorAll('.Button--withLabel')) : [];
    const fbt = (i) => footBtns[i] ? { ref: refOf(footBtns[i]), t: raw(footBtns[i]) } : null;

    const answers = [...document.querySelectorAll('.ContentItem.AnswerItem')].map((el, idx) => {
      const author = el.querySelector('.AuthorInfo-name');
      const bio    = el.querySelector('.AuthorInfo-badgeText');
      const rich   = el.querySelector('.RichContent-inner');
      const vote   = el.querySelector('.VoteButton');
      const act    = [].slice.call(el.querySelectorAll('.ContentItem-actions button, .ContentItem-actions a'));
      const exp    = el.querySelector('.ContentItem-expandButton, .ContentItem-rightButton');
      const follow = el.querySelector('.FollowButton');
      const at = (i) => act[i] ? { ref: refOf(act[i]), t: raw(act[i]) } : null;
      return {
        seq: idx + 1,
        ref: refOf(el),
        authorRef: refOf(author), author: raw(author), bio: raw(bio),
        richRef: refOf(rich), preview: raw(rich),
        voteText: raw(vote), voteRef: refOf(vote),
        comment: at(2), collect: at(3), share: at(4),
        expand: exp ? { ref: refOf(exp), t: raw(exp) } : null,
        followRef: refOf(follow),
      };
    });

    return {
      h1: raw(h1), h1Ref: refOf(h1),
      vvText: raw(vv), vvRef: refOf(vv),
      topics,
      qFollow: qFollow ? { ref: refOf(qFollow), t: raw(qFollow) } : null,
      qWrite:  qWrite  ? { ref: refOf(qWrite),  t: raw(qWrite) } : null,
      follower: raw(followerEl), followerRef: refOf(followerEl),
      viewed: raw(viewedEl), viewedRef: refOf(viewedEl),
      qInvite: fbt(0), qComment: fbt(1), qShare: fbt(2), qEdit: fbt(3),
      answers,
    };
  })()`;
}

// questionFirstFull:取首个回答正文的完整 Markdown(保序、不截断,含加粗/链接/标题)。
// 用 cdp.read:容器 selector 每次重查(免疫展开重渲染替换元素/ref 漂移);被「阅读全文」折叠则传 expand
// 先点击展开再取全文(点击/等待/重查分开编排,见 api.read)。折叠判定按站点语义:按钮文案是「阅读全文」= 折叠。
async function questionFirstFull(cdp, target, first) {
  if (!first) return null;
  const container = '.ContentItem.AnswerItem .RichContent-inner';
  const collapsed = first.expand && /阅读全文/.test(clean(first.expand.t));
  const full = await cdp.read(target, { container, expand: collapsed ? { ref: first.expand.ref } : undefined });
  return full && full.markdown ? full : null;
}

async function questionExtract(cdp, ctx) {
  const { target } = ctx;
  await cdp.view(target); // 建树 → 填充 __cdpRefs(ref 是已建树节点,只查不注册)
  const r = await cdp.eval(target, questionRead());

  const out = [];
  if (r.h1) out.push(`# ${clean(r.h1)}`);
  if (r.topics && r.topics.length) out.push(`   话题: ${r.topics.map(t => clean(t.t) + refstr(t.ref)).join(' / ')}`);
  const stats = [];
  if (r.follower) stats.push(`${clean(r.follower)}${refstr(r.followerRef)}`);
  if (r.viewed) stats.push(`被浏览 ${clean(r.viewed)}${refstr(r.viewedRef)}`);
  if (stats.length) out.push(`   ${stats.join('  ·  ')}`);
  if (r.qWrite) out.push(`✎ ${clean(r.qWrite.t)}${refstr(r.qWrite.ref)} · 关注问题: ${r.qFollow ? clean(r.qFollow.t) + refstr(r.qFollow.ref) : '(不可关注)'}`);
  const qActs = [];
  if (r.qInvite)  qActs.push(`邀请回答${refstr(r.qInvite.ref)}`);
  if (r.qComment) qActs.push(`问题评论 ${clean(r.qComment.t)}${refstr(r.qComment.ref)}`);
  if (r.qShare)   qActs.push(`分享${refstr(r.qShare.ref)}`);
  if (r.qEdit)    qActs.push(`修改问题${refstr(r.qEdit.ref)}`);
  if (qActs.length) out.push(`   ${qActs.join(' · ')}`);
  if (r.vvText) out.push(`▸ 回答: ${clean(r.vvText)}${refstr(r.vvRef)} ${opHint('view', r.vvRef)}`);
  out.push('');

  const ans = r.answers || [];
  if (!ans.length) out.push('(未读到任何回答,可能需要 view --scroll-to-load 后再试)');
  for (let i = 0; i < ans.length; i++) {
    const a = ans[i];
    const metaBits = [];
    if (a.voteText) metaBits.push(`${clean(a.voteText).replace(/^已/, '')}${refstr(a.voteRef)}`);
    if (a.comment && a.comment.t) metaBits.push(`${clean(a.comment.t)}${refstr(a.comment.ref)}`);
    if (a.collect && a.collect.t) metaBits.push(`收藏 ${clean(a.collect.t)}${refstr(a.collect.ref)}`);
    if (a.share && a.share.t) metaBits.push(`分享 ${clean(a.share.t)}${refstr(a.share.ref)}`);
    if (a.expand && /阅读全文|收起/.test(clean(a.expand.t))) {
      metaBits.push(`[${clean(a.expand.t)}${refstr(a.expand.ref)} ${opHint('click', a.expand.ref)}]`);
    }
    out.push(`── 回答 ${a.seq}${a.author ? ' · ' + clean(a.author) : ''}${refstr(a.authorRef)}${a.followRef != null ? ` 关注TA${refstr(a.followRef)}` : ''}${a.bio ? ' (' + clean(a.bio) + ')' : ''}`);
    out.push(`    ${metaBits.join('  ')}`);

    if (i === 0) {
      // 首个回答输出全文(完整正文,非 160 字预览);被「阅读全文」折叠先展开再取。
      const full = await questionFirstFull(cdp, target, a);
      if (full && full.markdown) {
        const md = String(full.markdown).trim();
        if (md) {
          for (const line of md.split('\n')) out.push(`    ${line}`);
        } else {
          out.push(`    (首个回答无可提取文本) 定位容器: view ${a.ref}`);
        }
      } else {
        out.push(`    展开全文: article ${a.richRef} · 定位容器: view ${a.ref}`);
      }
    } else {
      const preview = abridge(a.preview);
      out.push(`    ${preview || '本回答无可预览文本。'}`);
      out.push(`    展开全文: article ${a.richRef} · 定位容器: view ${a.ref}`);
    }
    out.push('');
  }

  return { lines: out };
}

// ──────────────────────────── 规则 2:专栏文章页 ────────────────────────────
async function zhuanlanExtract(cdp, ctx) {
  const { target } = ctx;
  await cdp.view(target); // 建树 → 填充 __cdpRefs;refOf 只查已建树

  const r = await cdp.eval(target, `(function(){
    const { refOf, text } = window.__cdpProbe;
    const raw = text;

    const art = document.querySelector('article');
    const h1 = art && art.querySelector('h1');
    const author = art && art.querySelector('.AuthorInfo-name');
    const follow = art && [...art.querySelectorAll('button')].find(b => /^[ ​]*关注/.test(b.textContent || ''));
    const rich = art && art.querySelector('.RichText');
    const col = document.querySelector('a[href*="/column/"]');
    const timeEl = art && [...art.querySelectorAll('*')].find(e => e.children.length === 0 && /编辑于|发布于/.test(e.textContent || ''));
    const colTime = art && [...art.querySelectorAll('*')].find(e => e.children.length === 0 && /更新/.test(e.textContent || '') && e.textContent.includes('所属专栏'));

    const acts = art ? [...art.querySelectorAll('.ContentItem-actions button, .RichContent-actions button, .ContentItem-actions a, .RichContent-actions a')] : [];
    const actAt = (i) => acts[i] ? { ref: refOf(acts[i]), t: raw(acts[i]) } : null;
    const vote = actAt(0), comment = actAt(2), collect = actAt(3), share = actAt(4);

    const subscribe = art && [...art.querySelectorAll('button')].find(b => /^订阅/.test(b.textContent || ''));

    return {
      h1: raw(h1), h1Ref: refOf(h1),
      author: raw(author), authorRef: refOf(author),
      follow: follow ? { ref: refOf(follow), t: raw(follow) } : null,
      col: raw(col), colRef: refOf(col),
      time: timeEl ? raw(timeEl) : null,
      colTime: colTime ? raw(colTime) : null,
      richRef: refOf(rich), preview: raw(rich),
      vote, comment, collect, share,
      subscribe: subscribe ? { ref: refOf(subscribe), t: raw(subscribe) } : null,
    };
  })()`);

  const out = [];
  if (r.h1) out.push(`# ${clean(r.h1)}`);
  const bits = [];
  if (r.author) bits.push(`作者:${clean(r.author)}${refstr(r.authorRef)}`);
  if (r.col) bits.push(`专栏:${clean(r.col)}${refstr(r.colRef)}`);
  if (r.follow) bits.push(`关注TA${refstr(r.follow.ref)} ${opHint('click', r.follow.ref)}`);
  if (r.subscribe) bits.push(`订阅${refstr(r.subscribe.ref)} ${opHint('click', r.subscribe.ref)}`);
  if (bits.length) out.push(`   ${bits.join(' · ')}`);
  const stats = [];
  if (r.vote && r.vote.t) stats.push(`${clean(r.vote.t)}${refstr(r.vote.ref)}`);
  if (r.comment && r.comment.t) stats.push(`${clean(r.comment.t)}${refstr(r.comment.ref)}`);
  if (r.collect && r.collect.t) stats.push(`收藏 ${clean(r.collect.t).replace(/[收藏]/g,'')}${refstr(r.collect.ref)}`);
  if (r.share && r.share.t) stats.push(`分享 ${clean(r.share.t).replace(/[分享]/g,'')}${refstr(r.share.ref)}`);
  if (stats.length) out.push(`   ${stats.join(' · ')}`);
  out.push('');
  if (r.time) out.push(`   ${clean(r.time)}`);
  if (r.colTime) out.push(`   ${clean(r.colTime)}`);
  // 专栏正文完整取全文(保序、不截断);用 cdp.read 按容器 selector 取(专栏整文直接载入,无折叠,不传 expand)。
  let md = '';
  try {
    const full = await cdp.read(target, { container: '.RichText' });
    md = full && full.markdown ? String(full.markdown).trim() : '';
  } catch { md = ''; }
  if (md) {
    out.push('');
    for (const line of md.split('\n')) out.push(`   ${line}`);
  } else {
    out.push(`   ${abridge(r.preview) || '(正文无可预览文本)'}`);
    out.push(`   展开全文: article ${r.richRef} · 定位容器: view ${r.h1Ref}`);
  }
  out.push('');

  return { lines: out };
}

module.exports = [
  {
    name: '问题/回答页',
    scope: 'www.zhihu.com/question/*',
    extract: questionExtract,
  },
  {
    name: '专栏文章',
    scope: 'zhuanlan.zhihu.com/p/*',
    extract: zhuanlanExtract,
  },
];

/*
== selector 实测清单(知乎 2026-08,专栏 zhuanlan.zhihu.com/p/*) ==
容器 art=document.querySelector('article'):
  标题      art h1
  作者名    art .AuthorInfo-name(此处为专栏名「AI 技术在何方」;真写手在 avatar alt「点击打开XX的主页」,取不到 name)
  专栏链接  a[href*="/column/"](首条「技术文章」)
  关注      art button 文本开头「关注」(→「关注他」);订阅 button 文本开头「订阅」
  正文      art .RichText(纯文本子节点齐全,无「阅读全文」截断——专栏整文直接载入)
  发布时间  art 叶节点文本含「编辑于/发布于」(形如「编辑于 2024-03-06 11:52・北京・信息来源于 官方网站」)
  所属专栏  叶节点含「所属专栏 · …更新」
动作 .ContentItem-actions/.RichContent-actions 内 button/a,按序 index:
  0「赞同 N」 · 1 反对(空) · 2「N 条评论」 · 3 收藏数(裸数字) · 4 分享数(裸数字);其后「分享」「申请转载」
== 坑 / 取舍 ==
- 作者名取 .AuthorInfo-name,但专栏页里它是"专栏"名而非写手本身;写手名只藏在头像 alt,不做主字段。
- 收藏/分享是裸数字无语义 label,按固定 index 取;赞同/评论带 label,赞同数字 strip 留「赞同 N」。
- 正文完整载入无「阅读全文」;真实"点了才加载"入口为:关注/订阅(未关注态)与评论区(未在当前页 DOM)。
- refOf 同规则1:只查已建树(未命中 null),不按需注册,避免平移全局 ref 号。
== 问题+答案区(见上,规则1)==
问题头部 .QuestionHeader:
  关注者数    .NumberBoard-item(文本「关注者 6,511」)
  被浏览数    .NumberBoard-itemInner 含「被浏览」→ 其内 strong(数字)
  关注问题    .FollowButton;写回答 .WriteAnswerButton
  归属话题    .QuestionHeader-topics a
  底部操作区  .QuestionHeader-footer .Button--withLabel 稳定为[邀请回答][问题评论 N 条][分享][修改问题]
容器(每回答): .ContentItem.AnswerItem(含精读 host 回答 + cascade,三类全收)
  作者名 .AuthorInfo-name;签名 .AuthorInfo-badgeText;正文 .RichContent-inner
  赞同 .VoteButton(文本「赞同 1.5 万」;精读时前缀「已」);动作条 .ContentItem-actions button/a
   按序[赞同][反对][N 条评论➜2][收藏数➜3][分享数➜4]
  关注作者 AnswerItem 内首个 .FollowButton;展开/收起 .ContentItem-expandButton(「阅读全文」/「收起」)
「查看全部 N 个回答」链接: .ViewAll a / .ViewAll(全页多处,取首)
== 坑 / 取舍 ==
- .List-item 只含 cascade 回答,漏精读 host;.ContentItem.AnswerItem 三类全收。
- 收藏/分享无语义 label,动作条里是裸数字,按固定 index 取。
- 被精读回答 vote 文本「已赞同 X」,剥「已」。全文过长:预览 160 字 + 暴露正文/容器 ref。
- 「阅读全文」是「点了才载入」的入口:先 click 展开才能 article 全文;ref 在 __cdpRefs,click <ref> 即可。
- refOf 只查已建树(未命中返回 null 而非 -1),不按需注册(否则平移 ref 全局号、断 parentRef 自愈链)。
*/
