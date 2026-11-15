import { DurableObject } from 'cloudflare:workers';

const boardPath = '/api/ideas';
const voterCookie = 'ha2027_voter';
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const votePath = /^\/api\/ideas\/([a-f0-9-]{36})\/vote$/;
const day = 24 * 60 * 60 * 1000;

function json(data, status = 200, headers = {}) {
  return Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers }
  });
}

async function readInput(request) {
  if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/json' || !request.body) {
    return null;
  }
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let body = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return JSON.parse(body + decoder.decode());
      size += value.byteLength;
      if (size > 2048) {
        await reader.cancel();
        return null;
      }
      body += decoder.decode(value, { stream: true });
    }
  } catch {
    return null;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isBoard = url.pathname === boardPath;
    const vote = votePath.exec(url.pathname);
    if (!isBoard && !vote) return env.ASSETS.fetch(request);

    const allowed = isBoard ? ['GET', 'POST'] : ['PUT'];
    if (!allowed.includes(request.method)) {
      return json({ error: 'Method not allowed.' }, 405, { Allow: allowed.join(', ') });
    }

    const cookies = request.headers.get('Cookie')?.split(';').map(cookie => cookie.trim()) ?? [];
    const voter = cookies.find(cookie => cookie.startsWith(voterCookie + '='))?.slice(voterCookie.length + 1);
    const hasVoter = uuidPattern.test(voter ?? '');
    const board = env.IDEA_BOARD.get(env.IDEA_BOARD.idFromName('high-adventure-2027'));

    try {
      if (request.method === 'GET') {
        const id = hasVoter ? voter : crypto.randomUUID();
        const headers = hasVoter ? {} : {
          'Set-Cookie': `${voterCookie}=${id}; Path=/api/ideas; Max-Age=31536000; Secure; HttpOnly; SameSite=Lax`
        };
        return json({ ideas: await board.list(id) }, 200, headers);
      }

      if (request.headers.get('Origin') !== url.origin) {
        return json({ error: 'Open the High Adventure site to make changes.' }, 403);
      }
      if (!hasVoter) return json({ error: 'Refresh the board and allow cookies to post or vote.' }, 403);
      const input = await readInput(request);

      if (vote) {
        if (!uuidPattern.test(vote[1]) || typeof input?.voted !== 'boolean') {
          return json({ error: 'That vote could not be read.' }, 400);
        }
        const idea = await board.vote(voter, vote[1], input.voted);
        return idea ? json({ idea }) : json({ error: 'That idea is no longer available.' }, 404);
      }

      const idea = typeof input?.idea === 'string' ? input.idea.trim().replace(/\s+/g, ' ') : '';
      if (!idea || idea.length > 180) return json({ error: 'Enter an idea of 1–180 characters.' }, 400);
      const result = await board.add(voter, idea);
      return json(result.body, result.status);
    } catch (error) {
      console.error('High Adventure board request failed', error.name);
      return json({ error: 'The ideas board is temporarily unavailable. Try again shortly.' }, 503);
    }
  }
};

export class IdeaBoard extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS ideas (
        id TEXT PRIMARY KEY, idea TEXT NOT NULL, author TEXT NOT NULL, created INTEGER NOT NULL,
        UNIQUE (author, idea)
      );
      CREATE TABLE IF NOT EXISTS votes (
        idea_id TEXT NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
        voter TEXT NOT NULL,
        PRIMARY KEY (idea_id, voter)
      );
    `);
  }

  list(voter, id = null) {
    return this.sql.exec(`
      SELECT ideas.id, ideas.idea, ideas.created, COUNT(votes.voter) AS votes,
        MAX(CASE WHEN votes.voter = ? THEN 1 ELSE 0 END) AS voted
      FROM ideas
      LEFT JOIN votes ON votes.idea_id = ideas.id
      WHERE (? IS NULL OR ideas.id = ?)
      GROUP BY ideas.id
      ORDER BY COUNT(votes.voter) DESC, ideas.created DESC, ideas.id
    `, voter, id, id).toArray();
  }

  add(voter, idea) {
    const prior = this.sql.exec('SELECT id FROM ideas WHERE author = ? AND idea = ?', voter, idea).toArray()[0];
    if (prior) return { status: 200, body: { idea: this.list(voter, prior.id)[0], duplicate: true } };

    const now = Date.now();
    const { total, recent } = this.sql.exec(`
      SELECT COUNT(*) AS total,
        COUNT(CASE WHEN author = ? AND created > ? THEN 1 END) AS recent
      FROM ideas
    `, voter, now - day).one();
    if (total >= 300 || recent >= 10) {
      return { status: 429, body: { error: total >= 300 ? 'The ideas board is full.' : 'You can post up to 10 ideas per day. Try again tomorrow.' } };
    }

    const id = crypto.randomUUID();
    this.sql.exec('INSERT INTO ideas (id, idea, author, created) VALUES (?, ?, ?, ?)', id, idea, voter, now);
    return { status: 201, body: { idea: this.list(voter, id)[0] } };
  }

  vote(voter, id, voted) {
    if (!this.sql.exec('SELECT 1 FROM ideas WHERE id = ?', id).toArray().length) return null;
    if (voted) {
      this.sql.exec('INSERT OR IGNORE INTO votes (idea_id, voter) VALUES (?, ?)', id, voter);
    } else {
      this.sql.exec('DELETE FROM votes WHERE idea_id = ? AND voter = ?', id, voter);
    }
    return this.list(voter, id)[0];
  }
}
