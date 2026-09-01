#!/usr/bin/env node
/**
 * 服务端快照抓取脚本（GitHub Actions 定时运行）
 * =================================================
 * 全看板数据改为"双时间点快照"：每天北京时间 12:00 抓上午收盘（11:30）、15:15 抓收盘（15:00）
 * 产出 snapshot.json，前端只读该静态文件 → 浏览器零第三方请求、彻底规避东财/腾讯接口风控
 *
 * 数据源（服务端低频调用，风控风险低）：
 *   指数        = 腾讯 qt.gtimg.cn（实时，GBK）
 *   涨跌家数     = 东财延迟 ulist
 *   板块/个股榜  = 东财延迟 clist
 *   周期热榜     = 池列表/成分股(东财延迟 clist) + 日K(东财push2his多域名，腾讯兜底)
 *   行业低估推荐 = 行业列表/成分股估值(东财延迟 clist)
 *   涨跌停       = 东财 push2ex
 *
 * 依赖：Node 18+（内置 fetch / TextDecoder）。无第三方包。
 */
"use strict";

const fs = require("fs");
const path = require("path");

const BASE = "https://push2delay.eastmoney.com/api/qt/";
const QT_INDEX = "https://qt.gtimg.cn/q=";
const TX_INDEX_CODES = ["sh000001", "sz399001", "sz399006", "sh000300", "sh000688", "bj899050"];
const PUSH2EX = "https://push2ex.eastmoney.com/";
const UT = "7eea3edcaed734bea9cbfc24409ed989";
const EM_HIS_HOSTS = ["push2his.eastmoney.com", "16.push2his.eastmoney.com", "17.push2his.eastmoney.com",
  "18.push2his.eastmoney.com", "19.push2his.eastmoney.com", "20.push2his.eastmoney.com",
  "21.push2his.eastmoney.com", "22.push2his.eastmoney.com", "23.push2his.eastmoney.com"];
const TX_KLINE = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get";

const IDX_LIST = [
  {secid: "1.000001", name: "上证指数"},
  {secid: "0.399001", name: "深证成指"},
  {secid: "0.399006", name: "创业板指"},
  {secid: "1.000300", name: "沪深300"},
  {secid: "1.000688", name: "科创50"},
  {secid: "0.899050", name: "北证50"}
];

const POOL_CFG = {
  industry: {fs: "m:90+t:2+f:!50", n: 60},
  concept:  {fs: "m:90+t:3+f:!50", n: 150},
  stock:    {fs: "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23", n: 300}
};
const POOL_BAN = ["融资融券","深股通","沪股通","富时","MSCI","标普","AH股","转融","中字头","机构重仓",
  "QFII","证金","汇金","央视","沪港深","深港通","两融","基金重仓","社保重仓","保险重仓","券商重仓",
  "msci","罗素","国企改革","央国企","破净","低价股","微盘股","预盈预增","预亏预减","股权激励",
  "转债","可转债","独角兽","次新股","壳资源","退市","ST板块","昨日涨停","昨日连板","昨日触板"];
const PERIODS = {m1: {bars: 22}, m3: {bars: 64}, m6: {bars: 125}, y1: {bars: 245}};
const PERIOD_KEYS = ["m1", "m3", "m6", "y1"];

const IND_CFG = {
  incN: 25, stkN: 20, memberN: 80, mcapMin: 5e9, topInc: 5, topStk: 5, maxOverlap: 2
};

