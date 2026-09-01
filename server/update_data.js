#!/usr/bin/env node
/**
 * update_data.js - 朱雀系统 510500 K线数据自动更新脚本
 *
 * 功能：每天收盘后把最新的 15/30/60/240分钟 K线追加到 data/ 下的CSV文件
 * 数据源：腾讯行情接口（免费，无需token）
 * 增量逻辑：读取CSV已有数据，只追加缺失的K线（幂等，不重复下载）
 * 安全保护：当日数据未收盘（<15:05）不追加，避免写入不完整K线
 *
 * 用法：node update_data.js
 * 定时：crontab 每天 15:10 执行
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

const PERIODS = [
  { name: '15m',  csv: '510500_15m_full.csv',  klt: 'm15', type: 'minute' },
  { name: '30m',  csv: '510500_30m_full.csv',  klt: 'm30', type: 'minute' },
  { name: '60m',  csv: '510500_60m_full.csv',  klt: 'm60', type: 'minute' },
  { name: '240m', csv: '510500_240m_full.csv', klt: 'day', type: 'day' },
];

// ---------- HTTP 请求 ----------
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 15000 }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('请求超时')); });
  });
}

// ---------- 北京时间 ----------
function beijingNow() {
  const p = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date());
  const get = t => { const x = p.find(v => v.type === t); return x ? x.value : ''; };
  let h = get('hour');
  if (h === '24') h = '00';
  return `${get('year')}-${get('month')}-${get('day')} ${h}:${get('minute')}`;
}

// ---------- 数据解析 ----------
function parseMinute(raw) {
  // ['202608311430','7.942','7.960','7.970','7.935','482450.000',{},'90.445']
  const t = raw[0];
  const date = `${t.slice(0,4)}-${t.slice(4,6)}-${t.slice(6,8)}`;
  const time = `${t.slice(8,10)}:${t.slice(10,12)}:00`;
  const open = +raw[1], close = +raw[2], high = +raw[3], low = +raw[4];
  const volume = Math.round(+raw[5] * 100); // 手 → 股（与现有CSV单位一致）
  const amount = Math.round(volume * (high + low + close) / 3 * 100) / 100; // 近似成交额
  return { datetime: `${date} ${time}`, date, open, high, low, close, volume, amount };
}
function parseDay(raw) {
  // ['2026-08-31','7.850','7.967','7.978','7.775','4777499.000']
  const date = raw[0];
  const open = +raw[1], close = +raw[2], high = +raw[3], low = +raw[4];
  const volume = Math.round(+raw[5] * 100);
  const amount = Math.round(volume * (high + low + close) / 3 * 100) / 100;
  return { datetime: date, date, open, high, low, close, volume, amount };
}

async function fetchKlines(period) {
  let url;
  if (period.type === 'day') {
    url = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh510500,day,,,30,qfq';
  } else {
    url = `https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=sh510500,${period.klt},,320`;
  }
  const text = await httpGet(url);
  const d = JSON.parse(text);
  const data = d.data && d.data.sh510500;
  if (!data) return [];
  let arr;
  if (period.type === 'day') arr = data.day || data.qfqday || [];
  else arr = data[period.klt] || [];
  return arr.map(raw => period.type === 'day' ? parseDay(raw) : parseMinute(raw));
}

// ---------- 增量更新CSV ----------
function updateCsv(period, klines) {
  const file = path.join(DATA_DIR, period.csv);
  let text = fs.readFileSync(file, 'utf8');
  const hasBom = text.charCodeAt(0) === 0xFEFF;
  if (hasBom) text = text.slice(1);
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const existing = new Set(lines.slice(1).map(l => l.split(',')[0]));

  const [nowDate, nowTime] = beijingNow().split(' ');
  const nowHm = parseInt(nowTime.replace(':', ''));

  let added = 0;
  const newLines = [];
  for (const k of klines) {
    // 当日数据未收盘(<15:05)则跳过，避免写入不完整K线
    if (k.date === nowDate && nowHm < 1505) continue;
    if (existing.has(k.datetime)) continue;
    existing.add(k.datetime);
    newLines.push(`${k.datetime},${k.open},${k.high},${k.low},${k.close},${k.volume},${k.amount}`);
    added++;
  }
  if (added > 0) {
    const output = (hasBom ? '\ufeff' : '') + lines.join('\n') + '\n' + newLines.join('\n') + '\n';
    fs.writeFileSync(file, output);
  }
  return { added, file, last: klines.length ? klines[klines.length - 1].datetime : '' };
}

// ---------- 主流程 ----------
async function main() {
  const ts = beijingNow();
  console.log(`[${ts}] 朱雀510500数据自动更新开始`);
  for (const period of PERIODS) {
    try {
      const klines = await fetchKlines(period);
      if (!klines.length) { console.log(`  [${period.name}] 接口无数据`); continue; }
      const r = updateCsv(period, klines);
      console.log(`  [${period.name}] 新增 ${r.added} 根，最新数据 ${r.last}`);
    } catch (e) {
      console.error(`  [${period.name}] 失败: ${e.message}`);
    }
  }
  console.log('[完成]');
}

main();
