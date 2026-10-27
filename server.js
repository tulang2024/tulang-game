/**
 * 挂机传奇 · 在线排行榜 + 云端账号存档后端
 * 单端口 HTTP 服务：静态托管游戏 + 排行榜 API + 账号云存档 API
 * 无外部依赖，数据持久化到 rank.json 与 accounts.json
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const DATA_FILE = path.join(__dirname, 'rank.json');
const ACC_FILE = path.join(__dirname, 'accounts.json');
const MARKET_FILE = path.join(__dirname, 'market.json');
const GUILD_FILE = path.join(__dirname, 'guilds.json');
const MAX_FEED = 20;
const ONLINE_TTL = 30000; // 30 秒内有心跳视为在线
const MAX_LISTINGS = 200;   // 交易行挂单上限
const MAX_MAILS = 50;       // 每账号邮件上限
const MAX_PRICE = 999999999; // 单笔价格上限（防刷）
const MAX_GUILDS = 200;     // 全服玩家行会上限
const MAX_GUILD_MEMBERS = 100; // 单行会成员上限
// 官方行会（与前端 GUILD_LIST 保持一致，用于创建重名校验）
// 行会职位（会长唯一，副会长/精英/成员可多名）；顺延优先级 vice > elite > member（同职取最早加入）
const GUILD_ROLES = ['leader', 'vice', 'elite', 'member'];
// 行会技能：key → { 名称, 每级效果, 上限 }；升级消耗建设度 buildCost(lv)=100×1.6^lv
const GUILD_SKILLS = { atk: 1, def: 1, hp: 1, crit: 0.2 }; // 每级：攻/防/血 +1%、暴击 +0.2%
const GUILD_SKILL_MAX = 20;
// 捐赠折算建设度：1000 金 = 1；升星石/铸魂石 1 个 = 5
const GUILD_DONATE = { gold: { need: 1000, gain: 1 }, star: { need: 1, gain: 5 }, zhuhun: { need: 1, gain: 5 } };

let data = { players: {}, feed: [] };
try { data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { /* 首次运行 */ }
if (!data.players) data.players = {};
if (!data.feed) data.feed = [];

// 云端账号：{ acc: { salt, pwdHash, token, save, ts } }
let accounts = {};
try { accounts = JSON.parse(fs.readFileSync(ACC_FILE, 'utf8')); } catch (e) { /* 首次运行 */ }
if (!accounts || typeof accounts !== 'object') accounts = {};

// 交易行：挂单 + 邮件（异步交易，买卖双方无需同时在线）
let market = { seq: 0, listings: [], mails: {} };
try { market = JSON.parse(fs.readFileSync(MARKET_FILE, 'utf8')); } catch (e) { /* 首次运行 */ }
if (!market || typeof market !== 'object') market = { seq: 0, listings: [], mails: {} };
if (!Array.isArray(market.listings)) market.listings = [];
if (!market.mails || typeof market.mails !== 'object') market.mails = {};
if (!market.seq) market.seq = 0;