// ---------------- 北京时区工具 ----------------
// 固定 +8 偏移（时区无关）：任何系统时区下都正确
function bjParts(){
  const bj = new Date(Date.now() + 8 * 3600 * 1000);
  return {y: bj.getUTCFullYear(), mo: bj.getUTCMonth() + 1, dd: bj.getUTCDate(),
    dow: bj.getUTCDay(), hh: bj.getUTCHours(), mm: bj.getUTCMinutes()};
}
function dlOf(y, mo, dd){ return y + "-" + ("0"+mo).slice(-2) + "-" + ("0"+dd).slice(-2); }
function prevTradingDate(y, mo, dd){
  const x = new Date(Date.UTC(y, mo - 1, dd));
  do { x.setUTCDate(x.getUTCDate() - 1); } while(x.getUTCDay() === 0 || x.getUTCDay() === 6);
  return {y: x.getUTCFullYear(), mo: x.getUTCMonth() + 1, dd: x.getUTCDate()};
}
// 与前端 snapNow 完全一致：mid=上午收盘快照(11:30-15:00)，close=收盘快照(15:00后→当日，盘前/上午→上一交易日，周末→周五)
function snapNow(){
  const p = bjParts(), t = p.hh * 60 + p.mm;
  if(p.dow === 0 || p.dow === 6){
    const f = prevTradingDate(p.y, p.mo, p.dd);
    return "close:" + dlOf(f.y, f.mo, f.dd);
  }
  if(t >= 11*60+30 && t < 15*60) return "mid:" + dlOf(p.y, p.mo, p.dd);
  if(t >= 15*60) return "close:" + dlOf(p.y, p.mo, p.dd);
  const f = prevTradingDate(p.y, p.mo, p.dd);
  return "close:" + dlOf(f.y, f.mo, f.dd);
}
function snapLabel(snap){
  return snap.indexOf("mid:") === 0 ? "上午收盘快照（11:30）" : "收盘快照（15:00）";
}
function dateStr(offsetDays, sep){
  const p = bjParts();
  const d = new Date(Date.UTC(p.y, p.mo - 1, p.dd));
  d.setUTCDate(d.getUTCDate() - offsetDays);
  const y = d.getUTCFullYear(), m = ("0"+(d.getUTCMonth()+1)).slice(-2), dd = ("0"+d.getUTCDate()).slice(-2);
  return sep ? (y + "-" + m + "-" + dd) : (y + m + dd);
}

// ---------------- HTTP 封装 ----------------
const UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Referer": "https://quote.eastmoney.com/"};
async function getJSON(url, ms){
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms || 20000);
  try{
    const r = await fetch(url, {headers: UA, signal: ctl.signal});
    if(!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  }finally{ clearTimeout(timer); }
}
async function getJSONMulti(urls){
  let last = null;
  for(const u of urls){
    try{ return await getJSON(u); }catch(e){ last = e; }
  }
  throw last || new Error("all hosts failed");
}
async function fetchBuf(url, ms){
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms || 20000);
  try{
    const r = await fetch(url, {headers: {"User-Agent": "Mozilla/5.0"}, signal: ctl.signal});
    if(!r.ok) throw new Error("HTTP " + r.status);
    return await r.arrayBuffer();
  }finally{ clearTimeout(timer); }
}
// 通用并发限流
async function runPool(items, worker, concurrency){
  let idx = 0;
  async function run(){
    while(idx < items.length){
      const i = idx++;
      try{ await worker(items[i], i); }catch(e){ /* 单条失败跳过 */ }
    }
  }
  const ws = [];
  for(let i = 0; i < Math.min(concurrency, items.length); i++) ws.push(run());
  await Promise.all(ws);
}

// ---------------- 指数（腾讯实时，GBK） ----------------
async function loadIndices(){
  try{
    const buf = await fetchBuf(QT_INDEX + TX_INDEX_CODES.join(","));
    const txt = new TextDecoder("gbk").decode(buf);
    const lines = txt.split(";");
    const out = [];
    TX_INDEX_CODES.forEach((key, i) => {
      const line = lines[i] || "";
      const a = line.indexOf('="');
      if(a < 0) return;
      const body = line.slice(a + 2, line.lastIndexOf('"'));
      const f = body.split("~");
      if(f.length < 33 || !f[3]) return;
      out.push({f12: f[2], f14: IDX_LIST[i].name, f2: parseFloat(f[3]),
        f4: parseFloat(f[31]), f3: parseFloat(f[32])});
    });
    if(out.length) return out;
    throw new Error("tx index empty");
  }catch(e){
    const secids = IDX_LIST.map(x => x.secid).join(",");
    const res = await getJSON(BASE + "ulist.np/get?fltt=2&invt=2&fields=f2,f3,f4,f6,f12,f14,f104,f105,f106&secids=" + secids);
    if(!res || !res.data || !res.data.diff) return [];
    return res.data.diff;
  }
}

// ---------------- 涨跌家数 ----------------
async function loadBreadth(){
  const secids = IDX_LIST.map(x => x.secid).join(",");
  const res = await getJSON(BASE + "ulist.np/get?fltt=2&invt=2&fields=f2,f3,f4,f6,f12,f14,f104,f105,f106&secids=" + secids);
  return (res && res.data && res.data.diff) || [];
}

