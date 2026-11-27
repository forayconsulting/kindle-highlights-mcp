# Kindle highlights MCP server

A remote MCP server on Cloudflare Workers. It reads your Kindle highlights from Amazon once a day and serves them through MCP tools. It can also commit each changed book to a GitHub repo of yours as `<book>/highlights.md`.

Amazon has no public API for highlights. The server uses two private ones:

- **Device registration.** One browser sign-in registers the server as a Kindle device and returns a refresh token. The token lasts until you remove the device from your Amazon account or change your password. The server uses it to mint fresh amazon.com cookies on every run, so it stores no cookies.
- **Kindle Cloud Reader endpoints** on `read.amazon.com` for the library, each book's annotations, and the full text of long highlights.

This is unofficial. It may violate Amazon's terms, and it can break when Amazon changes either API. The refresh token is a standing grant on your Amazon account. The server stores it in the `KINDLE_KV` namespace.

## Status

The server has run against a real amazon.com account, both from a laptop and from a deployed Worker. These points were checked:

| Question | Result |
|---|---|
| Does sign-in work in an ordinary browser? | Yes |
| Does `read.amazon.com` accept cookies minted from the refresh token? | Yes |
| Which id does `getDeviceToken` accept? | The Cloud Reader's device type, `A2CTZ977SKFQZY`, sent as both `serialNumber` and `deviceType`. It refuses the registered device's serial. |
| Does `read.amazon.com` accept a Worker's own `fetch`? | Yes. The fetch-proxy Container was not needed. |
| Does `copyText` return full passages? | Yes for most highlights. A few stay as previews. |

The fetch-proxy Container path is built but has only been run locally against fakes.

### Other endpoints tested

`npm run explore` sends read-only requests to other Amazon endpoints and prints PASS or FAIL for each. The server does not use these yet. Results from one amazon.com account on 2026-11-26, with cookies minted from the refresh token:

| Endpoint | Result | What it returns |
|---|---|---|
| `www.amazon.com/kindle/reading/insights/data` | Works | Daily and weekly reading streaks, titles read with dates, achievements |
| Extra `startReading` fields | Works | `lastPageReadData` (device, position, time), `metadataUrl`, `clippingLimit` |
| The file at `metadataUrl` | Works | Start and end positions, book size, authors. No table of contents for the book tested. |
| `read.amazon.com/notebook?asin=` | Works | HTML with each highlight's color and location |
| `www.amazon.com/hz/mycd/digital-console/ajax`, activity `GetContentOwnershipData` | Works | Every owned book and personal document, with read status and date acquired |
| `cde-ta-g7g.amazon.com/FionaCDEServiceEngine/sidecar` | Works with a signed device request | A binary sync file that holds the last read position |
| `todo-ta-g7g.amazon.com/FionaTodoListProxy/syncMetaData` | Answers, but the list is empty for this device | Nothing useful |

The script does not call anything that changes the account, sends a document, or returns book text.

## Tools

| Tool | What it does |
|---|---|
| `list_books` | Books that have highlights or notes |
| `get_highlights` | Every highlight and note for one book, by title or ASIN |
| `search_highlights` | Search highlight and note text across all books, by exact words |
| `semantic_search` | Find highlights by meaning. Needs the optional search index below. |
| `resurface_highlights` | A random handful of old highlights, or ones made on this day in earlier years |
| `export_book` | One book as CSV, an Anki import file, or an Obsidian note |
| `recent_highlights` | Highlights made in the last N days |
| `sync_now` | Fetch from Amazon now (default: 10 most recently read books) |
| `sync_status` | Last runs, their results, and totals |

## 1. Check the Amazon route from your computer

```bash
npm install
npm run spike
```

The script prints a sign-in address. Open it and sign in. Amazon then shows a "page not found" screen at `amazon.com/ap/maplanding`. That screen is the expected result. Copy its full address and paste it into the script. The script registers a device, then prints PASS or FAIL for each step.

The script saves credentials to `.spike-credentials.json`, which is git-ignored. The device appears in your Amazon account as "Kindle highlights spike" under Manage Your Content and Devices, Devices.

If the plain sign-in link is refused, run `npm run spike -- --browser`. It signs in through Playwright, which plants the Kindle app's cookies.

## 2. Deploy

You need a Cloudflare account. The free Workers plan is enough unless you enable the fetch proxy.

```bash
npx wrangler kv namespace create KINDLE_KV          # put the id in wrangler.jsonc
npx wrangler kv namespace create KINDLE_OAUTH_KV    # put the id in wrangler.jsonc under OAUTH_KV
npx wrangler d1 create kindle-highlights            # put the id in wrangler.jsonc
npx wrangler d1 migrations apply kindle-highlights --remote
npx wrangler secret put API_SECRET                  # any long random string
npx wrangler deploy
```

Set `API_SECRET` before the first deploy. The Worker answers 500 on its `/auth`, `/debug`, and `/authorize` paths until the secret exists.

To keep your resource ids out of git, copy `wrangler.jsonc` to `wrangler.local.jsonc`, fill in the ids there, and pass `-c wrangler.local.jsonc` to each wrangler command. That file is git-ignored.

Then:

1. **Protect `/authorize` with Cloudflare Access.** In the Cloudflare dashboard, open Zero Trust, Access controls, Applications. Add a self-hosted application with one public hostname: your Worker's hostname with the path `authorize`. Give it a policy that allows only you. Protect that path only. Claude's servers call `/mcp`, `/token`, and `/register` directly, so Access must not cover them.
2. **Register with Amazon.** Open `https://<worker>/auth/<API_SECRET>/start` and sign in. If you already ran the spike, you can skip the second sign-in: `npx wrangler kv key put "amazon:credentials" --binding KINDLE_KV --remote --path .spike-credentials.json`.
3. **Probe.** Open `https://<worker>/debug/<API_SECRET>/probe`. Every step should be `"ok": true`.
4. **Run a first sync.** `curl -X POST "https://<worker>/debug/<API_SECRET>/sync?max=5"`.
5. **Add the connector.** In claude.ai, add `https://<worker>/mcp` as a custom connector. Keep the detected settings: sign in now, and register automatically.

Do step 1 before step 2. The connector's OAuth step trusts the `CF-Access-Authenticated-User-Email` header, and only Access makes that header trustworthy. Without Access, nobody can connect.

### Committing highlights to a GitHub repo

This part is optional. Without it, sync fills the database and the tools work.

1. Set `GITHUB_REPO` in `wrangler.jsonc` to the repo that should receive the files, as `owner/name`.
2. Create a fine-grained GitHub token with Contents read and write on that repo only.
3. Run `npx wrangler secret put GITHUB_TOKEN`, then deploy.

`GITHUB_BRANCH` is `main`, so sync commits go straight to the default branch. Point it at a test branch for the first runs if you want to read the output first. Each `<book>/highlights.md` file is overwritten on every sync, so keep hand-written notes in a different file.

### Search by meaning

This part is optional. It uses Workers AI and Vectorize, and both fit the free plan for a personal library.

1. Create the index and its book filter:

   ```bash
   npx wrangler vectorize create kindle-highlights --dimensions=1024 --metric=cosine
   npx wrangler vectorize create-metadata-index kindle-highlights --property-name=asin --type=string
   ```

2. Uncomment the `ai` and `vectorize` blocks in `wrangler.jsonc`.
3. Run `npx wrangler d1 migrations apply kindle-highlights --remote`, then deploy.
4. Index what is already stored. Repeat this call until `pending` is 0: `curl -X POST "https://<worker>/debug/<API_SECRET>/embed?max=64"`.

After that, each sync indexes up to 64 new or changed highlights. `sync_status` shows how many are indexed. The model is `@cf/qwen/qwen3-embedding-0.6b`.

### Exports

`https://<worker>/debug/<API_SECRET>/export?format=csv` downloads every highlight as a CSV with the columns Highlight, Title, Author, Note, Location, Date. `format=anki` gives a tab-separated file for Anki's text import. `format=obsidian&book=<asin>` gives one book as a note with YAML properties. Add `&book=<asin>` to the first two to get one book.

### If the probe says `read.amazon.com` blocks the Worker

In `wrangler.jsonc`, uncomment the `FETCH_PROXY` binding, the `v2` migration, and the `containers` block. Then run `npx wrangler deploy`. This needs Docker running and the Workers Paid plan. Requests to `read.amazon.com` then go through `container/proxy.py`, which sends them with a Chrome TLS fingerprint. Check with `/debug/<API_SECRET>/probe?transport=proxy`.

To test the proxy locally:

```bash
docker build -t kindle-proxy container && docker run --rm -p 8080:8080 kindle-proxy
npm run spike -- --proxy http://localhost:8080
```

## How sync works

- It runs daily at 10:17 UTC (`triggers.crons`).
- Each run checks the 5 most recently read books plus the next slice of a sweep through the rest of the library, `SYNC_BATCH_SIZE` books in total (default 25). A large library is fully covered after several days.
- A highlight deleted on Kindle is deleted here.
- A long highlight arrives as a preview of about 100 characters. Sync asks for the full passage once and keeps it.
- Changed books are written in one commit. If the commit fails, the books stay marked and go out with the next run.

## Where secrets live

| Secret | Where |
|---|---|
| `API_SECRET`, `GITHUB_TOKEN` | Wrangler secrets on the Worker. For local dev, `.dev.vars` (git-ignored). |
| Amazon refresh token and device key | The `amazon:credentials` key in `KINDLE_KV` |
| Spike credentials | `.spike-credentials.json` (git-ignored) |

`API_SECRET` is part of the `/auth` and `/debug` addresses. Treat those addresses as passwords.

## Limits

- Purchased Kindle books only. Sideloaded documents have no text in the Cloud Reader.
- US store (`amazon.com`) only. Other stores need the constants in `src/amazon/device.ts` changed.
- Publishers cap how much of a book can be copied. Past that cap, highlights stay as previews and are marked `preview only`.

## Development

```bash
npm test          # vitest
npm run lint      # biome
npm run typecheck
npm run explore   # read-only test of other Amazon endpoints
npm run dev       # wrangler dev. Copy .dev.vars.example to .dev.vars first.
```

For `npm run dev`, apply the migration to the local database once: `npx wrangler d1 migrations apply kindle-highlights --local`.

## Credits

The device-registration flow is ported from [moifort/kindle-api-ts](https://github.com/moifort/kindle-api-ts) and the Cloud Reader client from [minholi/omakindle](https://github.com/minholi/omakindle), both MIT licensed.
