export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const pathname = url.pathname;

      if (request.method === 'GET' && pathname === '/') {
        return await handleGetRoot(request, env);
      }

      if (request.method === 'POST' && pathname === '/notes') {
        return await handlePostNotes(request, env);
      }

      if (request.method === 'GET' && pathname.startsWith('/notes/')) {
        const id = pathname.split('/').pop();
        return await handleGetNoteById(request, env, id);
      }

      return new Response('Not Found', { status: 404 });
    } catch (err) {
      return renderErrorPage(err.stack || err.message);
    }
  },
};

// -------------------- Handlers --------------------

async function handleGetRoot(request, env) {
  const sortOrder = new URL(request.url).searchParams.get('sort') || 'desc';
  try {
    const notes = await listNotesFromGithub(env);
    const html = renderHTML(notes, sortOrder);
    return new Response(html, {
      headers: { 'Content-Type': 'text/html' },
    });
  } catch (err) {
    return renderErrorPage(`Failed to list notes:\n\n${err.stack || err.message}`);
  }
}

async function handlePostNotes(request, env) {
  let fields = {};
  const contentType = (request.headers.get('Content-Type') || '').toLowerCase();

  if (contentType.includes('application/json')) {
    try {
      fields = await request.json();
    } catch {
      return renderErrorPage('Bad Request: Invalid JSON');
    }
  } else if (contentType.includes('application/x-www-form-urlencoded')) {
    const text = await request.text();
    fields = Object.fromEntries(new URLSearchParams(text));
  } else {
    return renderErrorPage('Unsupported Media Type');
  }

  const rawPassword = fields.password || '';
  const rawTitle = fields.title || '';
  const rawContent = fields.content || '';

  if (rawPassword !== env.NOTE_PASSWORD) {
    return renderErrorPage('Unauthorized');
  }

  if (!rawContent.trim()) {
    return renderErrorPage('Content is required');
  }

  let title = rawTitle.trim() || 'Untitled';
  let content = rawContent;

  try {
    title = await filterText(title);
  } catch {}

  try {
    content = await filterText(content);
  } catch {}

  try {
    const obf = await obfuscate(content);
    if (obf !== content) content = obf;
  } catch {}

  const id = crypto.randomUUID();

  try {
    await storeNoteGithub(id, title, content, env);
  } catch (err) {
    return renderErrorPage(`Failed to store note:\n\n${err.stack || err.message}`);
  }

  return Response.redirect(new URL('/', request.url), 303);
}

async function handleGetNoteById(request, env, id) {
  const ua = request.headers.get('User-Agent') || '';
  if (!ua.includes('Roblox')) {
    return new Response('Access denied', { status: 403 });
  }

  try {
    const notes = await listNotesFromGithub(env);
    const note = notes.find((n) => n.id === id);
    if (!note) {
      return new Response('Not found', { status: 404 });
    }

    return new Response(note.content, {
      headers: { 'Content-Type': 'text/plain' },
    });
  } catch (err) {
    return renderErrorPage(`Failed to fetch note:\n\n${err.stack || err.message}`);
  }
}

// -------------------- Utility Functions --------------------

async function filterText(text) {
  const payload = JSON.stringify({ text });
  let res;
  try {
    res = await fetch('https://tiny-river-0235.hiplitehehe.workers.dev/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: payload,
    });
  } catch {
    return text;
  }

  if (!res.ok) return text;

  const contentType = (res.headers.get('Content-Type') || '').toLowerCase();
  if (!contentType.includes('application/json')) return text;

  let data;
  try {
    data = await res.json();
  } catch {
    return text;
  }

  return typeof data.filtered === 'string' ? data.filtered : text;
}

async function obfuscate(content) {
  const payload = JSON.stringify({ script: content });
  let res;
  try {
    res = await fetch('https://broken-pine-ac7f.hiplitehehe.workers.dev/api/obfuscate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: payload,
    });
  } catch {
    return content;
  }

  if (!res.ok) return content;

  let data;
  try {
    data = await res.json();
  } catch {
    return content;
  }

  return typeof data.obfuscated === 'string' ? data.obfuscated : content;
}

async function storeNoteGithub(id, title, content, env) {
  const path = `notes/${id}.txt`;
  const bodyText = `Title: ${title}\n\n${content}`;
  const encoded = btoa(bodyText);

  const putUrl = `https://api.github.com/repos/${env.REPO_OWNER}/${env.REPO_NAME}/contents/${path}`;
  const payload = {
    message: `Add note: ${id}`,
    content: encoded,
    branch: env.BRANCH || 'main',
  };

  const res = await fetch(putUrl, {
    method: 'PUT',
    headers: {
      Authorization: `token ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'MyNoteAppCloudflareWorker/1.0',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API error: ${res.status}\n${text}`);
  }
}

async function listNotesFromGithub(env) {
  const listUrl = `https://api.github.com/repos/${env.REPO_OWNER}/${env.REPO_NAME}/contents/notes?ref=${
    env.BRANCH || 'main'
  }`;

  const res = await fetch(listUrl, {
    headers: {
      Authorization: `token ${env.GITHUB_TOKEN}`,
      'User-Agent': 'MyNoteAppCloudflareWorker/1.0',
    },
  });

  if (!res.ok) {
    throw new Error(`GitHub API error: ${res.status}\n${await res.text()}`);
  }

  const files = await res.json();
  const notes = [];

  for (const file of files) {
    if (file.name.endsWith('.txt')) {
      const fileRes = await fetch(file.download_url);
      if (!fileRes.ok) continue;

      const raw = await fileRes.text();
      const lines = raw.split('\n');
      const titleLine = lines[0] || 'Title: Untitled';
      const title = titleLine.replace(/^Title:\s*/, '') || 'Untitled';
      const content = lines.slice(2).join('\n');

      notes.push({
        id: file.name.replace(/\.txt$/, ''),
        title,
        content,
        createdAt: new Date().toISOString(),
      });
    }
  }

  return notes;
}

function renderHTML(notes, sortOrder = 'desc') {
  notes.sort((a, b) => {
    const da = new Date(a.createdAt);
    const db = new Date(b.createdAt);
    return sortOrder === 'desc' ? db - da : da - db;
  });

  const listItems = notes
    .map((note) => {
      return `<div>
        <strong>${escapeHtml(note.title)}</strong> (ID: ${note.id})
        <a href="#" onclick="showNote('${note.id}'); return false;">View Content</a>
      </div>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Notes</title>
</head>
<body>
  <form method="POST" action="/notes">
    <input name="title" placeholder="Title" required /><br/>
    <textarea name="content" rows="5" placeholder="Your content here…" required></textarea><br/>
    <input type="password" name="password" placeholder="Password" required /><br/>
    <button type="submit">Save</button>
  </form>
  <hr/>
  ${listItems}
  <script>
    function showNote(id) {
      window.location.href = '/notes/' + encodeURIComponent(id);
    }
  </script>
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderErrorPage(message) {
  return new Response(`
    <!DOCTYPE html>
    <html>
    <head><title>Error</title></head>
    <body>
      <h1>Something went wrong</h1>
      <pre>${escapeHtml(message)}</pre>
      <a href="/">Back to home</a>
    </body>
    </html>
  `, {
    status: 500,
    headers: { 'Content-Type': 'text/html' },
  });
}
