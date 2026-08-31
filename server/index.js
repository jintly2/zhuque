require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3003;
const JWT_SECRET = process.env.JWT_SECRET || 'zhuque-dev-secret';

app.use(cors());
app.use(express.json());

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未登录' });
  }
  try {
    const token = header.slice(7);
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.sub;
    req.username = payload.username;
    next();
  } catch {
    return res.status(401).json({ error: '登录已过期' });
  }
}

// ========== 认证 ==========
app.post('/api/auth/signup', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
  if (username.length < 2) return res.status(400).json({ error: '用户名至少2个字符' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少6位' });
  try {
    const existing = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    if (existing.rows.length > 0) return res.status(409).json({ error: '该用户名已被注册' });
    const passwordHash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username',
      [username, passwordHash]
    );
    const user = result.rows[0];
    const token = jwt.sign({ sub: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ user, token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '注册失败' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (result.rows.length === 0) return res.status(401).json({ error: '用户名或密码错误' });
    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: '用户名或密码错误' });
    const token = jwt.sign({ sub: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ user: { id: user.id, username: user.username }, token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '登录失败' });
  }
});

app.get('/api/auth/me', auth, (req, res) => {
  res.json({ id: req.userId, username: req.username });
});

// ========== 持仓 ==========
app.get('/api/positions', auth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM positions WHERE user_id = $1', [req.userId]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: '查询失败' });
  }
});

app.post('/api/positions', auth, async (req, res) => {
  const { symbol, state, in_time, in_price } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO positions (user_id, symbol, state, in_time, in_price, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (user_id, symbol) DO UPDATE SET state = $3, in_time = $4, in_price = $5, updated_at = now()
       RETURNING *`,
      [req.userId, symbol, state || 'out', in_time || null, in_price || null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '保存失败' });
  }
});

app.delete('/api/positions/:symbol', auth, async (req, res) => {
  try {
    await pool.query('DELETE FROM positions WHERE user_id = $1 AND symbol = $2', [req.userId, req.params.symbol]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '删除失败' });
  }
});

// ========== 交易记录 ==========
app.get('/api/trades', auth, async (req, res) => {
  const { symbol } = req.query;
  try {
    let query = 'SELECT * FROM trade_records WHERE user_id = $1';
    const params = [req.userId];
    if (symbol) {
      query += ' AND symbol = $2';
      params.push(symbol);
    }
    query += ' ORDER BY created_at ASC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: '查询失败' });
  }
});

app.post('/api/trades', auth, async (req, res) => {
  const { symbol, in_time, out_time, in_price, out_price, pnl } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO trade_records (user_id, symbol, in_time, out_time, in_price, out_price, pnl)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, symbol, in_time, out_time) DO NOTHING
       RETURNING *`,
      [req.userId, symbol, in_time, out_time || null, in_price || null, out_price || null, pnl || null]
    );
    res.json(result.rows[0] || { success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '保存失败' });
  }
});

app.delete('/api/trades/:symbol', auth, async (req, res) => {
  try {
    await pool.query('DELETE FROM trade_records WHERE user_id = $1 AND symbol = $2', [req.userId, req.params.symbol]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '删除失败' });
  }
});

// ========== 回测记录 ==========
app.get('/api/backtests', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, params, summary, created_at FROM backtest_records WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20',
      [req.userId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: '查询失败' });
  }
});

app.post('/api/backtests', auth, async (req, res) => {
  const { name, params, summary, trades } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO backtest_records (user_id, name, params, summary, trades) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, created_at',
      [req.userId, name || '未命名回测', params || {}, summary || {}, trades || []]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '保存失败' });
  }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`朱雀后端运行在 http://localhost:${PORT}`);
});
