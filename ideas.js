const form = document.querySelector('#ideaForm');
const input = document.querySelector('#ideaInput');
const submit = form.querySelector('button');
const list = document.querySelector('#ideaList');
const status = document.querySelector('#ideaStatus');
const retry = document.querySelector('#ideaRetry');
const drafts = document.querySelector('#ideaDrafts');
const endpoint = '/api/ideas';
const ideas = new Map();
let busy = false;

async function request(path = '', method = 'GET', body) {
  const response = await fetch(endpoint + path, {
    method,
    cache: 'no-store',
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Try again shortly.');
  return data;
}

function render() {
  const sorted = [...ideas.values()].sort((a, b) => b.votes - a.votes || b.created - a.created || a.id.localeCompare(b.id));
  const focusedVote = document.activeElement?.dataset.voteFor;
  list.replaceChildren();
  for (const idea of sorted) {
    const row = document.createElement('li');
    const description = document.createElement('span');
    description.textContent = idea.idea;
    const vote = document.createElement('button');
    vote.type = 'button';
    vote.className = 'reset';
    vote.dataset.voteFor = idea.id;
    vote.textContent = `▲ ${idea.votes}`;
    vote.setAttribute('aria-label', `Upvote ${idea.idea}, ${idea.votes} votes`);
    vote.setAttribute('aria-pressed', String(Boolean(idea.voted)));
    vote.addEventListener('click', () => changeVote(idea));
    row.append(description, vote);
    list.append(row);
    if (focusedVote === idea.id) vote.focus({ preventScroll: true });
  }
}

async function loadIdeas() {
  retry.hidden = true;
  status.textContent = 'Loading ideas…';
  try {
    const data = await request();
    ideas.clear();
    for (const idea of data.ideas) ideas.set(idea.id, idea);
    render();
    submit.disabled = false;
    status.textContent = ideas.size ? 'Tap ▲ to upvote an idea. Tap again to undo.' : 'Be the first to share an idea.';
  } catch {
    status.textContent = 'Could not load the shared ideas.';
    retry.hidden = false;
  }
}

async function changeVote(idea) {
  if (busy) return;
  busy = true;
  try {
    const data = await request(`/${idea.id}/vote`, 'PUT', { voted: !idea.voted });
    ideas.set(data.idea.id, data.idea);
    render();
    status.textContent = data.idea.voted ? 'Vote added.' : 'Vote removed.';
  } catch (error) {
    status.textContent = error.message || 'Could not save your vote.';
  } finally {
    busy = false;
  }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const idea = input.value.trim();
  if (!idea || busy) return;
  busy = true;
  submit.disabled = true;
  try {
    const data = await request('', 'POST', { idea });
    ideas.set(data.idea.id, data.idea);
    if (input.value.trim() === idea) input.value = '';
    render();
    status.textContent = data.duplicate ? 'You already shared that idea.' : 'Your idea is on the board.';
  } catch (error) {
    status.textContent = error.message || 'Could not post your idea.';
  } finally {
    busy = false;
    submit.disabled = false;
  }
});

try {
  const saved = JSON.parse(localStorage.getItem('timberlane-ha27-ideas') || '[]');
  for (const idea of Array.isArray(saved) ? saved : []) {
    if (typeof idea !== 'string' || !idea.trim() || idea.length > 180) continue;
    const row = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'reset';
    button.textContent = 'Use draft';
    button.setAttribute('aria-label', `Use draft: ${idea}`);
    button.addEventListener('click', () => {
      input.value = idea;
      input.focus();
    });
    row.append(document.createTextNode(idea), button);
    drafts.querySelector('ul').append(row);
    drafts.hidden = false;
  }
} catch {
  // A blocked or unreadable local draft store does not affect the shared board.
}

retry.addEventListener('click', loadIdeas);
loadIdeas();
