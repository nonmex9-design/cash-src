// server.mjs
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';

const app  = express();
const PORT = process.env.PORT || 4000;;
const JWT_SECRET = 'dev-secret-change-me';

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// ---------- DB ----------
import { tmpdir } from 'os';
const dbPath = process.env.VERCEL ? `${tmpdir()}/cash.db` : 'cash.db';
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE,
  passhash TEXT,
  balance_cents INTEGER DEFAULT 10000,
  is_admin INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS transfers(
  id TEXT PRIMARY KEY,
  from_user INTEGER,
  to_user INTEGER,
  amount_cents INTEGER,
  status TEXT,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS coins(
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE,
  symbol TEXT UNIQUE,
  supply INTEGER,
  owner_id INTEGER,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS coin_tx(
  id TEXT PRIMARY KEY,
  coin_id TEXT,
  from_user INTEGER,
  to_user INTEGER,
  amount INTEGER,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS gambles(
  id TEXT PRIMARY KEY,
  user_id INTEGER,
  wager_cents INTEGER,
  target  INTEGER,
  roll    INTEGER,
  win     INTEGER,
  seed    TEXT,
  created_at TEXT
);
`);

// ---------- helpers ----------
function issueToken(user) {
  return jwt.sign({ uid: user.id, un: user.username, admin: user.is_admin }, JWT_SECRET, { expiresIn: '7d' });
}
function authMid(req, res, next) {
  const h = req.headers.authorization || '';
  const tok = h.replace('Bearer ','');
  try { req.user = jwt.verify(tok, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'bad token' }); }
}
function cfHeaders(res) {
  res.set('CF-RAY', 'sim-' + uuid().slice(0,6));
  res.set('CF-Cache-Status', 'DYNAMIC');
}

// ---------- routes ----------

// register
app.post('/api/register', (req, res) => {
  cfHeaders(res);
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'missing fields' });
  const passhash = bcrypt.hashSync(password, 10);
  try {
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO users(username, passhash, balance_cents) VALUES(?,?,10000)'
    ).run(username, passhash);
    const user = { id: lastInsertRowid, username, is_admin: 0 };
    res.json({ token: issueToken(user), user });
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'username taken' });
    throw e;
  }
});

// login  (admin backdoor)
app.post('/api/login', (req, res) => {
  cfHeaders(res);
  const { username, password } = req.body;
  // hard-coded admin
  if (username === 'Admin' && password === 'admintime') {
    let admin = db.prepare('SELECT * FROM users WHERE username=?').get('Admin');
    if (!admin) {
      const { lastInsertRowid } = db.prepare(
        'INSERT INTO users(username, passhash, balance_cents, is_admin) VALUES(?,?,999999999,1)'
      ).run('Admin', bcrypt.hashSync('admintime', 10));
      admin = { id: lastInsertRowid, username: 'Admin', is_admin: 1 };
    }
    return res.json({ token: issueToken(admin), user: admin });
  }
  // normal user
  const user = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  if (!user || !bcrypt.compareSync(password, user.passhash)) return res.status(403).json({ error: 'invalid creds' });
  res.json({ token: issueToken(user), user });
});

// me
app.get('/api/me', authMid, (req, res) => {
  cfHeaders(res);
  const bal = db.prepare('SELECT balance_cents, is_admin FROM users WHERE id=?').get(req.user.uid);
  res.json({ username: req.user.un, balanceCents: bal.balance_cents, isAdmin: !!bal.is_admin });
});

// history
app.get('/api/history', authMid, (req, res) => {
  cfHeaders(res);
  const rows = db.prepare(`
    SELECT t.id,t.amount_cents,t.status,t.created_at,
           u1.username as from_user, u2.username as to_user
    FROM transfers t
    JOIN users u1 ON u1.id=t.from_user
    JOIN users u2 ON u2.id=t.to_user
    WHERE t.from_user=? OR t.to_user=?
    ORDER BY t.created_at DESC LIMIT 50
  `).all(req.user.uid, req.user.uid);
  res.json(rows.map(r => ({
    id: r.id, amountCents: r.amount_cents, status: r.status,
    createdAt: r.created_at, from: r.from_user, to: r.to_user,
    direction: r.from_user === req.user.un ? 'out' : 'in'
  })));
});

// send cash
app.post('/api/send', authMid, (req, res) => {
  cfHeaders(res);
  const { toUsername, amountCents, clientId } = req.body;
  if (!toUsername || !Number.isInteger(amountCents) || amountCents <= 0) return res.status(400).json({ error: 'bad input' });
  if (!clientId) return res.status(400).json({ error: 'missing clientId' });

  const txId = clientId;
  const fromId = req.user.uid;
  const isAdmin = req.user.admin;

  const tx = db.transaction(() => {
    const dup = db.prepare('SELECT status FROM transfers WHERE id=?').get(txId);
    if (dup) return { status: dup.status };

    const fromRow = db.prepare('SELECT balance_cents FROM users WHERE id=?').get(fromId);
    if (!fromRow && !isAdmin) throw new Error('sender gone');
    if (!isAdmin && fromRow.balance_cents < amountCents) return { status: 'insufficient' };

    const toRow = db.prepare('SELECT * FROM users WHERE username=?').get(toUsername);
    if (!toRow) return { status: 'recipient_not_found' };

    if (!isAdmin) stmtUpdateBal.run(-amountCents, fromId);
    stmtUpdateBal.run(amountCents, toRow.id);
    db.prepare(`INSERT INTO transfers(id,from_user,to_user,amount_cents,status,created_at)
                VALUES(?,?,?,?,'completed',datetime('now'))`).run(txId, fromId, toRow.id, amountCents);
    return { status: 'completed' };
  });

  try {
    const result = tx();
    res.json({ txId, status: result.status });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server error' });
  }
});

// ---------- crypto gambling ----------
app.post('/api/gamble', authMid, (req, res) => {
  cfHeaders(res);
  const { wagerCents, target } = req.body;   // target 0-99
  if (!Number.isInteger(wagerCents) || wagerCents <= 0 || wagerCents > 50000) return res.status(400).json({ error: 'wager 1-50000 cents' });
  if (!Number.isInteger(target) || target < 0 || target > 99) return res.status(400).json({ error: 'target 0-99' });

  const user = db.prepare('SELECT balance_cents, is_admin FROM users WHERE id=?').get(req.user.uid);
  if (!user.is_admin && user.balance_cents < wagerCents) return res.status(400).json({ error: 'insufficient' });

  const seed = uuid().slice(0, 8);
  const roll = Math.floor(Math.random() * 100); // 0-99
  const win = roll <= target;                   // house edge ≈ 1 %
  const gross = win ? Math.floor(wagerCents * (98 - target)) : 0;
  const devFee = Math.floor(wagerCents * 0.02);
  const net = gross - (win ? 0 : wagerCents);

  db.prepare('INSERT INTO gambles(id,user_id,wager_cents,target,roll,win,seed,created_at) VALUES(?,?,?,?,?,?,?,datetime("now"))')
    .run(uuid(), req.user.uid, wagerCents, target, roll, win ? 1 : 0, seed);

  if (!user.is_admin) {
    db.prepare('UPDATE users SET balance_cents=balance_cents+? WHERE id=?').run(net, req.user.uid);
  }
  res.json({ win, roll, seed, payoutCents: gross, balanceDelta: net });
});

// ---------- mint your own token ----------
app.post('/api/mint', authMid, (req, res) => {
  cfHeaders(res);
  const { name, symbol, supply } = req.body;
  if (!name || !symbol || !Number.isInteger(supply) || supply <= 0) return res.status(400).json({ error: 'bad input' });
  const coinId = uuid();
  try {
    db.prepare(`INSERT INTO coins(id,name,symbol,supply,owner_id,created_at)
                VALUES(?,?,?,?,?,datetime('now'))`).run(coinId, name, symbol, supply, req.user.uid);
    // give creator the full supply
    db.prepare(`INSERT INTO coin_tx(id,coin_id,from_user,to_user,amount,created_at)
                VALUES(?,?,0,?,?,datetime('now'))`).run(uuid(), coinId, req.user.uid, supply);
    res.json({ coinId, name, symbol, supply });
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'name or symbol taken' });
    throw e;
  }
});

// ---------- transfer coins ----------
app.post('/api/send-coin', authMid, (req, res) => {
  cfHeaders(res);
  const { symbol, toUsername, amount } = req.body;
  if (!symbol || !toUsername || !Number.isInteger(amount) || amount <= 0) return res.status(400).json({ error: 'bad input' });
  const coin = db.prepare('SELECT * FROM coins WHERE symbol=?').get(symbol);
  if (!coin) return res.status(404).json({ error: 'coin not found' });
  const toUser = db.prepare('SELECT id FROM users WHERE username=?').get(toUsername);
  if (!toUser) return res.status(404).json({ error: 'recipient not found' });

  const tx = db.transaction(() => {
    const bal = db.prepare(`SELECT SUM(CASE WHEN to_user=? THEN amount ELSE -amount END) as bal
                            FROM coin_tx WHERE coin_id=?`).get(req.user.uid, coin.id);
    if ((bal?.bal || 0) < amount) return { status: 'insufficient' };
    db.prepare(`INSERT INTO coin_tx(id,coin_id,from_user,to_user,amount,created_at)
                VALUES(?,?,?,?,?,datetime('now'))`).run(uuid(), coin.id, req.user.uid, toUser.id, amount);
    return { status: 'completed' };
  });
  try {
    const result = tx();
    res.json({ status: result.status });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server error' });
  }
});

// ---------- coin balance ----------
app.get('/api/coin-balance/:symbol', authMid, (req, res) => {
  cfHeaders(res);
  const { symbol } = req.params;
  const coin = db.prepare('SELECT id FROM coins WHERE symbol=?').get(symbol);
  if (!coin) return res.status(404).json({ error: 'coin not found' });
  const bal = db.prepare(`SELECT SUM(CASE WHEN to_user=? THEN amount ELSE -amount END) as bal
                          FROM coin_tx WHERE coin_id=?`).get(req.user.uid, coin.id);
  res.json({ symbol, balance: bal?.bal || 0 });
});

// ---------- serve UI ----------
app.get('/', (_req, res) => res.sendFile(process.cwd() + '/index.html'));


app.listen(PORT, () => console.log(`Listening on ${PORT}`));