// 行会注册表：玩家创建的行会（name → { name, leader, lv, members:[{acc,role,ts}], build, skills, ts }）
let guilds = {};
try { guilds = JSON.parse(fs.readFileSync(GUILD_FILE, 'utf8')); } catch (e) { /* 首次运行 */ }
if (!guilds || typeof guilds !== 'object' || Array.isArray(guilds)) guilds = {};
function validGuildName(n) {
  return typeof n === 'string' && n.trim().length >= 1 && n.trim().length <= 10;
}
// 旧档迁移：members 字符串数组 → [{acc, role, ts}] 对象数组；补 build/skills 默认值
function migrateGuild(g) {
  if (!g) return g;
  if (!Array.isArray(g.members)) g.members = [];
  if (g.members.length && typeof g.members[0] === 'string') {
    g.members = g.members.map(acc => ({ acc: acc, role: acc === g.leader ? 'leader' : 'member', ts: g.ts || Date.now() }));
  }
  g.members = g.members.filter(m => m && typeof m.acc === 'string');
  if (!g.members.some(m => m.role === 'leader')) {
    const first = g.members.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0))[0];
    if (first) { first.role = 'leader'; g.leader = first.acc; }
  }
  if (typeof g.build !== 'number' || g.build < 0) g.build = 0;
  if (!g.skills || typeof g.skills !== 'object') g.skills = { atk: 0, def: 0, hp: 0, crit: 0 };
  for (const k in GUILD_SKILLS) if (typeof g.skills[k] !== 'number' || g.skills[k] < 0) g.skills[k] = 0;
  if (!g.joinReq || typeof g.joinReq !== 'object') g.joinReq = { level: 0, power: 0 };
  if (typeof g.joinReq.level !== 'number' || g.joinReq.level < 0) g.joinReq.level = 0;
  if (typeof g.joinReq.power !== 'number' || g.joinReq.power < 0) g.joinReq.power = 0;
  return g;
}
Object.keys(guilds).forEach(k => migrateGuild(guilds[k]));
function guildMembers(g) { return Array.isArray(g.members) ? g.members : []; }
function guildRoleOf(g, acc) { const m = guildMembers(g).find(x => x.acc === acc); return m ? m.role : null; }
function guildPublic(g) {
  return { name: g.name, leader: g.leader, lv: g.lv || 0, members: guildMembers(g).length, ts: g.ts || 0,
    joinReq: g.joinReq || { level: 0, power: 0 } };
}
// 行会详情（成员列表含职位、建设度、技能等级）：公开可读
function guildDetail(g) {
  return {
    name: g.name, leader: g.leader, lv: g.lv || 0, build: g.build || 0,
    skills: { atk: g.skills.atk, def: g.skills.def, hp: g.skills.hp, crit: g.skills.crit },
    joinReq: g.joinReq || { level: 0, power: 0 },
    members: guildMembers(g).map(m => ({ acc: m.acc, role: m.role, ts: m.ts || 0 })).sort((a, b) => (a.ts || 0) - (b.ts || 0)),
    ts: g.ts || 0
  };
}
function guildBuildCost(lv) { return Math.floor(100 * Math.pow(1.6, lv)); }
// 会长退出顺延：副会长（最早）→ 精英 → 成员；返回新会长 acc 或 null（无人可顺延）
function guildSuccessor(g) {
  for (const r of ['vice', 'elite', 'member']) {
    const c = guildMembers(g).filter(m => m.role === r).sort((a, b) => (a.ts || 0) - (b.ts || 0))[0];
    if (c) { c.role = 'leader'; g.leader = c.acc; return c.acc; }
  }
  return null;
}

function persist() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data)); } catch (e) {}
  try { fs.writeFileSync(ACC_FILE, JSON.stringify(accounts)); } catch (e) {}
  try { fs.writeFileSync(MARKET_FILE, JSON.stringify(market)); } catch (e) {}
  try { fs.writeFileSync(GUILD_FILE, JSON.stringify(guilds)); } catch (e) {}
}
setInterval(persist, 5000);

// 排行榜综合分：战力 + 层数*50 + 转生*2000
function score(p) { return Math.floor(p.power + p.depth * 50 + p.reborn * 2000); }

// ---- 交易行工具 ----
function eqName(it){ return (it && it.name) ? it.name : '物品'; }
function matLabel(t, n){ return (t === 'star' ? '🔯升星石' : '💎复活石') + '×' + n; }
function pushMail(acc, text, gold, items, mats){
  market.seq = (market.seq || 0) + 1;
  const mail = { id: market.seq, text: text, gold: gold || 0, items: items || [], mats: mats || {}, ts: Date.now(), read: false, claimed: false };
  if (!market.mails[acc]) market.mails[acc] = [];
  market.mails[acc].unshift(mail);
  if (market.mails[acc].length > MAX_MAILS) market.mails[acc].length = MAX_MAILS;
  return mail;
}
function addFeed(name, text){
  data.feed.unshift({ name: name, text: text, t: Date.now() });
  if (data.feed.length > MAX_FEED) data.feed.length = MAX_FEED;
}

function hashPwd(pwd, salt) {
  return crypto.createHash('sha256').update(pwd + ':' + salt).digest('hex');
}
function validAcc(a) { return typeof a === 'string' && /^[A-Za-z0-9_\u4e00-\u9fa5]{1,12}$/.test(a); }
function validPwd(p) { return typeof p === 'string' && p.length >= 1 && p.length <= 20; }
function sanitizeSave(s) {
  // 仅接受普通对象，剔除函数/原型链等异常值
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
  try { JSON.parse(JSON.stringify(s)); } catch (e) { return null; }
  return s;
}

