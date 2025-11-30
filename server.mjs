import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { Database } from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const JWT_SECRET = 'supersecretkey1337';
const dbPath = process.env.VERCEL ? '/tmp/cash.db' : './cash.db';
const db = new Database(dbPath);

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    passhash TEXT,
    balance_cents INTEGER DEFAULT 10000,
    is_admin INTEGER DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user INTEGER,
    to_user INTEGER,
    amount_cents INTEGER,
    status TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS coins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    symbol TEXT UNIQUE,
    supply INTEGER,
    owner_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS coin_tx (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    coin_id INTEGER,
    from_user INTEGER,
    to_user INTEGER,
    amount INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS gambles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    wager_cents INTEGER,
    target INTEGER,
    roll INTEGER,
    win INTEGER,
    seed TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  // Create Admin if not exists
  db.get("SELECT * FROM users WHERE username = ?", ['Admin'], (err, row) => {
    if (!row) {
      bcrypt.hash('admintime', 10, (err, hash) => {
        db.run("INSERT INTO users (username, passhash, balance_cents, is_admin) VALUES (?, ?, 999999999, 1)", ['Admin', hash]);
      });
    }
  });
});

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({error: 'No token'});
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    res.status(401).json({error: 'Invalid token'});
  }
}

app.post('/api/register', async (req, res) => {
  const {username, password} = req.body;
  const hash = await bcrypt.hash(password, 10);
  db.run("INSERT INTO users (username, passhash) VALUES (?, ?)", [username, hash], function(err) {
    if (err) return res.status(400).json({error: 'Username taken'});
    const token = jwt.sign({id: this.lastID, username}, JWT_SECRET);
    res.json({token, user: {username, balanceCents: 10000, isAdmin: 0}});
  });
});

app.post('/api/login', (req, res) => {
  const {username, password} = req.body;
  db.get("SELECT * FROM users WHERE username = ?", [username], async (err, row) => {
    if (!row || !(await bcrypt.compare(password, row.passhash))) {
      return res.status(401).json({error: 'Bad credentials'});
    }
    const token = jwt.sign({id: row.id, username: row.username}, JWT_SECRET);
    res.json({token, user: {username: row.username, balanceCents: row.balance_cents, isAdmin: !!row.is_admin}});
  });
});

app.get('/api/me', auth, (req, res) => {
  db.get("SELECT username, balance_cents AS balanceCents, is_admin AS isAdmin FROM users WHERE id = ?", [req.user.id], (err, row) => {
    res.json(row);
  });
});

app.get('/api/history', auth, (req, res) => {
  db.all(`
    SELECT t.id, t.amount_cents AS amountCents, t.status, t.created_at AS createdAt,
           u1.username AS from, u2.username AS to,
           CASE WHEN t.from_user = ? THEN 'sent' ELSE 'received' END AS direction
    FROM transfers t
    LEFT JOIN users u1 ON t.from_user = u1.id
    LEFT JOIN users u2 ON t.to_user = u2.id
    WHERE t.from_user = ? OR t.to_user = ?
    ORDER BY t.created_at DESC
  `, [req.user.id, req.user.id, req.user.id], (err, rows) => {
    res.json(rows);
  });
});

app.post('/api/send', auth, (req, res) => {
  const {toUsername, amountCents, clientId} = req.body;
  if (amountCents <= 0) return res.status(400).json({error: 'Invalid amount'});

  db.get("SELECT id, balance_cents FROM users WHERE username = ?", [toUsername], (err, toUser) => {
    if (!toUser) return res.status(404).json({error: 'User not found'});
    db.get("SELECT balance_cents, is_admin FROM users WHERE id = ?", [req.user.id], (err, fromUser) => {
      if (!fromUser.is_admin && fromUser.balance_cents < amountCents) return res.status(400).json({error: 'Insufficient funds'});

      db.run("BEGIN TRANSACTION");
      db.run("UPDATE users SET balance_cents = balance_cents - ? WHERE id = ?", [amountCents, req.user.id], () => {
        db.run("UPDATE users SET balance_cents = balance_cents + ? WHERE id = ?", [amountCents, toUser.id], () => {
          db.run("INSERT INTO transfers (from_user, to_user, amount_cents, status) VALUES (?, ?, ?, 'completed')", [req.user.id, toUser.id, amountCents], function() {
            db.run("COMMIT");
            res.json({txId: this.lastID, status: 'completed'});
          });
        });
      });
    });
  });
});

