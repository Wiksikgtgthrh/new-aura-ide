// Auth-сервер: Node + pg, ноль фреймворков. Сессии в httpOnly-cookie.
// env: DATABASE_URL=postgres://app:...@127.0.0.1:5432/app, PORT=8141
import http from 'node:http';
import crypto from 'node:crypto';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const PORT = Number(process.env.PORT || 8141);
const SESSION_DAYS = 30;

// scrypt: храним salt:hash в hex, сравниваем timingSafeEqual
const hashPass = (pass) => {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pass, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
};
const checkPass = (pass, stored) => {
  const [saltHex, hashHex] = stored.split(':');
  const hash = crypto.scryptSync(pass, Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
};

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
};
const readBody = (req) =>
  new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 16_384) reject(new Error('body too large'));
    });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { reject(new Error('bad json')); } });
  });

const isEmail = (v) => typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

function setSessionCookie(res, token, expiresAt) {
  const maxAge = Math.floor((expiresAt.getTime() - Date.now()) / 1000);
  res.setHeader('Set-Cookie',
    `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`);
}

async function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await pool.query('insert into sessions(token_hash, user_id, expires_at) values ($1,$2,$3)',
    [tokenHash, userId, expires]);
  setSessionCookie(res, token, expires);
}

async function userBySession(req) {
  const cookie = req.headers.cookie || '';
  const sid = cookie.split(';').map((s) => s.trim()).find((s) => s.startsWith('sid='));
  if (!sid) return null;
  const tokenHash = crypto.createHash('sha256').update(sid.slice(4)).digest('hex');
  const { rows } = await pool.query(
    `select u.id, u.email, u.name from sessions s join users u on u.id = s.user_id
     where s.token_hash = $1 and s.expires_at > now()`, [tokenHash]);
  return rows[0] || null;
}

// примитивный rate limit: 10 попыток / 5 минут с IP на login+register
const attempts = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const rec = (attempts.get(ip) || []).filter((t) => now - t < 300_000);
  rec.push(now);
  attempts.set(ip, rec);
  return rec.length > 10;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');

    if (req.method === 'POST' && url.pathname === '/api/register') {
      if (rateLimited(req.socket.remoteAddress)) return json(res, 429, { error: 'Слишком много попыток' });
      const { email, name, password } = await readBody(req);
      if (!isEmail(email)) return json(res, 400, { error: 'Некорректный email' });
      if (typeof password !== 'string' || password.length < 8)
        return json(res, 400, { error: 'Пароль — минимум 8 символов' });
      const mail = email.trim().toLowerCase();
      try {
        const { rows } = await pool.query(
          'insert into users(email, name, pass_hash) values ($1,$2,$3) returning id',
          [mail, (name || '').trim().slice(0, 80), hashPass(password)]);
        await createSession(res, rows[0].id);
        return json(res, 201, { ok: true });
      } catch (e) {
        if (e.code === '23505') return json(res, 409, { error: 'Такой email уже зарегистрирован' });
        throw e;
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/login') {
      if (rateLimited(req.socket.remoteAddress)) return json(res, 429, { error: 'Слишком много попыток' });
      const { email, password } = await readBody(req);
      const mail = (email || '').trim().toLowerCase();
      const { rows } = await pool.query('select id, pass_hash from users where email = $1', [mail]);
      const fail = () => json(res, 401, { error: 'Неверная пара email/пароль' });
      if (!rows[0]) return fail();
      if (typeof password !== 'string' || !checkPass(password, rows[0].pass_hash)) return fail();
      await createSession(res, rows[0].id);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/logout') {
      const cookie = req.headers.cookie || '';
      const sid = cookie.split(';').map((s) => s.trim()).find((s) => s.startsWith('sid='));
      if (sid) {
        const tokenHash = crypto.createHash('sha256').update(sid.slice(4)).digest('hex');
        await pool.query('delete from sessions where token_hash = $1', [tokenHash]);
      }
      res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/api/me') {
      const user = await userBySession(req);
      if (!user) return json(res, 401, { error: 'unauthorized' });
      return json(res, 200, { user });
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    json(res, 500, { error: 'internal' });
  }
});

server.listen(PORT, () => console.log(`auth api on :${PORT}`));