function send(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(obj));
}
function readBody(req, cb, limit) {
  limit = limit || 8192;
  let b = '';
  req.on('data', c => { b += c; if (b.length > limit) req.destroy(); });
  req.on('end', () => { try { cb(JSON.parse(b || '{}')); } catch (e) { cb({}); } });
}
function validName(n) { return typeof n === 'string' && n.trim().length >= 1 && n.trim().length <= 12; }
function num(v, max) { v = Number(v); return isFinite(v) && v >= 0 ? Math.min(v, max) : 0; }

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;

  // 上报成绩
  if (p === '/api/score' && req.method === 'POST') {
    return readBody(req, b => {
      const name = (b.name || '').toString().trim();
      if (!validName(name)) return send(res, 400, { ok: false, err: 'bad name' });
      const rec = {
        power: num(b.power, 1e13),
        depth: num(b.depth, 1e7),
        reborn: num(b.reborn, 1e5),
        level: num(b.level, 1e4)
      };
      const old = data.players[name];
      if (!old || score(rec) > score(old)) {
        data.players[name] = Object.assign({}, rec, { ts: Date.now() });
      } else {
        old.ts = Date.now(); // 仅刷新在线心跳
      }
      if (b.event && typeof b.event === 'string' && b.event.trim()) {
        data.feed.unshift({ name: name, text: b.event.trim().slice(0, 40), t: Date.now() });
        if (data.feed.length > MAX_FEED) data.feed.length = MAX_FEED;
      }
      persist();
      const arr = Object.keys(data.players).map(k => ({ name: k, s: score(data.players[k]) }))
        .sort((a, b2) => b2.s - a.s);
      const rank = arr.findIndex(x => x.name === name) + 1;
      send(res, 200, { ok: true, rank: rank, total: arr.length });
    });
  }

  // 拉取排行榜
  if (p === '/api/rank' && req.method === 'GET') {
    const now = Date.now();
    const arr = Object.keys(data.players)
      .map(k => Object.assign({ name: k }, data.players[k], { score: score(data.players[k]) }))
      .sort((a, b2) => b2.score - a.score)
      .slice(0, 50);
    const online = Object.keys(data.players)
      .filter(k => now - (data.players[k].ts || 0) < ONLINE_TTL).length;
    return send(res, 200, { players: arr, online: online, feed: data.feed.slice(0, 8) });
  }

  // 健康检查
  if (p === '/api/ping') return send(res, 200, { ok: true });

  // ==================== 云端账号存档 ====================
  // 登录（账号不存在则自动注册）：返回 token + 云端存档
  if (p === '/api/account/login' && req.method === 'POST') {
    return readBody(req, b => {
      const acc = (b.acc || '').toString().trim();
      const pwd = (b.pwd || '').toString();
      if (!validAcc(acc)) return send(res, 400, { ok: false, err: 'bad acc' });
      if (!validPwd(pwd)) return send(res, 400, { ok: false, err: 'bad pwd' });
      let rec = accounts[acc];
      if (rec) {
        if (hashPwd(pwd, rec.salt) !== rec.pwdHash) {
          return send(res, 200, { ok: false, err: 'pwd' });
        }
      } else { // 自动注册
        const salt = crypto.randomBytes(8).toString('hex');
        rec = { salt: salt, pwdHash: hashPwd(pwd, salt), token: crypto.randomBytes(16).toString('hex'), save: null, ts: 0 };
        accounts[acc] = rec;
      }
      persist();
      send(res, 200, { ok: true, token: rec.token, save: rec.save || null, ts: rec.ts || 0, created: !rec.save });
    }, 1024 * 1024);
  }

  // 用 token 恢复会话（换浏览器/设备自动登录）
  if (p === '/api/account/resume' && req.method === 'POST') {
    return readBody(req, b => {
      const acc = (b.acc || '').toString().trim();
      const token = (b.token || '').toString();
      const rec = accounts[acc];
      if (!rec || !token || rec.token !== token) return send(res, 200, { ok: false, err: 'auth' });
      send(res, 200, { ok: true, save: rec.save || null, ts: rec.ts || 0 });
    });
  }

  // 保存存档到云端（token 鉴权）
  if (p === '/api/account/save' && req.method === 'POST') {
    return readBody(req, b => {
      const acc = (b.acc || '').toString().trim();
      const token = (b.token || '').toString();
      const rec = accounts[acc];
      if (!rec || !token || rec.token !== token) return send(res, 200, { ok: false, err: 'auth' });
      const sv = sanitizeSave(b.save);
      if (!sv) return send(res, 400, { ok: false, err: 'bad save' });
      rec.save = sv;
      rec.ts = Date.now();
      persist();
      send(res, 200, { ok: true, ts: rec.ts });
    }, 1024 * 1024);
  }

  // 重置账号：删除云端存档（本地存档一并删除由前端完成）+ 清理其行会
  if (p === '/api/account/reset' && req.method === 'POST') {
    return readBody(req, b => {
      const acc = (b.acc || '').toString().trim();
      const token = (b.token || '').toString();
      const rec = accounts[acc];
      if (!rec || !token || rec.token !== token) return send(res, 200, { ok: false, err: 'auth' });
      delete accounts[acc];
      // 解散其创建的行会，并从所有成员列表中移除
      Object.keys(guilds).forEach(k => { if (guilds[k].leader === acc) delete guilds[k]; });
      Object.keys(guilds).forEach(k => {
        if (guilds[k].members) guilds[k].members = guilds[k].members.filter(x => x && x.acc !== acc);
      });
      persist();
      send(res, 200, { ok: true });
    });
  }

  // 清空角色数据（保留账号，第 19 轮）：存档清零 + 清理其行会；密码/token/注册时间保留，可直接以新角色继续登录
  if (p === '/api/account/wipe' && req.method === 'POST') {
    return readBody(req, b => {
      const acc = (b.acc || '').toString().trim();
      const token = (b.token || '').toString();
      const rec = accounts[acc];
      if (!rec || !token || rec.token !== token) return send(res, 200, { ok: false, err: 'auth' });
      const oldName = rec.save && rec.save.name; // 旧角色名（排行榜按角色名记录）
      rec.save = null; // 角色数据清零（账号主体不动：salt/pwdHash/token/ts 保留，密保与找回不受影响）
      // 同步清除该角色在「全网排行榜」中的记录，否则清空重开后旧名次仍残留
      if (oldName && data.players && data.players[oldName]) delete data.players[oldName];
      // 解散其创建的行会，并从所有成员列表中移除（新角色与旧行会关系一笔勾销）
      Object.keys(guilds).forEach(k => { if (guilds[k].leader === acc) delete guilds[k]; });
      Object.keys(guilds).forEach(k => {
        if (guilds[k].members) guilds[k].members = guilds[k].members.filter(x => x && x.acc !== acc);
      });
      persist();
      send(res, 200, { ok: true });
    });
  }

  // 修改密码：token + 旧密码校验；换新 salt/hash 并轮换 token（其他设备旧会话失效）
  if (p === '/api/account/changepwd' && req.method === 'POST') {
    return readBody(req, b => {
      const acc = (b.acc || '').toString().trim();
      const token = (b.token || '').toString();
      const oldpwd = (b.oldpwd || '').toString();
      const newpwd = (b.newpwd || '').toString();
      const rec = accounts[acc];
      if (!rec || !token || rec.token !== token) return send(res, 200, { ok: false, err: 'auth' });
      if (!validPwd(oldpwd) || !validPwd(newpwd)) return send(res, 400, { ok: false, err: 'bad pwd' });
      if (hashPwd(oldpwd, rec.salt) !== rec.pwdHash) return send(res, 200, { ok: false, err: 'pwd' });
      if (oldpwd === newpwd) return send(res, 200, { ok: false, err: 'same' });
      const salt = crypto.randomBytes(8).toString('hex');
      rec.salt = salt;
      rec.pwdHash = hashPwd(newpwd, salt);
      rec.token = crypto.randomBytes(16).toString('hex'); // 轮换 token：旧会话全部失效
      persist();
      send(res, 200, { ok: true, token: rec.token });
    });
  }

  // 设置/修改密保（登录态）：问题 + 答案；答案用独立盐哈希存储（改密码不影响密保）
  if (p === '/api/account/setsec' && req.method === 'POST') {
    return readBody(req, b => {
      const a = authAcc(b); if (!a) return send(res, 200, { ok: false, err: 'auth' });
      const q = (b.q || '').toString().trim();
      const ans = (b.ans || '').toString().trim();
      if (!q || q.length > 30) return send(res, 200, { ok: false, err: 'bad q' });
      if (!ans || ans.length > 20) return send(res, 200, { ok: false, err: 'bad ans' });
      const rec = accounts[a.acc];
      const salt = crypto.randomBytes(8).toString('hex');
      rec.sec = { q: q, salt: salt, a: hashPwd(ans.toLowerCase(), salt) };
      persist();
      send(res, 200, { ok: true, q: q });
    });
  }

  // 找回密码 ①：查询找回方式（有密保→返回问题；无密保有云端存档→角色名+注册月降级；都没有→无法找回）
  if (p === '/api/account/findpwd_ask' && req.method === 'POST') {
    return readBody(req, b => {
      const acc = (b.acc || '').toString().trim();
      if (!validAcc(acc)) return send(res, 400, { ok: false, err: 'bad acc' });
      const rec = accounts[acc];
      if (!rec) return send(res, 200, { ok: false, err: 'noacc' });
      if (rec.sec && rec.sec.q) return send(res, 200, { ok: true, mode: 'sec', q: rec.sec.q });
      if (rec.save && rec.save.name) return send(res, 200, { ok: true, mode: 'name' });
      return send(res, 200, { ok: true, mode: 'none' });
    });
  }

  // 找回密码 ②：验证并重置密码（重置后返回新 token + 存档，可直接进游戏）
  if (p === '/api/account/findpwd_do' && req.method === 'POST') {
    return readBody(req, b => {
      const acc = (b.acc || '').toString().trim();
      const newpwd = (b.newpwd || '').toString();
      if (!validAcc(acc)) return send(res, 400, { ok: false, err: 'bad acc' });
      if (!validPwd(newpwd)) return send(res, 400, { ok: false, err: 'bad pwd' });
      const rec = accounts[acc];
      if (!rec) return send(res, 200, { ok: false, err: 'noacc' });
      if (rec.sec && rec.sec.q) { // 密保模式：校验答案（不区分大小写）
        const ans = (b.ans || '').toString().trim().toLowerCase();
        if (!ans || hashPwd(ans, rec.sec.salt) !== rec.sec.a) return send(res, 200, { ok: false, err: 'sec' });
      } else if (rec.save && rec.save.name) { // 降级模式：云端角色名 + 注册月份（YYYY-MM）
        const nm = (b.name || '').toString().trim();
        const mon = (b.mon || '').toString().trim();
        const d = new Date(rec.ts || 0);
        const realMon = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2);
        if (nm !== rec.save.name || mon !== realMon) return send(res, 200, { ok: false, err: 'name' });
      } else {
        return send(res, 200, { ok: false, err: 'none' }); // 无云端存档无法找回
      }
      const salt = crypto.randomBytes(8).toString('hex');
      rec.salt = salt;
      rec.pwdHash = hashPwd(newpwd, salt);
      rec.token = crypto.randomBytes(16).toString('hex'); // 轮换 token
      persist();
      send(res, 200, { ok: true, token: rec.token, save: rec.save || null, ts: rec.ts || 0 });
    });
  }

  // ==================== 交易行（邮件寄售：买卖双方无需同时在线） ====================
  function authAcc(b) {
    const acc = (b.acc || '').toString().trim();
    const token = (b.token || '').toString();
    const rec = accounts[acc];
    if (!acc || !rec || !token || rec.token !== token) return null;
    return { acc: acc, save: rec.save };
  }

  // 市场数据 + 我的邮件
  if (p === '/api/market' && req.method === 'GET') {
    const acc = (u.searchParams.get('acc') || '').trim();
    const token = u.searchParams.get('token') || '';
    const rec = accounts[acc];
    if (!acc || !rec || !token || rec.token !== token) return send(res, 200, { ok: false, err: 'auth' });
    return send(res, 200, { ok: true, listings: market.listings.slice(0, MAX_LISTINGS), mails: market.mails[acc] || [] });
  }

  // 挂单出售：装备从背包移除 / 材料从持有扣除，托管进交易行
  if (p === '/api/market/list' && req.method === 'POST') {
    return readBody(req, b => {
      const a = authAcc(b); if (!a) return send(res, 200, { ok: false, err: 'auth' });
      const save = a.save; if (!save) return send(res, 200, { ok: false, err: 'no save' });
      const price = Math.floor(Number(b.price));
      if (!isFinite(price) || price < 1 || price > MAX_PRICE) return send(res, 200, { ok: false, err: 'bad price' });
      if (market.listings.length >= MAX_LISTINGS) return send(res, 200, { ok: false, err: 'market full' });
      market.seq = (market.seq || 0) + 1;
      let listing = null, label = '';
      if (b.kind === 'mat') {
        const t = b.matType === 'star' ? 'star' : 'revive';
        const n = Math.floor(Number(b.count));
        if (!isFinite(n) || n < 1) return send(res, 200, { ok: false, err: 'bad count' });
        if (!save.stones || (save.stones[t] || 0) < n) return send(res, 200, { ok: false, err: 'not enough' });
        save.stones[t] -= n;
        listing = { id: market.seq, seller: a.acc, kind: 'mat', matType: t, count: n, price: price, ts: Date.now() };
        label = matLabel(t, n);
      } else { // equip
        const idx = Math.floor(Number(b.bagIdx));
        if (!isFinite(idx) || idx < 0 || !save.bag || !save.bag[idx]) return send(res, 200, { ok: false, err: 'bad item' });
        const item = save.bag.splice(idx, 1)[0];
        listing = { id: market.seq, seller: a.acc, kind: 'equip', item: item, price: price, ts: Date.now() };
        label = eqName(item);
      }
      market.listings.unshift(listing);
      addFeed(a.acc, '上架 ' + label + '（' + price + '金）');
      persist();
      send(res, 200, { ok: true, id: listing.id, save: save });
    }, 1024 * 1024);
  }

  // 购买：扣买家金币，物品经邮件发货给买家，金币经邮件发给卖家
  if (p === '/api/market/buy' && req.method === 'POST') {
    return readBody(req, b => {
      const a = authAcc(b); if (!a) return send(res, 200, { ok: false, err: 'auth' });
      const save = a.save; if (!save) return send(res, 200, { ok: false, err: 'no save' });
      const id = Math.floor(Number(b.id));
      const li = market.listings.find(x => x.id === id);
      if (!li) return send(res, 200, { ok: false, err: 'gone' });
      if (li.seller === a.acc) return send(res, 200, { ok: false, err: 'own' });
      if ((save.gold || 0) < li.price) return send(res, 200, { ok: false, err: 'no gold' });
      save.gold -= li.price;
      market.listings = market.listings.filter(x => x.id !== id);
      const label = li.kind === 'equip' ? eqName(li.item) : matLabel(li.matType, li.count);
      if (li.kind === 'equip') {
        pushMail(a.acc, '你买下了 ' + li.seller + ' 的 ' + label + '，花费 ' + li.price + ' 金', 0, [li.item], {});
      } else {
        pushMail(a.acc, '你买下了 ' + li.seller + ' 的 ' + label + '，花费 ' + li.price + ' 金', 0, [], { [li.matType]: li.count });
      }
      pushMail(li.seller, a.acc + ' 买下了你的 ' + label + '，获得 ' + li.price + ' 金', li.price, [], {});
      addFeed(a.acc, '买下 ' + li.seller + ' 的 ' + label);
      persist();
      send(res, 200, { ok: true, save: save });
    });
  }

  // 撤单：退回本人邮件
  if (p === '/api/market/cancel' && req.method === 'POST') {
    return readBody(req, b => {
      const a = authAcc(b); if (!a) return send(res, 200, { ok: false, err: 'auth' });
      const save = a.save; if (!save) return send(res, 200, { ok: false, err: 'no save' });
      const id = Math.floor(Number(b.id));
      const li = market.listings.find(x => x.id === id);
      if (!li) return send(res, 200, { ok: false, err: 'gone' });
      if (li.seller !== a.acc) return send(res, 200, { ok: false, err: 'not yours' });
      market.listings = market.listings.filter(x => x.id !== id);
      if (li.kind === 'equip') {
        pushMail(a.acc, '你的 ' + eqName(li.item) + ' 已下架退回', 0, [li.item], {});
      } else {
        pushMail(a.acc, '你的 ' + matLabel(li.matType, li.count) + ' 已下架退回', 0, [], { [li.matType]: li.count });
      }
      persist();
      send(res, 200, { ok: true, save: save });
    });
  }

  // 领取邮件：物品/材料/金币进入存档
  if (p === '/api/mail/claim' && req.method === 'POST') {
    return readBody(req, b => {
      const a = authAcc(b); if (!a) return send(res, 200, { ok: false, err: 'auth' });
      const save = a.save; if (!save) return send(res, 200, { ok: false, err: 'no save' });
      const id = Math.floor(Number(b.id));
      const arr = market.mails[a.acc] || [];
      const m = arr.find(x => x.id === id);
      if (!m || m.claimed) return send(res, 200, { ok: false, err: 'gone' });
      if (!save.bag) save.bag = [];
      if (!save.stones) save.stones = { revive: 0, star: 0 };
      (m.items || []).forEach(it => save.bag.push(it));
      if (m.mats) Object.keys(m.mats).forEach(k => { save.stones[k] = (save.stones[k] || 0) + m.mats[k]; });
      save.gold = (save.gold || 0) + (m.gold || 0);
      m.claimed = true;
      persist();
      send(res, 200, { ok: true, save: save });
    });
  }

  // 邮件全部已读
  if (p === '/api/mail/read' && req.method === 'POST') {
    return readBody(req, b => {
      const a = authAcc(b); if (!a) return send(res, 200, { ok: false, err: 'auth' });
      (market.mails[a.acc] || []).forEach(m => { m.read = true; });
      persist();
      send(res, 200, { ok: true, mails: market.mails[a.acc] || [] });
    });
  }

  // ==================== 行会注册表（玩家创建的行会对全服可见） ====================
  // 行会列表（公开）：官方行会在前端常量里，这里返回全部玩家行会
  if (p === '/api/guild/list' && req.method === 'GET') {
    const arr = Object.keys(guilds).map(k => guildPublic(guilds[k]))
      .sort((a, b) => b.ts - a.ts).slice(0, MAX_GUILDS);
    return send(res, 200, { ok: true, guilds: arr });
  }

  // 行会详情（公开）：成员列表含职位、建设度、行会技能等级
  if (p === '/api/guild/detail' && req.method === 'POST') {
    return readBody(req, b => {
      const name = (b.name || '').toString().trim();
      const g = guilds[name];
      if (!g) return send(res, 200, { ok: false, err: 'gone' });
      return send(res, 200, { ok: true, guild: guildDetail(g) });
    });
  }

  // 创建行会：token 鉴权；重名（官方/已注册）拒绝；名称 1~10 字
  if (p === '/api/guild/create' && req.method === 'POST') {
    return readBody(req, b => {
      const a = authAcc(b); if (!a) return send(res, 200, { ok: false, err: 'auth' });
      const name = (b.name || '').toString().trim();
      if (!validGuildName(name)) return send(res, 200, { ok: false, err: 'bad name' });
      if (guilds[name]) return send(res, 200, { ok: false, err: 'dup' });
      if (Object.keys(guilds).length >= MAX_GUILDS) return send(res, 200, { ok: false, err: 'full' });
      const ts = Date.now();
      guilds[name] = { name: name, leader: a.acc, lv: num(b.lv, 1e4), members: [{ acc: a.acc, role: 'leader', ts: ts }], build: 0, skills: { atk: 0, def: 0, hp: 0, crit: 0 }, joinReq: { level: 0, power: 0 }, ts: ts };
      addFeed(a.acc, '创建了行会「' + name + '」');
      persist();
      send(res, 200, { ok: true, guild: guildDetail(guilds[name]) });
    });
  }

  // 加入行会：登记成员（普通成员职）；返回行会详情（含技能，前端缓存后 buff 生效）
  if (p === '/api/guild/join' && req.method === 'POST') {
    return readBody(req, b => {
      const a = authAcc(b); if (!a) return send(res, 200, { ok: false, err: 'auth' });
      const name = (b.name || '').toString().trim();
      const g = guilds[name];
      if (!g) return send(res, 200, { ok: false, err: 'gone' });
      const req2 = g.joinReq || { level: 0, power: 0 };
      if ((req2.level || 0) > 0 && num(b.lv, 1e9) < (req2.level || 0)) return send(res, 200, { ok: false, err: 'level' });
      if ((req2.power || 0) > 0 && num(b.power, 1e12) < (req2.power || 0)) return send(res, 200, { ok: false, err: 'power' });
      if (!guildMembers(g).some(m => m.acc === a.acc)) {
        if (guildMembers(g).length >= MAX_GUILD_MEMBERS) return send(res, 200, { ok: false, err: 'full' });
        g.members.push({ acc: a.acc, role: 'member', ts: Date.now() });
        persist();
      }
      send(res, 200, { ok: true, guild: guildDetail(g) });
    });
  }

  // 设置加入门槛：会长/副会长可操作；level=最低等级(0~200)，power=最低战力(0~999999999)
  if (p === '/api/guild/setreq' && req.method === 'POST') {
    return readBody(req, b => {
      const a = authAcc(b); if (!a) return send(res, 200, { ok: false, err: 'auth' });
      const name = (b.name || '').toString().trim();
      const g = guilds[name];
      if (!g) return send(res, 200, { ok: false, err: 'gone' });
      const role = guildRoleOf(g, a.acc);
      if (role !== 'leader' && role !== 'vice') return send(res, 200, { ok: false, err: 'denied' });
      let lvl = Math.floor(num(b.level, 200)); if (lvl < 0) lvl = 0; if (lvl > 200) lvl = 200;
      let pw = Math.floor(num(b.power, 999999999)); if (pw < 0) pw = 0; if (pw > 999999999) pw = 999999999;
      g.joinReq = { level: lvl, power: pw };
      persist();
      send(res, 200, { ok: true, guild: guildDetail(g) });
    });
  }

  // 退出行会：移除成员；会长退出自动顺延（副会长→精英→成员，取最早加入）；
  // 最后一名成员退出 → 行会解散（服务端删除，返回 disbanded）
  if (p === '/api/guild/quit' && req.method === 'POST') {
    return readBody(req, b => {
      const a = authAcc(b); if (!a) return send(res, 200, { ok: false, err: 'auth' });
      const name = (b.name || '').toString().trim();
      const g = guilds[name];
      if (!g) return send(res, 200, { ok: true, disbanded: true });
      const wasLeader = g.leader === a.acc;
      g.members = guildMembers(g).filter(m => m.acc !== a.acc);
      if (g.members.length === 0) { delete guilds[name]; persist(); return send(res, 200, { ok: true, disbanded: true }); }
      if (wasLeader) guildSuccessor(g); // 会长退出 → 顺延（guildSuccessor 内部改 leader/role）
      persist();
      send(res, 200, { ok: true, disbanded: false, newLeader: g.leader, guild: guildDetail(g) });
    });
  }

  // 任命职位：仅会长可操作；不能操作自己；目标必须是行会成员
  if (p === '/api/guild/role' && req.method === 'POST') {
    return readBody(req, b => {
      const a = authAcc(b); if (!a) return send(res, 200, { ok: false, err: 'auth' });
      const name = (b.name || '').toString().trim();
      const g = guilds[name];
      if (!g) return send(res, 200, { ok: false, err: 'gone' });
      if (g.leader !== a.acc) return send(res, 200, { ok: false, err: 'denied' });
      const target = (b.target || '').toString();
      if (target === a.acc) return send(res, 200, { ok: false, err: 'self' });
      const role = (b.role || '').toString();
      if (GUILD_ROLES.indexOf(role) < 0 || role === 'leader') return send(res, 200, { ok: false, err: 'bad role' });
      const m = guildMembers(g).find(x => x.acc === target);
      if (!m) return send(res, 200, { ok: false, err: 'gone' });
      m.role = role;
      persist();
      send(res, 200, { ok: true, guild: guildDetail(g) });
    });
  }

  // 捐赠行会建设：本地扣资源后上报，服务端累加建设度并返回最新 build/skills
  if (p === '/api/guild/donate' && req.method === 'POST') {
    return readBody(req, b => {
      const a = authAcc(b); if (!a) return send(res, 200, { ok: false, err: 'auth' });
      const name = (b.name || '').toString().trim();
      const g = guilds[name];
      if (!g) return send(res, 200, { ok: false, err: 'gone' });
      if (!guildMembers(g).some(m => m.acc === a.acc)) return send(res, 200, { ok: false, err: 'denied' });
      const kind = (b.kind || '').toString();
      const n = Math.floor(num(b.n, 1e9)); // 单次捐赠数量上限 10 亿（防异常值）
      const rule = GUILD_DONATE[kind];
      if (!rule || n < rule.need) return send(res, 200, { ok: false, err: 'bad' });
      g.build = (g.build || 0) + Math.floor(n / rule.need) * rule.gain;
      persist();
      send(res, 200, { ok: true, build: g.build, skills: g.skills });
    });
  }

  // 升级行会技能：会长/副会长可操作；消耗建设度 buildCost(lv)=100×1.6^lv；上限 20 级
  if (p === '/api/guild/skill' && req.method === 'POST') {
    return readBody(req, b => {
      const a = authAcc(b); if (!a) return send(res, 200, { ok: false, err: 'auth' });
      const name = (b.name || '').toString().trim();
      const g = guilds[name];
      if (!g) return send(res, 200, { ok: false, err: 'gone' });
      const role = guildRoleOf(g, a.acc);
      if (role !== 'leader' && role !== 'vice') return send(res, 200, { ok: false, err: 'denied' });
      const key = (b.key || '').toString();
      if (!Object.prototype.hasOwnProperty.call(GUILD_SKILLS, key)) return send(res, 200, { ok: false, err: 'bad' });
      const lv = g.skills[key] || 0;
      if (lv >= GUILD_SKILL_MAX) return send(res, 200, { ok: false, err: 'max' });
      const cost = guildBuildCost(lv);
      if ((g.build || 0) < cost) return send(res, 200, { ok: false, err: 'poor' });
      g.build -= cost; g.skills[key] = lv + 1;
      persist();
      send(res, 200, { ok: true, build: g.build, skills: g.skills });
    });
  }

  // 静态文件
  let file = p === '/' ? '/index.html' : p;
  file = decodeURIComponent(file.split('?')[0]);
  const fp = path.join(__dirname, path.normalize(file).replace(/^(\.\.[\/\\])+/, ''));
  if (!fp.startsWith(__dirname)) { res.writeHead(403); return res.end(); }
  fs.readFile(fp, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(fp).toLowerCase();
    const ct = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': ct });
    res.end(buf);
  });
});

// 兜底：任何未预期错误都不拖垮整服（排行榜为非关键功能，容错继续）
process.on('uncaughtException', function(e){ console.error('uncaughtException:', e && e.message); });

server.listen(PORT, HOST, () => console.log('guaji-legend server listening on ' + HOST + ':' + PORT));
