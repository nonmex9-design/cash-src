// app.js
const API = '';
let token = localStorage.token;
let isAdmin = false;

const authPage  = document.getElementById('authPage');
const appPage   = document.getElementById('app');
const authForm  = document.getElementById('authForm');
const switchAuth= document.getElementById('switchAuth');
const authTitle = document.getElementById('authTitle');

switchAuth.onclick = () => {
  const reg = authTitle.textContent !== 'Register';
  authTitle.textContent = reg ? 'Register' : 'Login';
  switchAuth.textContent = reg ? 'Have an account? Login' : 'Need an account? Register';
  authForm.querySelector('button[type="submit"]').textContent = reg ? 'Create' : 'Sign in';
};

authForm.onsubmit = async (e) => {
  e.preventDefault();
  const body = JSON.stringify({
    username: document.getElementById('username').value,
    password: document.getElementById('password').value
  });
  const ep = authTitle.textContent === 'Register' ? '/api/register' : '/api/login';
  const r = await fetch(API + ep, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body
  });
  if (!r.ok) return alert((await r.json()).error);
  const { token: tok, user } = await r.json();
  token = tok; localStorage.token = token; isAdmin = user.isAdmin;
  showApp();
};

document.getElementById('logout').onclick = () => { delete localStorage.token; location.reload(); };

async function authed(path, opts = {}) {
  const r = await fetch(API + path, {
    headers: { Authorization: 'Bearer ' + token, ...opts.headers },
    ...opts
  });
  if (r.status === 401) { delete localStorage.token; location.reload(); }
  if (!r.ok) throw new Error((await r.json()).error);
  return r.json();
}

function showApp() {
  authPage.classList.add('hidden');
  appPage.classList.remove('hidden');
  loadMe();
  loadHist();
  setInterval(loadMe, 5000);
}

async function loadMe() {
  const me = await authed('/api/me');
  document.getElementById('welcome').textContent = `Hi ${me.username}${me.isAdmin ? ' (ADMIN)' : ''}`;
  document.getElementById('bal').textContent = `Balance: $${(me.balanceCents / 100).toFixed(2)}`;
}

async function loadHist() {
  const h = await authed('/api/history');
  const tbody = document.getElementById('histBody'); tbody.innerHTML = '';
  h.forEach(t => {
    const tr = tbody.insertRow();
    tr.insertCell(0).textContent = new Date(t.createdAt).toLocaleString();
    tr.insertCell(1).textContent = t.direction === 'out' ? '→ ' + t.to : '← ' + t.from;
    tr.insertCell(2).textContent = (t.amountCents / 100).toFixed(2);
    tr.insertCell(3).textContent = t.status;
  });
}

// send cash
document.getElementById('sendCashForm').onsubmit = async (e) => {
  e.preventDefault();
  const cents = Math.round(parseFloat(document.getElementById('amount').value) * 100);
  const clientId = crypto.randomUUID();
  const r = await authed('/api/send', {
    method: 'POST',
    body: JSON.stringify({
      toUsername: document.getElementById('toUser').value,
      amountCents: cents,
      clientId
    })
  });
  const { status } = await r.json();
  alert(status === 'completed' ? 'Sent!' : status);
  loadMe(); loadHist();
};

// gamble
document.getElementById('gambleForm').onsubmit = async (e) => {
  e.preventDefault();
  const wager = Math.round(parseFloat(document.getElementById('wager').value) * 100);
  const target = parseInt(document.getElementById('target').value);
  const res = await authed('/api/gamble', {
    method: 'POST',
    body: JSON.stringify({ wagerCents: wager, target })
  });
  const p = document.getElementById('gambleRes');
  p.className = res.win ? 'win' : 'lose';
  p.textContent = `${res.win ? 'Won' : 'Lost'}  $${(Math.abs(res.balanceDelta) / 100).toFixed(2)}  |  roll=${res.roll}  seed=${res.seed}`;
  loadMe();
};

// mint coin
document.getElementById('mintForm').onsubmit = async (e) => {
  e.preventDefault();
  const body = {
    name: document.getElementById('coinName').value,
    symbol: document.getElementById('coinSym').value.toUpperCase(),
    supply: parseInt(document.getElementById('coinSup').value)
  };
  const r = await authed('/api/mint', { method: 'POST', body: JSON.stringify(body) });
  document.getElementById('mintRes').textContent = `Minted ${r.symbol} (${r.supply} coins)`;
};

// send coin
document.getElementById('sendCoinForm').onsubmit = async (e) => {
  e.preventDefault();
  const body = {
    symbol: document.getElementById('coinSymSend').value.toUpperCase(),
    toUsername: document.getElementById('toUserCoin').value,
    amount: parseInt(document.getElementById('amtCoin').value)
  };
  const r = await authed('/api/send-coin', { method: 'POST', body: JSON.stringify(body) });
  alert(r.status === 'completed' ? 'Coins sent!' : r.status);
};

// auto-login if token present
if (token) {
  authed('/api/me')
    .then(showApp)
    .catch(() => { delete localStorage.token; authPage.classList.remove('hidden'); });
} else {
  authPage.classList.remove('hidden');
}