const API = '/api';
let token = localStorage.getItem('token');

async function req(path, init = {}) {
  init.headers = {...init.headers, Authorization: `Bearer ${token}`};
  const r = await fetch(API + path, init);
  if (r.status === 401) { localStorage.removeItem('token'); location.reload(); }
  return r.json();
}

function loginPage() {
  document.getElementById('app').innerHTML = `
    <h1>CashApp Clone</h1>
    <input id="user" placeholder="Username">
    <input id="pass" type="password" placeholder="Password">
    <button onclick="login()">Login</button>
    <button onclick="register()">Register</button>
  `;
}

async function login() {
  const u = document.getElementById('user').value;
  const p = document.getElementById('pass').value;
  const data = await fetch(API+'/login', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({username:u,password:p})}).then(r=>r.json());
  if (data.token) { token = data.token; localStorage.setItem('token', token); main(); }
  else alert(data.error || 'Failed');
}

async function register() {
  const u = document.getElementById('user').value;
  const p = document.getElementById('pass').value;
  const data = await fetch(API+'/register', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({username:u,password:p})}).then(r=>r.json());
  if (data.token) { token = data.token; localStorage.setItem('token', token); main(); }
  else alert(data.error);
}

async function main() {
  const me = await req('/me');
  const hist = await req('/history');
  const coins = await (await fetch(API+'/coins')).json() || [];

  let html = `<h1>$${ (me.balanceCents/100).toFixed(2) } ${me.isAdmin ? '(ADMIN)' : ''}</h1>`;

  html += `<h2>Send Money</h2>
    <input id="to" placeholder="Username">
    <input id="amt" type="number" placeholder="Amount $">
    <button onclick="sendMoney()">Send</button>`;

  html += `<h2>Dice (House edge 1%)</h2>
    <input id="wager" type="number" placeholder="Wager $">
    <input id="target" type="number" min="0" max="99" placeholder="Win if ≤ (0-99)">
    <button onclick="gamble()">Roll</button>
    <div id="result"></div>`;

  html += `<h2>Mint Token</h2>
    <input id="cname" placeholder="Name">
    <input id="csym" placeholder="Symbol">
    <input id="csupply" type="number" placeholder="Supply">
    <button onclick="mint()">Mint</button>`;

  html += `<h2>Transaction History</h2>
    <table><tr><th>Dir</th><th>Amount</th><th>From/To</th><th>Date</th></tr>
    ${hist.map(t=>`<tr><td>${t.direction}</td><td class="${t.direction==='sent'?'red':'green'}">$${(t.amountCents/100).toFixed(2)}</td><td>${t.from||t.to}</td><td>${new Date(t.createdAt).toLocaleString()}</td></tr>`).join('')}
    </table>`;

  document.getElementById('app').innerHTML = html + '<br><button onclick="localStorage.removeItem(\'token\');location.reload()">Logout</button>';
}

async function sendMoney() {
  const to = document.getElementById('to').value;
  const amt = Math.round(parseFloat(document.getElementById('amt').value)*100);
  await req('/send', {method:'POST', body:JSON.stringify({toUsername:to, amountCents:amt, clientId:crypto.randomUUID()})});
  main();
}

async function gamble() {
  const wager = Math.round(parseFloat(document.getElementById('wager').value)*100);
  const target = parseInt(document.getElementById('target').value);
  const r = await req('/gamble', {method:'POST', body:JSON.stringify({wagerCents:wager, target})});
  document.getElementById('result').innerHTML = r.win ? `<span class="green">WIN! +$${ (r.balanceDelta/100).toFixed(2)}</span>` : `<span class="red">LOSE -$${ (wager/100).toFixed(2)}</span> Roll: ${r.roll} Seed: ${r.seed}`;
  main();
}

async function mint() {
  const name = document.getElementById('cname').value;
  const symbol = document.getElementById('csym').value;
  const supply = parseInt(document.getElementById('csupply').value);
  await req('/mint', {method:'POST', body:JSON.stringify({name, symbol, supply})});
  alert('Minted ' + supply + ' ' + symbol);
}

if (token) main();
else loginPage();
