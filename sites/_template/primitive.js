/**
 * 站点: <域名>
 * 用途: <单用途一句话,如"抓当前页全部评论(正文+回复者用户名+点赞)">
 * 用法: node "<SKILL>/dist/cdp.js" run sites/<域名>/<名字>.js
 * 返回: <返回结构,如 [{author, body, likes, replies:[...]}]>
 * 依赖的 DOM 结构假设:
 *   - 评论容器: .CommentList
 *   - 评论项:   .CommentItem
 *   - 用户名:   .CommentItem .author a
 *   - 正文:     .CommentItem .content
 * 最后验证: <YYYY-MM-DD>
 * 状态: ✅ 已验证(写明实测通过的现象) / ⚠️ 失效待修(写明现象)
 */

// 原语自包含:自己定位 target,不假设"当前选中页"。
const target = await cdp.resolve(''); // ← 改成 url/title 子串
await cdp.waitFor(target, '.CommentList', { timeout: 10000 });

const data = await cdp.eval(
  target,
  `(() => {
  const items = [...document.querySelectorAll('.CommentItem')];
  return items.map(it => ({
    author: it.querySelector('.author a')?.innerText.trim(),
    body: it.querySelector('.content')?.innerText.trim(),
    likes: it.querySelector('.like')?.innerText.trim(),
  }));
})()`,
);

console.log(JSON.stringify(data, null, 2));