// ---------------- 板块/个股当日榜 ----------------
async function loadSectors(kind){
  const fs = kind === "industry" ? "m:90+t:2+f:!50" : "m:90+t:3+f:!50";
  const res = await getJSON(BASE + "clist/get?pn=1&pz=30&po=1&np=1&fltt=2&invt=2&fid=f3&fs=" + fs + "&fields=f2,f3,f12,f14");
  return (res && res.data && res.data.diff) || [];
}
async function loadStocks(desc){
  const fs = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23";
  const res = await getJSON(BASE + "clist/get?pn=1&pz=20&po=" + (desc ? 1 : 0) + "&np=1&fltt=2&invt=2&fid=f3&fs=" + fs + "&fields=f2,f3,f6,f12,f14");
  return (res && res.data && res.data.diff) || [];
}

// ---------------- 涨跌停 ----------------
async function loadZtDt(){
  const date = dateStr(0, "");
  const ztUrl = PUSH2EX + "getTopicZTPool?ut=" + UT + "&dpt=wz.ztzt&Pageindex=0&pagesize=1&sort=fbt:asc&date=" + date;
  const dtUrl = PUSH2EX + "getTopicDTPool?ut=" + UT + "&dpt=wz.ztzt&Pageindex=0&pagesize=1&sort=fund:asc&date=" + date;
  const zt = await getJSON(ztUrl).then(r => (r && r.data && typeof r.data.tc === "number") ? r.data.tc : null).catch(() => null);
  const dt = await getJSON(dtUrl).then(r => (r && r.data && typeof r.data.tc === "number") ? r.data.tc : null).catch(() => null);
  return [zt, dt];
}

// ---------------- 周期热榜 ----------------
function txSecCode(code){
  const c0 = code.charAt(0);
  if(c0 === "6" || c0 === "9" || c0 === "5") return "sh" + code;
  if(c0 === "0" || c0 === "3" || c0 === "2") return "sz" + code;
  return "bj" + code;
}
async function fetchKlineEM(secid){
  const beg = dateStr(370, ""), end = dateStr(0, "");
  const p = "/api/qt/stock/kline/get?secid=" + secid + "&klt=101&fqt=1&lmt=0&beg=" + beg + "&end=" + end
    + "&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61";
  const res = await getJSONMulti(EM_HIS_HOSTS.map(h => "https://" + h + p));
  const klines = res && res.data && res.data.klines;
  if(!klines || !klines.length) throw new Error("em empty kline");
  return klines.map(s => {
    const a = s.split(",");
    return {d: a[0], o: parseFloat(a[1]), c: parseFloat(a[2]), h: parseFloat(a[3]), l: parseFloat(a[4]),
      v: parseFloat(a[5]), amt: parseFloat(a[6]), pct: parseFloat(a[8])};
  });
}
async function fetchKlineTX(code){
  const beg = dateStr(370, "-"), end = dateStr(0, "-");
  const key = txSecCode(code);
  const res = await getJSON(TX_KLINE + "?param=" + key + ",day," + beg + "," + end + ",320,qfq", 15000);
  const d = (res && res.data && (res.data[key] || res.data[code])) || {};
  const arr = d.qfqday || d.day || [];
  if(!arr.length) throw new Error("tx empty kline");
  const out = [];
  let prevC = null;
  arr.forEach(k => {
    const c = parseFloat(k[2]);
    out.push({d: k[0], o: parseFloat(k[1]), c: c, h: parseFloat(k[3]), l: parseFloat(k[4]),
      v: parseFloat(k[5]), amt: 0, pct: prevC ? (c - prevC) / prevC * 100 : 0});
    prevC = c;
  });
  return out;
}
// 新浪日K（JSONP 剥壳；不复权，无成交额 → amt=0，calcStats 用成交量兜底；最终兜底源，实测最稳）
async function fetchKlineSINA(code){
  const sym = txSecCode(code);
  const u = "https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20_sinaK=/CN_MarketDataService.getKLineData?symbol="
    + sym + "&scale=240&ma=no&datalen=320";
  const r = await fetch(u, {headers: {"User-Agent": "Mozilla/5.0"}, signal: AbortSignal.timeout(15000)});
  if(!r.ok) throw new Error("sina HTTP " + r.status);
  const txt = await r.text();
  const m = txt.match(/\((\[.*\])\)/s);
  if(!m) throw new Error("sina bad payload");
  const data = JSON.parse(m[1]);
  if(!data || !data.length) throw new Error("sina empty kline");
  const out = [];
  let prevC = null;
  data.forEach(k => {
    const c = parseFloat(k.close);
    out.push({d: k.day, o: parseFloat(k.open), c: c, h: parseFloat(k.high), l: parseFloat(k.low),
      v: parseFloat(k.volume), amt: 0, pct: prevC ? (c - prevC) / prevC * 100 : 0});
    prevC = c;
  });
  return out;
}
// 东财历史K线优先（含成交额、字段全）→ 腾讯 → 新浪，三级兜底
function secidOf(code){
  const c0 = code.charAt(0);
  if(c0 === "6" || c0 === "9" || c0 === "5") return "1." + code;
  return "0." + code;
}
async function fetchKline(code){
  try{ return await fetchKlineEM(secidOf(code)); }
  catch(e){
    try{ return await fetchKlineTX(code); }
    catch(e2){ return await fetchKlineSINA(code); }
  }
}

