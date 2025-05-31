// index.js

export default {
  // Entry point for all incoming requests
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
        // Extract the note ID from the path
        const id = pathname.split('/').pop();
        return await handleGetNoteById(request, env, id);
      }

      return new Response('Not Found', { status: 404 });
    } catch (err) {
      // In case anything goes wrong:
      return new Response(
        `Internal Server Error\n\n${err.stack || err.message}`,
        {
          status: 500,
          headers: { 'Content-Type': 'text/plain' },
        }
      );
    }
  },
};

// -------------------- Handlers --------------------

/**
 * GET /
 * List notes (by reading from GitHub) and render HTML form + list.
 */
async function handleGetRoot(request, env) {
  const sortOrder = new URL(request.url).searchParams.get('sort') || 'desc';
  try {
    const notes = await listNotesFromGithub(env);
    const html = renderHTML(notes, sortOrder);
    return new Response(html, {
      headers: { 'Content-Type': 'text/html' },
    });
  } catch (err) {
    return new Response(
      `Failed to list notes:\n\n${err.stack || err.message}`,
      { status: 500, headers: { 'Content-Type': 'text/plain' } }
    );
  }
}

/**
 * POST /notes
 * - Parses JSON or x-www-form-urlencoded body
 * - Checks password
 * - Runs filterText → obfuscate
 * - Generates a UUID
 * - Stores the note in GitHub under notes/{uuid}.txt
 * - Redirects back to GET /
 */
async function handlePostNotes(request, env) {
  // 1) Parse the request body as either JSON or urlencoded
  let fields = {};
  const contentType = (request.headers.get('Content-Type') || '').toLowerCase();

  if (contentType.includes('application/json')) {
    try {
      fields = await request.json();
    } catch {
      return new Response('Bad Request: Invalid JSON', { status: 400 });
    }
  } else if (contentType.includes('application/x-www-form-urlencoded')) {
    const text = await request.text();
    fields = Object.fromEntries(new URLSearchParams(text));
  } else {
    return new Response('Unsupported Media Type', { status: 415 });
  }

  const rawPassword = fields.password || '';
  const rawTitle = fields.title || '';
  const rawContent = fields.content || '';

  // 2) Check the password
  if (rawPassword !== env.NOTE_PASSWORD) {
    return new Response('Unauthorized', { status: 401 });
  }

  // 3) Ensure content exists
  if (!rawContent.trim()) {
    return new Response('Content is required', { status: 400 });
  }

  // 4) Filter title & content (if filtering fails, use the raw strings)
  let title = rawTitle.trim() || 'Untitled';
  let content = rawContent;

  try {
    title = await filterText(title);
  } catch {
    // on error, keep raw title
  }

  try {
    content = await filterText(content);
  } catch {
    // on error, keep raw content
  }

  // 5) Obfuscate
  try {
    content = await obfuscate(content);
  } catch {
    // on error, keep filtered (or raw) content
  }

  // 6) Generate a UUID for this note
  const id = crypto.randomUUID();

  // 7) Store it in GitHub
  try {
    await storeNoteGithub(id, title, content, env);
  } catch (err) {
    return new Response(
      `Failed to store note:\n\n${err.stack || err.message}`,
      { status: 500, headers: { 'Content-Type': 'text/plain' } }
    );
  }

  // 8) Redirect back to GET /
  // Use 303 to indicate “See Other” after POST
  return Response.redirect(new URL('/', request.url), 303);
}

/**
 * GET /notes/:id
 * - Checks User-Agent contains "Roblox"
 * - Fetches all notes from GitHub, finds the one with matching id
 * - Returns its plain‐text content
 */
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
    return new Response(
      `Failed to fetch note:\n\n${err.stack || err.message}`,
      { status: 500, headers: { 'Content-Type': 'text/plain' } }
    );
  }
}

// -------------------- Utility Functions --------------------

