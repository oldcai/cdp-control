/**
 * 站点: zhihu.com
 * 用途: 抓当前问题页已加载的评论(回复者用户名 + 正文 + 点赞)
 * 用法: node "<SKILL>/dist/cdp.js" run sites/zhihu/get-comments.js
 * 返回: [{author, body, likes}]
 * 依赖的 DOM 结构假设:
 *   - 评论项:   .CommentItem
 *   - 用户名:   .CommentItem .author 下 a
 *   - 正文:     .CommentItem .CommentItem-content
 *   - 点赞:     .CommentItem 内 .VoteButton
 * 最后验证: 未实测(样例)
 * 状态: ⚠️ 待实测——先 open 目标问题页、滚动加载评论区,再用 view/snapshot 核对真实 selector 后更新本文件。
 */

// 原语自包含:自己定位 target。改成目标问题页的 url/title 子串,或在外面用参数传入。
const url = process.env.ZHIHU_QUESTION_URL;
if (!url) throw new Error('需设环境变量 ZHIHU_QUESTION_URL 指向知乎问题页,或改本文件第 16 行');
const target = (await cdp.resolve(url)) || (await cdp.open(url), await cdp.resolve(url));

// 等评论区出现(懒加载);滚到底部多拉几屏触发加载。
await cdp.waitForFn(target, `!!document.querySelector('.CommentItem')`, { timeout: 15000 });
const sleep = ms => new Promise(r => setTimeout(r, ms));
for (let i = 0; i < 5; i++) {
  await cdp.eval(target, `window.scrollBy(0, window.innerHeight); 'ok'`);
  await sleep(600);
}

const data = await cdp.eval(
  target,
  `(() => {
  const items = [...document.querySelectorAll('.CommentItem')];
  return items.map(it => ({
    author: it.querySelector('.author a')?.innerText?.trim(),
    body: it.querySelector('.CommentItem-content')?.innerText?.trim(),
    likes: it.querySelector('.VoteButton')?.innerText?.trim(),
  }));
})()`,
);

console.log(`共 ${data.length} 条评论:`);
console.log(JSON.stringify(data, null, 2));