async function fetchPoolList(key){
  const cfg = POOL_CFG[key];
  const pages = key === "stock" ? 5 : 1;
  const tasks = [];
  for(let p = 1; p <= pages; p++){
    tasks.push(getJSON(BASE + "clist/get?pn=" + p + "&pz=100&po=1&np=1&fltt=2&invt=2&fid=f6&fs="
      + cfg.fs + "&fields=f2,f3,f6,f12,f13,f14"));
  }
  const rs = await Promise.all(tasks);
  const list = [];
  const seen = {};
  rs.forEach(r => {
    if(r && r.data && r.data.diff) r.data.diff.forEach(it => {
      if(seen[it.f12]) return;
      seen[it.f12] = 1;
      if(key !== "stock" && POOL_BAN.some(b => it.f14 && it.f14.indexOf(b) >= 0)) return;
      list.push(it);
    });
  });
  return list.slice(0, cfg.n);
}
async function fetchBoardMembers(bk, n){
  const res = await getJSON(BASE + "clist/get?pn=1&pz=" + n + "&po=1&np=1&fltt=2&invt=2&fid=f6&fs=b:" + bk
    + "&fields=f2,f3,f6,f12,f14");
  return (res && res.data && res.data.diff) || [];
}

function calcStats(k, periodKey){
  const bars = PERIODS[periodKey].bars;
  const n = k.length;
  if(n < 3) return null;
  const cnt = Math.min(bars, n - 1);
  const base = k[n - 1 - cnt].c;
  const last = k[n - 1].c;
  const chg = (last - base) / base * 100;
  let upDays = 0, bigDays = 0, sumAmt = 0;
  for(let i = n - 1 - cnt; i < n; i++){
    if(k[i].pct > 0) upDays++;
    if(k[i].pct >= 5) bigDays++;
    sumAmt += k[i].amt > 0 ? k[i].amt : k[i].v;
  }
  return {chg: chg, upDays: upDays, days: cnt, freq: upDays / cnt * 100, bigDays: bigDays,
    amtAvg: cnt > 0 ? sumAmt / cnt : 0};
}
function buildBoardStats(members, periodKey){
  const stats = [];
  let wsum = 0;
  members.forEach(x => {
    const st = calcStats(x.e.k, periodKey);
    if(st){ stats.push({m: x.m, st: st}); wsum += (x.m.f6 || 0); }
  });
  if(!stats.length) return null;
  stats.forEach(x => { x.w = wsum > 0 ? (x.m.f6 || 0) / wsum : 1 / stats.length; });
  let chg = 0, up = 0, freq = 0, big = 0, amtSum = 0;
  stats.forEach(x => {
    chg += x.w * x.st.chg; up += x.w * x.st.upDays; freq += x.w * x.st.freq;
    big += x.w * x.st.bigDays; amtSum += (x.m.f6 || 0);
  });
  return {chg: chg, upDays: up, days: stats[0].st.days, freq: freq, bigDays: big,
    amtAvg: amtSum, members: stats.length};
}

