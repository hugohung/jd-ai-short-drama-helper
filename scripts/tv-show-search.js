/**
 * LibTV TV Show 参考作品搜索脚本
 * 用法：node tv-show-search.js [maxProjects]
 * 示例：node tv-show-search.js 15
 *
 * 输出：JSON 数组，每项包含 { name, url }
 * 例如：[ { "name": "温情短片《几楼了》", "url": "https://www.liblib.tv/detail/2a5c3d7dfc63480d8c777b51f111b384" } ]
 */

const puppeteer = require('puppeteer');

(async () => {
  const maxProjects = Math.min(parseInt(process.argv[2]) || 15, 30);
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    headless: true,
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );
  await page.setViewport({ width: 1440, height: 900 });

  // 拦截 feed API，获取项目数据（含 templateUuid 等字段）
  let feedProjects = [];
  page.on('response', async (resp) => {
    const url = resp.url();
    if (url.includes('/feed/stream') && feedProjects.length === 0) {
      try {
        const ct = resp.headers()['content-type'] || '';
        if (ct.includes('json')) {
          const body = await resp.json();
          if (body?.data?.list) {
            feedProjects = body.data.list;
          }
        }
      } catch (_) {}
    }
  });

  // 注入 pushState 钩子，捕获前端路由跳转的 detail URL
  await page.evaluateOnNewDocument(() => {
    window.__detailUrls = [];
    const orig = history.pushState;
    history.pushState = function (state, title, url) {
      if (url && typeof url === 'string' && url.includes('/detail/')) {
        window.__detailUrls.push({ url, time: Date.now() });
      }
      return orig.apply(this, arguments);
    };
  });

  await page.goto('https://www.liblib.tv', { waitUntil: 'networkidle2', timeout: 60000 });
  // 等待 SPA 完全渲染
  await new Promise((r) => setTimeout(r, 12000));

  // 滚动加载更多内容
  for (let i = 0; i < 10; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.7));
    await new Promise((r) => setTimeout(r, 1500));
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await new Promise((r) => setTimeout(r, 3000));

  // 如果 feed API 未捕获到数据，刷新页面重新尝试
  if (feedProjects.length === 0) {
    await page.reload({ waitUntil: 'networkidle2' });
    await new Promise((r) => setTimeout(r, 12000));
  }

  // ── 收集项目卡片 ──────────────────────────────────────────
  // 通过 DOM 特征（cursor:pointer + 内含 img）识别项目卡片
  const cards = await page.evaluate(() => {
    const results = [];
    const seen = new Set();
    const allDivs = Array.from(document.querySelectorAll('div'));
    for (const el of allDivs) {
      const style = window.getComputedStyle(el);
      if (style.cursor !== 'pointer') continue;
      const text = el.innerText?.trim() || '';
      if (!el.querySelector('img')) continue;
      if (text.length < 5 || text.length > 300) continue;
      if (/登录|注册|会员|返回|关闭|活动|创作|创作者|剩余|倒计时/.test(text)) continue;
      const key = text.substring(0, 40).replace(/\n/g, ' ');
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({ text, childImgCount: el.querySelectorAll('img').length });
    }
    return results;
  });

  const projects = [];
  const detailUrlMap = new Map(); // name -> url

  for (let i = 0; i < Math.min(cards.length, maxProjects); i++) {
    const cardText = cards[i].text;

    // 点击卡片
    const clicked = await page.evaluate((keyword) => {
      const allDivs = Array.from(document.querySelectorAll('div'));
      for (const el of allDivs) {
        if (window.getComputedStyle(el).cursor !== 'pointer') continue;
        const text = el.innerText?.trim() || '';
        if (text.includes(keyword.substring(0, 25))) {
          el.click();
          return text.substring(0, 80);
        }
      }
      return null;
    }, cardText);

    if (!clicked) {
      // 如果找不到元素（页面状态变化），刷新后重试一次
      await page.goto('https://www.liblib.tv', { waitUntil: 'networkidle2', timeout: 30000 });
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }

    // 等待前端路由跳转
    await new Promise((r) => setTimeout(r, 3000));

    const currentUrl = page.url();
    const captured = await page.evaluate(() => window.__detailUrls || []);

    if (currentUrl.includes('/detail/')) {
      const name = clicked.replace(/\n/g, ' ').substring(0, 60);
      const entry = { name, url: currentUrl };
      // 避免重复
      if (!detailUrlMap.has(name)) {
        detailUrlMap.set(name, true);
        projects.push(entry);
      }
    } else if (captured.length > 0) {
      // 通过 pushState 钩子捕获到的 URL（页面未完全导航）
      const lastUrl = captured[captured.length - 1].url;
      if (lastUrl.includes('/detail/')) {
        const name = clicked.replace(/\n/g, ' ').substring(0, 60);
        const fullUrl = lastUrl.startsWith('http')
          ? lastUrl
          : 'https://www.liblib.tv' + lastUrl;
        if (!detailUrlMap.has(name)) {
          detailUrlMap.set(name, true);
          projects.push({ name, url: fullUrl });
        }
      }
    }

    // 返回首页继续点击下一个
    await page.goto('https://www.liblib.tv', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise((r) => setTimeout(r, 4000));
  }

  // ── 如果点击方式收集不足，尝试用 feed API 数据 + 已知 ID 规则补充 ──
  if (projects.length < 3 && feedProjects.length > 0) {
    for (const p of feedProjects.slice(0, maxProjects)) {
      const name = p.name || '未知项目';
      // 优先使用已收集到的 URL；否则尝试用 templateUuid 构造
      const existing = projects.find((x) => x.name.includes(name.substring(0, 10)));
      if (!existing && p.templateUuid) {
        projects.push({
          name,
          url: 'https://www.liblib.tv/detail/' + p.templateUuid,
          description: p.description || '',
        });
      }
    }
  }

  console.log(JSON.stringify(projects, null, 2));
  await browser.close();
})().catch((e) => {
  console.error('脚本执行失败：' + e.message);
  process.exit(1);
});
