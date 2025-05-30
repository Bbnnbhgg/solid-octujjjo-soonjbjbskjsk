export default {
  async fetch(req, env, ctx) {
    const logs = [];
    function debug(...args) {
      logs.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
    }

    try {
      debug('Fetch event started', req.method, req.url);

      const url = new URL(req.url);
      const { pathname, searchParams } = url;

      debug('Pathname:', pathname);

      if (req.method === 'GET' && pathname === '/') {
        debug('Handling GET /');
        const notes = await listNotesFromGithub(env, debug);
        const html = renderHTML(notes, searchParams.get('sort') || 'desc', logs);
        return new Response(html, { headers: { 'Content-Type': 'text/html' } });
      }

      if (req.method === 'POST' && pathname === '/notes') {
        debug('Handling POST /notes');
        const formData = await req.formData();
        const password = formData.get('password');

        if (password !== env.NOTE_PASSWORD) {
          debug('Unauthorized: wrong password');
          return new Response('Unauthorized', { status: 401 });
        }

        let title = formData.get('title') || 'Untitled';
        let content = formData.get('content');

        if (!content) {
          debug('Bad request: content missing');
          return new Response('Content is required', { status: 400 });
        }

        try {
          title = await filterText(title, debug);
          content = await filterText(content, debug);
        } catch (e) {
          debug('Filter failed, using raw inputs.', e.message);
        }

        if (isRobloxScript(content)) {
          debug('Detected Roblox script, obfuscating...');
          content = await obfuscate(content, debug);
        }

        const id = crypto.randomUUID();
        debug('Generated note ID:', id);

        await storeNoteGithub(id, title, content, env, debug);
        debug('Stored note to GitHub');
        return Response.redirect('/', 302);
      }

      if (req.method === 'GET' && pathname.startsWith('/notes/')) {
        const id = pathname.split('/notes/')[1];
        const ua = req.headers.get('user-agent') || '';
        if (!ua.includes('Roblox')) {
          debug('Access denied: user-agent check failed');
          return new Response('Access denied', { status: 403 });
        }

        const notes = await listNotesFromGithub(env, debug);
        const note = notes.find(n => n.id === id);
        if (!note) {
          debug('Note not found:', id);
          return new Response('Not found', { status: 404 });
        }

        debug('Serving note:', id);
        return new Response(note.content, { headers: { 'Content-Type': 'text/plain' } });
      }

      debug('Route not found');
      return new Response('Not found', { status: 404 });
    } catch (err) {
      debug('Unhandled error:', err.message);
      return new Response(
        `Internal Server Error\n\nDebug logs:\n${logs.join('\n')}\n\nError: ${err.stack}`,
        { status: 500, headers: { 'Content-Type': 'text/plain' } }
      );
    }
  }
};

// Pass debug function into helpers to log inside them:
async function filterText(text, debug = () => {}) {
  try {
    debug('Calling filter API with text:', text);
    const res = await fetch('https://tiny-river-0235.hiplitehehe.workers.dev/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });

    debug('Filter API response status:', res.status);
    const contentType = res.headers.get('content-type') || '';
    const raw = await res.text();

    debug('Filter API content-type:', contentType);
    debug('Filter API raw response:', raw);

    if (!res.ok || !contentType.includes('application/json')) {
      debug('Filter API returned error or invalid content-type');
      return text;
    }

    const data = JSON.parse(raw);
    return data.filtered || text;
  } catch (e) {
    debug('filterText error:', e.message);
    return text;
  }
}

async function obfuscate(content, debug = () => {}) {
  try {
    debug('Calling obfuscate API');
    const res = await fetch('https://broken-pine-ac7f.hiplitehehe.workers.dev/api/obfuscate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: content })
    });

    debug('Obfuscate API response status:', res.status);
    const contentType = res.headers.get('content-type') || '';
    const raw = await res.text();

    debug('Obfuscate API content-type:', contentType);
    debug('Obfuscate API raw response:', raw);

    if (!res.ok || !contentType.includes('application/json')) {
      debug('Obfuscate API returned error or invalid content-type');
      return content;
    }

    const data = JSON.parse(raw);
    return data.obfuscated || content;
  } catch (e) {
    debug('obfuscate error:', e.message);
    return content;
  }
}

async function storeNoteGithub(id, title, content, env, debug = () => {}) {
  const path = `notes/${id}.txt`;
  const body = `Title: ${title}\n\n${content}`;
  const encoded = btoa(unescape(encodeURIComponent(body)));

  debug(`Storing note to GitHub path: ${path}`);
  const res = await fetch(`https://api.github.com/repos/${env.REPO_OWNER}/${env.REPO_NAME}/contents/${path}`, {
    method: 'PUT',
    headers: {
      Authorization: `token ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github.v3+json'
    },
    body: JSON.stringify({
      message: `Add note: ${id}`,
      content: encoded,
      branch: env.BRANCH
    })
  });

  debug('GitHub API response status:', res.status);
  if (!res.ok) {
    const errText = await res.text();
    debug('GitHub API error response:', errText);
    throw new Error('GitHub API error');
  }
}

async function listNotesFromGithub(env, debug = () => {}) {
  debug('Listing notes from GitHub...');
  const res = await fetch(`https://api.github.com/repos/${env.REPO_OWNER}/${env.REPO_NAME}/contents/notes?ref=${env.BRANCH}`, {
    headers: { Authorization: `token ${env.GITHUB_TOKEN}` }
  });

  debug('GitHub API response status:', res.status);
  if (!res.ok) {
    const errText = await res.text();
    debug('GitHub API error response:', errText);
    throw new Error('GitHub API error');
  }

  const files = await res.json();
  const notes = [];

  for (const file of files) {
    if (file.name.endsWith('.txt')) {
      debug('Fetching note file:', file.name);
      const fileRes = await fetch(file.download_url);
      const raw = await fileRes.text();
      const [titleLine, , ...rest] = raw.split('\n');
      const title = titleLine.replace(/^Title:\s*/, '') || 'Untitled';
      notes.push({
        id: file.name.replace('.txt', ''),
        title,
        content: rest.join('\n'),
        createdAt: new Date().toISOString()
      });
    }
  }

  debug(`Loaded ${notes.length} notes`);
  return notes;
}

function renderHTML(notes, sortOrder = 'desc', debugLogs = []) {
  const sorted = notes.sort((a, b) =>
    sortOrder === 'desc'
      ? new Date(b.createdAt) - new Date(a.createdAt)
      : new Date(a.createdAt) - new Date(b.createdAt)
  );

  const list = sorted.map(note =>
    `<div><strong><a href="/notes/${note.id}" target="_blank">${note.title}</a></strong> (ID: ${note.id})</div>`
  ).join('');

  // Add debug logs at the bottom of the page inside a <pre> for readability
  const debugHtml = debugLogs.length
    ? `<hr><h3>Debug logs:</h3><pre style="background:#eee; padding:10px; max-height:200px; overflow:auto;">${debugLogs.join('\n')}</pre>`
    : '';

  return `
    <!DOCTYPE html>
    <html>
    <head><title>Notes</title></head>
    <body>
      <form method="POST" action="/notes">
        <input name="title" placeholder="Title" required><br>
        <textarea name="content" rows="5" required></textarea><br>
        <input type="password" name="password" placeholder="Password" required><br>
        <button>Save</button>
      </form>
      <hr>
      ${list}
      ${debugHtml}
    </body>
    </html>`;
}