// 池子 → K线 → 4周期 stats（结构与前端 periodState.caches[pool] 一致：{list, stats:{m1,m3,m6,y1}}）
async function buildPeriodPool(key){
  const list = await fetchPoolList(key);
  const out = {list: list, stats: {m1: [], m3: [], m6: [], y1: []}};
  const klineCache = {};
  if(key === "stock"){
    await runPool(list, async it => {
      if(!klineCache[it.f12]) klineCache[it.f12] = await fetchKline(it.f12).catch(() => null);
      const k = klineCache[it.f12];
      if(!k) return;
      PERIOD_KEYS.forEach(p => {
        const st = calcStats(k, p);
        if(st) out.stats[p].push({code: it.f12, name: it.f14, st: st, amt: it.f6 || 0});
      });
    }, 8);
  } else {
    const boards = {};
    await runPool(list, async it => {
      const members = await fetchBoardMembers(it.f12, 8).catch(() => []);
      if(!members.length) return;
      const entries = [];
      await runPool(members, async m => {
        if(!klineCache[m.f12]) klineCache[m.f12] = await fetchKline(m.f12).catch(() => null);
        if(klineCache[m.f12]) entries.push({m: m, e: {k: klineCache[m.f12]}});
      }, 6);
      if(entries.length) boards[it.f12] = {name: it.f14, code: it.f12, members: entries};
    }, 4);
    Object.keys(boards).forEach(bk => {
      const b = boards[bk];
      PERIOD_KEYS.forEach(p => {
        const st = buildBoardStats(b.members, p);
        if(st) out.stats[p].push({code: bk, name: b.name, st: st, amt: st.amtAvg});
      });
    });
  }
  return out;
}

// ---------------- 行业低估推荐 ----------------
function indCls(f25){ if(f25 == null) return "dec"; if(f25 >= 10) return "inc"; if(f25 <= -10) return "dec"; return "stk"; }
function isBadName(name){ return name.indexOf("ST") >= 0 || name.indexOf("退") >= 0; }
function isNonACode(code){ const c0 = code.charAt(0); return c0 === "2" || c0 === "9" || c0 === "4" || c0 === "8"; }
function overlapCount(a, b){ return a.picks.filter(x => b.picks.some(y => y.code === x.code)).length; }

async function loadIndCandidates(){
  const res = await getJSON(BASE + "clist/get?pn=1&pz=200&po=1&np=1&fltt=2&invt=2&fid=f6&fs=" + "m:90+t:2+f:!50"
    + "&fields=f2,f3,f6,f12,f14,f24,f25");
  let all = (res && res.data && res.data.diff) || [];
  all = all.filter(it => !/[ⅡⅢⅣⅤ]/.test(it.f14) && it.f14.indexOf("其他") !== 0);
  const inc = [], stk = [];
  all.forEach(it => {
    const k = indCls(it.f25);
    if(k === "inc") inc.push(it); else if(k === "stk") stk.push(it);
  });
  inc.sort((a, b) => (b.f25 || 0) - (a.f25 || 0));
  stk.sort((a, b) => (b.f6 || 0) - (a.f6 || 0));
  return {inc: inc.slice(0, IND_CFG.incN), stk: stk.slice(0, IND_CFG.stkN)};
}
async function loadIndMembers(bk){
  const res = await getJSON(BASE + "clist/get?pn=1&pz=" + IND_CFG.memberN + "&po=1&np=1&fltt=2&invt=2&fid=f6&fs=b:" + bk.f12
    + "&fields=f2,f3,f6,f9,f12,f14,f20,f23");
  const list = (res && res.data && res.data.diff) || [];
  const rows = [];
  list.forEach(it => {
    const pe = it.f9, pb = it.f23, mc = it.f20;
    if(!it.f14 || isBadName(it.f14) || isNonACode(it.f12)) return;
    if(!(pe > 0 && pb > 0 && mc >= IND_CFG.mcapMin)) return;
    rows.push({code: it.f12, name: it.f14, px: it.f2, pct: it.f3, pe: pe, pb: pb, mc: mc});
  });
  if(rows.length < 3) return null;
  const norm = v => {
    const mn = Math.min(...v), mx = Math.max(...v);
    if(mx === mn) return v.map(() => 50);
    return v.map(x => (x - mn) / (mx - mn) * 100);
  };
  const peN = norm(rows.map(r => r.pe)), pbN = norm(rows.map(r => r.pb));
  rows.forEach((r, i) => { r.vscore = 0.5 * peN[i] + 0.5 * pbN[i]; });
  rows.sort((a, b) => a.vscore - b.vscore);
  const picks = rows.slice(0, 3);
  const absN = rows.filter(r => r.pe <= 30 && r.pb <= 3).length;
  const avgPE = (picks[0].pe + picks[1].pe + picks[2].pe) / 3;
  return {bk: bk, picks: picks, n: rows.length, absN: absN, avgPE: avgPE};
}
function buildIndGroups(groups){
  const incG = [], stkG = [];
  groups.forEach(g => {
    if(indCls(g.bk.f25) === "inc") incG.push(g); else if(indCls(g.bk.f25) === "stk") stkG.push(g);
  });
  incG.sort((a, b) => a.avgPE - b.avgPE);
  stkG.sort((a, b) => a.avgPE - b.avgPE);
  function pick(list, n){
    const out = [];
    for(let i = 0; i < list.length && out.length < n; i++){
      const g = list[i];
      if(!out.some(o => overlapCount(o, g) >= IND_CFG.maxOverlap)) out.push(g);
    }
    return out;
  }
  const out = pick(incG, IND_CFG.topInc).concat(pick(stkG, IND_CFG.topStk));
  if(out.length < IND_CFG.topInc + IND_CFG.topStk){
    const rest = groups.filter(g => out.indexOf(g) < 0).sort((a, b) => a.avgPE - b.avgPE);
    let i = 0;
    while(out.length < IND_CFG.topInc + IND_CFG.topStk && i < rest.length){
      const g = rest[i++];
      if(out.some(o => overlapCount(o, g) >= IND_CFG.maxOverlap)) continue;
      out.push(g);
    }
  }
  return out.slice(0, IND_CFG.topInc + IND_CFG.topStk);
}
async function buildIndVal(){
  const cand = await loadIndCandidates();
  const list = cand.inc.concat(cand.stk);
  const groups = [];
  await runPool(list, async bk => {
    const g = await loadIndMembers(bk).catch(() => null);
    if(g) groups.push(g);
  }, 8);
  return {groups: buildIndGroups(groups)};
}