/**
 * filterText(text)
 * --------------------------------------
 * Sends `{ text }` to the external filter API.
 * If the API returns `{ filtered: '...' }` then use that, otherwise return the original text.
 * Any errors or non-200 responses → return the original text.
 */
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
    // network error → return raw
    return text;
  }

  if (!res.ok) {
    // non-200 → return raw
    return text;
  }

  const contentType = (res.headers.get('Content-Type') || '').toLowerCase();
  if (!contentType.includes('application/json')) {
    // unexpected response type → return raw
    return text;
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return text;
  }

  if (data.filtered && typeof data.filtered === 'string') {
    return data.filtered;
  }

  // If the API indicates “clean” or no `filtered` field, return original
  return text;
}

/**
 * obfuscate(content)
 * --------------------------------------
 * Sends `{ script: content }` to the obfuscation API.
 * If the API returns `{ obfuscated: '...' }` then use that, otherwise return original content.
 */
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

  if (!res.ok) {
    return content;
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return content;
  }

  if (data.obfuscated && typeof data.obfuscated === 'string') {
    return data.obfuscated;
  }
  return content;
}

/**
 * storeNoteGithub(id, title, content, env)
 * --------------------------------------
 * Encodes `Title: {title}\n\n{content}` as base64 and PUTs it to:
 *  https://api.github.com/repos/{REPO_OWNER}/{REPO_NAME}/contents/notes/{id}.txt
 *
 * Requires:
 *  - env.REPO_OWNER
 *  - env.REPO_NAME
 *  - env.GITHUB_TOKEN
 *  - (optional) env.BRANCH
 */
async function storeNoteGithub(id, title, content, env) {
  const path = `notes/${id}.txt`;
  const bodyText = `Title: ${title}\n\n${content}`;
  // Cloudflare’s global btoa/atob exist
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

/**
 * listNotesFromGithub(env)
 * --------------------------------------
 * Lists all *.txt files under `notes/` folder in the GitHub repo,
 * fetches each file’s contents, and returns an array of objects:
 *   [{ id, title, content, createdAt }, ... ]
 *
 * Note: `createdAt` is just set to now() because the original did likewise.
 *       (If you prefer actual GitHub commit dates, you’d do an extra API call per file.)
 */
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

  // Expect `files` to be an array of { name, download_url, ... }
  for (const file of files) {
    if (typeof file.name === 'string' && file.name.endsWith('.txt')) {
      const fileRes = await fetch(file.download_url);
      if (!fileRes.ok) {
        // Skip any single file that fails
        continue;
      }
      const raw = await fileRes.text();
      // Split at first blank line: line 0 is "Title: {…}", line 1 is blank, rest is content
      const lines = raw.split('\n');
      const titleLine = lines[0] || 'Title: Untitled';
      const title = titleLine.replace(/^Title:\s*/, '') || 'Untitled';
      const content = lines.slice(2).join('\n');

      notes.push({
        id: file.name.replace(/\.txt$/, ''),
        title,
        content,
        // The original Express code used `new Date().toISOString()` for createdAt;
        // we do the same here.
        createdAt: new Date().toISOString(),
      });
    }
  }

  return notes;
}

/**
 * renderHTML(notes, sortOrder)
 * --------------------------------------
 * Renders a simple HTML page containing:
 *  - A form to POST /notes
 *  - A list of existing notes (sorted by createdAt)
 *  - A client-side <script> where `showNote(id)` simply does window.location.href
 */
function renderHTML(notes, sortOrder = 'desc') {
  // Sort notes by createdAt
  notes.sort((a, b) => {
    const da = new Date(a.createdAt);
    const db = new Date(b.createdAt);
    return sortOrder === 'desc' ? db - da : da - db;
  });

  // Build the list of <div>…</div> for each note
  const listItems = notes
    .map((note) => {
      return `<div>
        <strong>${escapeHtml(note.title)}</strong> (ID: ${note.id})
        <a href="#" onclick="showNote('${note.id}'); return false;">View Content</a>
      </div>`;
    })
    .join('');

  // The form, the list, and a small <script> to redirect
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
      // Redirect the browser to /notes/:id
      window.location.href = '/notes/' + encodeURIComponent(id);
    }
  </script>
</body>
</html>`;
}

/**
 * escapeHtml(str)
 * --------------------------------------
 * Simple helper to escape <>&"'
 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