app.post('/api/gamble', auth, async (req, res) => {
  let {wagerCents, target} = req.body;
  if (wagerCents <= 0 || target < 0 || target > 99) return res.status(400).json({error: 'Bad params'});

  const seed = crypto.randomUUID();
  const roll = Math.floor(Math.random() * 100); // 0-99
  const win = roll <= target;
  const multiplier = win ? 99 / (target + 1) : 0;
  const payoutCents = Math.floor(wagerCents * multiplier);

  db.get("SELECT balance_cents, is_admin FROM users WHERE id = ?", [req.user.id], (err, user) => {
    if (!user.is_admin && user.balance_cents < wagerCents) return res.status(400).json({error: 'Not enough money'});

    const delta = payoutCents - wagerCents;
    db.run("UPDATE users SET balance_cents = balance_cents + ? WHERE id = ?", [delta, req.user.id]);
    db.run("INSERT INTO gambles (user_id, wager_cents, target, roll, win, seed) VALUES (?, ?, ?, ?, ?, ?)",
      [req.user.id, wagerCents, target, roll, win ? 1 : 0, seed]);
    res.json({win, roll, seed, payoutCents, balanceDelta: delta});
  });
});

app.post('/api/mint', auth, (req, res) => {
  const {name, symbol, supply} = req.body;
  if (!name || !symbol || !supply || supply <= 0) return res.status(400).json({error: 'Invalid data'});
  db.run("INSERT INTO coins (name, symbol, supply, owner_id) VALUES (?, ?, ?, ?)", [name, symbol.toUpperCase(), supply, req.user.id], function(err) {
    if (err) return res.status(400).json({error: 'Symbol taken'});
    res.json({coinId: this.lastID, name, symbol: symbol.toUpperCase(), supply});
  });
});

app.post('/api/send-coin', auth, (req, res) => {
  const {symbol, toUsername, amount} = req.body;
  db.get("SELECT id FROM users WHERE username = ?", [toUsername], (err, toUser) => {
    if (!toUser) return res.status(404).json({error: 'User not found'});
    db.get("SELECT id FROM coins WHERE symbol = ?", [symbol.toUpperCase()], (err, coin) => {
      if (!coin) return res.status(404).json({error: 'Coin not found'});
      // simple balance check (creator has all)
      db.get("SELECT SUM(amount) as bal FROM coin_tx WHERE coin_id = ? AND to_user = ?", [coin.id, req.user.id], (err, row) => {
        const balance = (row?.bal || 0);
        if (balance < amount) return res.status(400).json({error: 'Not enough tokens'});
        db.run("INSERT INTO coin_tx (coin_id, from_user, to_user, amount) VALUES (?, ?, ?, ?)", [coin.id, req.user.id, toUser.id, amount]);
        res.json({status: 'ok'});
      });
    });
  });
});

app.get('/api/coin-balance/:symbol', auth, (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  db.get("SELECT id FROM coins WHERE symbol = ?", [sym], (err, coin) => {
    if (!coin) return res.json({symbol: sym, balance: 0});
    db.get("SELECT COALESCE(SUM(amount),0) as balance FROM coin_tx WHERE coin_id = ? AND to_user = ?", [coin.id, req.user.id], (err, row) => {
      res.json({symbol: sym, balance: row.balance || 0});
    });
  });
});

app.listen(process.env.PORT || 3000);
