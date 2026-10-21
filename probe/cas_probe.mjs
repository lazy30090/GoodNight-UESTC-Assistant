#!/usr/bin/env node
/**
 * 连通性探针：验证本机能否走完 UESTC 统一身份认证(CAS) 的
 * 取页面 -> 取 execution/pwdEncryptSalt -> 加密密码 -> POST 登录 全流程。
 *
 * 只用一个不存在的假账号，不会触碰真实账号、不会触发锁定。
 */
import crypto from 'node:crypto';

const CAS = 'https://idas.uestc.edu.cn/authserver';
const SERVICE = process.argv[2] || 'https://jzsz.uestc.edu.cn/h5/';
const UA = 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';

const jar = new Map();
function saveCookies(res) {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

// Wisedu CAS: getAesString(randomString(64)+pwd, key=salt, iv=randomString(16))
const AES_CHARS = 'ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678';
const randStr = (n) => Array.from({ length: n }, () => AES_CHARS[Math.floor(Math.random() * AES_CHARS.length)]).join('');

function encryptPassword(password, salt) {
  const data = randStr(64) + password;
  const iv = Buffer.from(randStr(16), 'utf8');
  const key = Buffer.from(salt, 'utf8');
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]).toString('base64');
}

const loginUrl = `${CAS}/login?service=${encodeURIComponent(SERVICE)}`;
console.log('[1] GET', loginUrl);
let res = await fetch(loginUrl, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
saveCookies(res);
const html = await res.text();
console.log('    status =', res.status, '| bytes =', html.length, '| cookies =', [...jar.keys()].join(','));

const execution = html.match(/name="execution"\s+value="([^"]*)"/)?.[1];
const salt = html.match(/id="pwdEncryptSalt"\s+value="([^"]*)"/)?.[1];
console.log('[2] execution =', execution, '| pwdEncryptSalt =', salt);
if (!execution || !salt) { console.log('!! 页面结构变了，未取到关键字段'); process.exit(1); }

const body = new URLSearchParams({
  username: '0000000000',          // 故意用不存在的账号
  password: encryptPassword('probe-not-a-real-password', salt),
  lt: '', execution, _eventId: 'submit',
  cllt: 'userNameLogin', dllt: 'generalLogin', rmShown: '1',
});
console.log('[3] POST', `${CAS}/login?service=${encodeURIComponent(SERVICE)}`);
res = await fetch(`${CAS}/login?service=${encodeURIComponent(SERVICE)}`, {
  method: 'POST',
  headers: {
    'User-Agent': UA,
    'Content-Type': 'application/x-www-form-urlencoded',
    Origin: 'https://idas.uestc.edu.cn',
    Referer: loginUrl,
    Cookie: cookieHeader(),
  },
  body,
  redirect: 'manual',
});
saveCookies(res);
const txt = await res.text();
console.log('    status =', res.status, '| location =', res.headers.get('location') ?? '-', '| bytes =', txt.length);

// 输出服务端返回的提示语（登录失败提示 = 接口通了）
const msg = txt.match(/id="msg"[^>]*>([^<]*)</)?.[1] ?? txt.match(/class="auth_error"[^>]*>([\s\S]{0,120}?)</)?.[1] ?? '';
console.log('    server says:', msg.trim().replace(/\s+/g, ' ') || '(no explicit message)');
console.log('\n结论：拿到 200 + 服务端业务提示 => 本机可以正常与认证服务器双向通信。');
