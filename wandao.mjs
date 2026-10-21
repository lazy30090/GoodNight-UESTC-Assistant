#!/usr/bin/env node
/**
 * 晚安成电 · 一键打卡（零依赖，Chrome + CDP）
 *
 *   node wandao.mjs            登录并打卡（默认）
 *   node wandao.mjs probe      只看状态，不打卡
 *   node wandao.mjs login      只登录，确认会话可用
 *
 * 二次验证需要你本人在弹出的窗口里完成（短信或扫码），其余全自动。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CFG_FILE = path.join(ROOT, 'config.json');

const cfg = Object.assign(
  {
    appUrl:
      'https://jzsz.uestc.edu.cn/daily-checkin-h5/index.html?appId=294#/pages/student/report-today/home/index',
    chrome: process.platform === 'win32'
      ? [process.env.PROGRAMFILES || 'C:/Program Files', process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)', process.env.LOCALAPPDATA || os.homedir()]
          .map((base) => path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'))
          .find((candidate) => fs.existsSync(candidate)) || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
      : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    port: 9333,
    profile: process.env.WANDAO_PROFILE || path.join(os.homedir(), '.wandao-chrome'),
    headless: false,
    studentId: '',
    password: '',
    point: null,
    force: false,
    userAgent:
      // 只保留打卡页需要的小程序标识；不携带具体机型、系统构建号或 CPU 架构。
      'Mozilla/5.0 (Linux; Android 10; wv) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 Mobile Safari/537.36 ' +
      'MicroMessenger/8.0 WeChat Weixin NetType/WIFI Language/zh_CN ' +
      'miniProgram/wx4f9fb9d2a4e9b6d3',
  },
  fs.existsSync(CFG_FILE) ? JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) : {},
);

const API = 'https://jzsz.uestc.edu.cn/daily-checkin/api';
const LOGIN_WAIT_MS = Number(process.env.WANDAO_LOGIN_WAIT ?? 600) * 1000;

const argv = process.argv.slice(2);
const cmd = argv.find((a) => !a.startsWith('-')) ?? 'checkin';
const has = (f) => argv.includes(f);

if (has('--help') || has('-h')) {
  console.log('用法：\n  node wandao.mjs login    只验证登录\n  node wandao.mjs probe    只查询状态，不提交\n  node wandao.mjs          登录并提交打卡\n  node wandao.mjs --force  强制再次提交（仍受服务端规则限制）\n  node wandao.mjs --debug  显示登录等待详情\n\n账号密码可手动输入，或设置 config.json / WANDAO_ID / WANDAO_PW。二次验证需要本人操作。');
  process.exit(0);
}
if (!['login', 'probe', 'checkin'].includes(cmd)) {
  console.error('未知命令：' + cmd + '。请运行 node wandao.mjs --help 查看用法。');
  process.exit(1);
}
if (typeof WebSocket !== 'function') {
  console.error('当前 Node.js 缺少内置 WebSocket，请使用 Node.js 22 或更高版本。');
  process.exit(1);
}
cfg.studentId = process.env.WANDAO_ID || cfg.studentId;
cfg.password = process.env.WANDAO_PW || cfg.password;
cfg.force = cfg.force || has('--force');


// ------------------------------------------------------------------ CDP
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(`${msg.error.message} (${msg.error.code})`)) : resolve(msg.result);
      } else if (msg.method) {
        for (const h of this.handlers) h(msg);
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true });
    });
    return new CDP(ws);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  close() {
    try { this.ws.close(); } catch {}
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launchChrome() {
  // 如果已经有一个调试端口的 Chrome 在跑，直接接管
  try {
    const v = await (await fetch(`http://127.0.0.1:${cfg.port}/json/version`)).json();
    return { wsUrl: v.webSocketDebuggerUrl, proc: null };
  } catch {}

  if (!fs.existsSync(cfg.chrome)) throw new Error(`找不到 Chrome：${cfg.chrome}`);
  const args = [
    `--remote-debugging-port=${cfg.port}`,
    `--user-data-dir=${cfg.profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--disable-crash-reporter',
    '--lang=zh-CN',
  ];
  if (cfg.headless) args.push('--headless=new');
  if (process.env.WANDAO_NOSANDBOX === '1') args.push('--no-sandbox', '--disable-gpu');
  args.push('about:blank');

  const proc = spawn(cfg.chrome, args, { stdio: 'ignore', detached: false });
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    try {
      const v = await (await fetch(`http://127.0.0.1:${cfg.port}/json/version`)).json();
      return { wsUrl: v.webSocketDebuggerUrl, proc };
    } catch {}
  }
  throw new Error('Chrome 启动超时');
}

class Page {
  constructor(cdp, sid) { this.cdp = cdp; this.sid = sid; }
  send(m, p) { return this.cdp.send(m, p, this.sid); }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error('页面异常: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
    }
    return r.result?.value;
  }
  url() { return this.eval('location.href'); }
}

async function openPage(cdp) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const page = new Page(cdp, sessionId);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Browser.grantPermissions', {
    origin: 'https://jzsz.uestc.edu.cn', permissions: ['geolocation'],
  }).catch(() => {});
  // 页面里的 Mw() 靠这个变量判断“是否在小程序里”，不在就拒绝打卡
  await page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `Object.defineProperty(window,'__wxjs_environment',{value:'miniprogram',writable:true,configurable:true});`,
  });
  return page;
}

// ------------------------------------------------------------------ 登录
async function waitForLogin(page, ms, label) {
  const t0 = Date.now();
  let last = 0;
  while (Date.now() - t0 < ms) {
    const href = await page.url();
    if (href.startsWith('https://jzsz.uestc.edu.cn')) {
      const p = await page.eval(
        `fetch('${API}/auth/user-info',{credentials:'include',headers:{platform:'h5'}}).then(r=>r.json()).catch(()=>null)`,
      );
      if (p?.code === 0) return true;
    } else if (href.includes('authserver/login')) {
      const err = await page.eval(`document.querySelector('#showErrorTip')?.innerText?.trim() || ''`);
      if (err) throw new Error('登录失败：' + err);
    }
    if (has('--debug') && Date.now() - last > 10000) {
      last = Date.now();
      const info = await page.eval(`(() => ({
        url: location.href, title: document.title,
        text: (document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 260)
      }))()`);
      console.log('   [等待中]', info.url);
      console.log('            ', info.title, '|', info.text);
    }
    await sleep(1000);
  }
  throw new Error(label + ` 超时（${Math.round(ms / 60000)} 分钟）`);
}

async function login(page) {
  const CAS =
    'https://idas.uestc.edu.cn/authserver/login?service=' + encodeURIComponent('https://jzsz.uestc.edu.cn/');

  await page.send('Page.navigate', { url: CAS });
  await sleep(2500);

  if ((await page.url()).startsWith('https://jzsz.uestc.edu.cn')) {
    console.log('>> 已有有效会话，跳过登录');
    return;
  }

  if (!cfg.studentId || !cfg.password) {
    console.log('\n>> 请在 Chrome 窗口里登录：学号 / 密码 → 二次验证（短信或扫码）');
    console.log(`   脚本最多等 ${Math.round(LOGIN_WAIT_MS / 60000)} 分钟。`);
    await waitForLogin(page, LOGIN_WAIT_MS, '登录');
    return;
  }

  console.log('>> 已自动填好账号密码，请在窗口里完成二次验证…');
  await page.eval(`(() => {
    const vis = (el) => el && el.offsetParent !== null && el.getBoundingClientRect().width > 0;
    const set = (el, v) => {
      if (!el) return false;
      el.focus();
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };
    const u = [...document.querySelectorAll('input#username, input[name=username]')].find(vis);
    const p = [...document.querySelectorAll('input#password, input[name=password]:not([type=hidden])')].find(vis);
    const b = [...document.querySelectorAll('#login_submit, a.login-btn, button[type=submit]')].find(vis);
    set(u, ${JSON.stringify(cfg.studentId)});
    set(p, ${JSON.stringify(cfg.password)});
    const rm = [...document.querySelectorAll('input#rememberMe, input[name=rememberMe]')].find(vis);
    if (rm && !rm.checked) rm.click();
    if (b) b.click();
    return !!(u && p && b);
  })()`);
  await waitForLogin(page, LOGIN_WAIT_MS, '登录（含二次验证）');
}

// ------------------------------------------------------------------ 打卡页
const apiGet = (p) =>
  `fetch('${API + p}',{credentials:'include',headers:{platform:'h5'}}).then(r=>r.json()).catch(e=>({error:String(e)}))`;

async function ensureApp(page) {
  // 登录完成后再伪装成小程序 webview，否则 CAS 会走微信扫码登录分支
  await page.send('Emulation.setUserAgentOverride', { userAgent: cfg.userAgent, acceptLanguage: 'zh-CN,zh' });
  if (!(await page.url()).includes('daily-checkin-h5')) {
    await page.send('Page.navigate', { url: cfg.appUrl });
  }
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if ((await page.url()).includes('daily-checkin-h5') && (await page.eval('document.readyState')) === 'complete') break;
  }
  await sleep(2000);
}

async function fetchState(page) {
  const out = {};
  for (const [k, p] of Object.entries({
    user: '/auth/user-info',
    schedule: '/checkin-schedule/effective',
    today: '/student-checkin-record/today',
    fence: '/campus-fence/current-student',
    locations: '/checkin-location/available-locations',
  })) {
    try { out[k] = await page.eval(apiGet(p)); } catch (e) { out[k] = { error: e.message }; }
  }
  return out;
}

function pointInGeoJson(pt, geo) {
  const rings = [];
  const walk = (g) => {
    if (!g) return;
    if (g.type === 'Feature') return walk(g.geometry);
    if (g.type === 'FeatureCollection') return (g.features || []).forEach(walk);
    if (g.type === 'Polygon') return rings.push(g.coordinates[0]);
    if (g.type === 'MultiPolygon') return g.coordinates.forEach((p) => rings.push(p[0]));
  };
  walk(geo);
  return rings.some((ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > pt.latitude !== yj > pt.latitude &&
          pt.longitude < ((xj - xi) * (pt.latitude - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  });
}

function pickPoint(locations, fence) {
  if (cfg.point) return { latitude: cfg.point[0], longitude: cfg.point[1], source: 'config' };
  const pts = (locations?.data ?? []).map((l) => ({
    latitude: l.latitude, longitude: l.longitude, name: l.groupName, radius: l.radiusMeter,
  }));
  if (pts.length === 1) return { ...pts[0], source: 'available-locations' };
  for (const p of pts) {
    for (const f of fence?.data ?? []) {
      try {
        const g = JSON.parse(f.fenceGeojson || 'null');
        if (g && pointInGeoJson(p, g)) return { ...p, source: 'available-locations(in-fence)' };
      } catch {}
    }
  }
  return pts[0] ? { ...pts[0], source: 'available-locations(first)' } : null;
}

async function postCheckin(page, point) {
  const clientTime = await page.eval(`(() => {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds());
  })()`);
  const body = {
    latitude: point.latitude,
    longitude: point.longitude,
    reverseGeocode: point.address ?? '',
    clientTime,
    userAgent: cfg.userAgent,
  };
  const res = await page.eval(`fetch('${API}/student-checkin-record/checkin',{
    method:'POST', credentials:'include',
    headers:{'Content-Type':'application/json', platform:'h5', ...(() => { const ticket = new URLSearchParams(location.hash.split('?')[1] || '').get('checkinTicket'); return ticket ? {'X-Checkin-Ticket': ticket} : {}; })()},
    body:${JSON.stringify(JSON.stringify(body))}
  }).then(async r => ({ status:r.status, json: await r.json().catch(()=>null) }))`);
  return { body, res };
}

// ------------------------------------------------------------------ 主流程
const { wsUrl, proc } = await launchChrome();
const cdp = await CDP.connect(wsUrl);
const page = await openPage(cdp);
let exitCode = 0;

try {
  await login(page);

  if (cmd === 'login') {
    console.log('>> 登录成功，会话可用。');
  } else {
    await ensureApp(page);
    const st = await fetchState(page);
    const u = st.user?.data?.userData ?? {};
    const rec = st.today?.data ?? {};

    console.log('\n===== 账号 =====');
    console.log(`  ${u.fullName ?? '-'}（${u.username ?? '-'}）`);
    console.log(`  今日状态：${rec.recordStatusCode ?? '-'}`, '| 免打卡：', rec.checkinExemption?.endTime ? '是' : '否');

    const pt = pickPoint(st.locations, st.fence);
    console.log(`  打卡点：${pt ? `${pt.latitude}, ${pt.longitude}（${pt.name ?? pt.source}）` : '无'}`);

    if (cmd === 'probe') {
      console.log('\n===== 原始数据 =====');
      console.log(JSON.stringify({ schedule: st.schedule, today: st.today, locations: st.locations, fence: st.fence }, null, 2));
    } else if (!pt) {
      throw new Error('拿不到围栏坐标，无法打卡');
    } else if (rec.checkinExemption?.endTime) {
      console.log('\n>> 今天在免打卡名单里，无需打卡。');
    } else if (rec.recordStatusCode && rec.recordStatusCode !== 'PENDING' && !cfg.force) {
      console.log(`\n>> 今日已是「${rec.recordStatusCode}」，不重复提交（--force 可强制）。`);
    } else {
      console.log('\n===== 提交打卡 =====');
      const { body, res } = await postCheckin(page, pt);
      console.log('  payload:', JSON.stringify(body));
      console.log('  返回：', JSON.stringify(res, null, 2));
      if (res.json?.code === 0) {
        console.log('\n✅ 打卡成功');
      } else {
        console.log('\n❌ 打卡失败：' + (res.json?.msg ?? '未知错误'));
        exitCode = 2;
      }
      await sleep(1200);
      const after = await page.eval(apiGet('/student-checkin-record/today'));
      console.log('  提交后状态：', after?.data?.recordStatusCode ?? '-');
    }
  }
} catch (e) {
  console.error('\n[错误]', e.message);
  exitCode = 1;
} finally {
  try { await cdp.send('Browser.close'); } catch {}
  await sleep(400);
  cdp.close();
  if (proc) { try { proc.kill(); } catch {} }
  process.exit(exitCode);
}