// ---------------- 主流程 ----------------
async function main(){
  const snap = snapNow();
  const p = bjParts();
  const now = dlOf(p.y, p.mo, p.dd) + " " + ("0"+p.hh).slice(-2) + ":" + ("0"+p.mm).slice(-2);
  const out = {
    meta: {snap: snap, snapLabel: snapLabel(snap), generatedAt: now},
    idx: [], breadth: [], secInd: [], secCon: [], gain: [], loss: [], ztdt: [null, null],
    period: {}, indVal: {groups: []}
  };
  console.log("[" + now + "] snap=" + snap + " 开始抓取…");

  const t0 = Date.now();
  // 轻量模块并行
  await Promise.all([
    loadIndices().then(v => { out.idx = v; console.log("  指数:", v.length); }).catch(e => console.log("  指数失败:", e.message)),
    loadBreadth().then(v => { out.breadth = v; console.log("  涨跌家数:", v.length); }).catch(e => console.log("  涨跌家数失败:", e.message)),
    loadSectors("industry").then(v => { out.secInd = v; console.log("  行业板块榜:", v.length); }).catch(e => console.log("  行业板块榜失败:", e.message)),
    loadSectors("concept").then(v => { out.secCon = v; console.log("  概念板块榜:", v.length); }).catch(e => console.log("  概念板块榜失败:", e.message)),
    loadStocks(true).then(v => { out.gain = v; console.log("  涨幅榜:", v.length); }).catch(e => console.log("  涨幅榜失败:", e.message)),
    loadStocks(false).then(v => { out.loss = v; console.log("  跌幅榜:", v.length); }).catch(e => console.log("  跌幅榜失败:", e.message)),
    loadZtDt().then(v => { out.ztdt = v; console.log("  涨跌停:", v[0], "/", v[1]); }).catch(e => console.log("  涨跌停失败:", e.message))
  ]);

  // 周期热榜（重，串行跑3个池）
  for(const key of ["industry", "concept", "stock"]){
    try{
      const pool = await buildPeriodPool(key);
      const n = pool.stats.m3.length;
      out.period[key] = pool;
      console.log("  周期热榜[" + key + "]: 候选" + pool.list.length + " m3有效" + n);
    }catch(e){ console.log("  周期热榜[" + key + "]失败:", e.message); }
  }

  // 行业低估推荐
  try{
    out.indVal = await buildIndVal();
    console.log("  行业低估推荐: " + out.indVal.groups.length + " 个行业");
  }catch(e){ console.log("  行业低估推荐失败:", e.message); }

  const file = path.join(__dirname, "..", "snapshot.json");
  fs.writeFileSync(file, JSON.stringify(out));
  console.log("完成，耗时 " + ((Date.now() - t0) / 1000).toFixed(1) + "s → " + file + " (" + fs.statSync(file).size + " bytes)");
}

if(require.main === module){
  main().catch(e => { console.error("FATAL:", e); process.exit(1); });
}
module.exports = {snapNow, buildPeriodPool, fetchPoolList, fetchKline, loadIndCandidates, loadIndMembers, buildIndGroups, calcStats, buildBoardStats};
